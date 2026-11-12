import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import {
  BillingPlanError,
  expectedPlans,
  findStoredPlan,
  planSyncReport,
  requireStoredPlan,
  saveStoredPlan,
} from '../src/billing/plans.js';
import { verifyPaddleSignature } from '../src/billing/paddle.provider.js';
import { normalisePhone, verifyRazorpaySignature } from '../src/billing/razorpay.provider.js';
import {
  addInterval,
  defaultMandateMethod,
  isRecurringKey,
  mandateMaxFor,
  methodAllowed,
  methodOptions,
  recurringSubscriptionKey,
  subtractInterval,
  upgradeCarryOverMinor,
} from '../src/billing/recurring-terms.js';
import { SignatureVerificationError } from '../src/billing/provider.js';
import { planCatalog } from '../src/services/entitlements/plan-catalog.js';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

describe('stored provider plans', () => {
  beforeAll(resetDatabase);

  it('describes every plan the catalog sells, in both currencies', () => {
    for (const currency of ['USD', 'INR'] as const) {
      const entries = expectedPlans(currency);
      // Three paid flat tiers on two intervals, plus Fleet monthly in each of
      // its price bands. The free tier has no provider plan because there is
      // nothing to charge.
      expect(entries).toHaveLength(6 + planCatalog.FLEET.bands!.length);
      expect(entries.filter((entry) => entry.tier === 'FLEET')).toEqual(
        planCatalog.FLEET.bands!.map((band, index) => ({
          tier: 'FLEET',
          interval: 'monthly',
          band: index,
          priceMinor: band.unitMinor[currency],
        })),
      );
      expect(entries.every((entry) => entry.priceMinor > 0)).toBe(true);
    }
  });

  it('takes the price from the catalog, never from the caller', async () => {
    await expect(
      saveStoredPlan({
        provider: 'RAZORPAY',
        tier: 'HARBOR',
        interval: 'monthly',
        currency: 'INR',
        priceMinor: 1,
        providerPlanId: 'plan_wrong',
      }),
    ).rejects.toBeInstanceOf(BillingPlanError);

    expect(await prisma.billingPlan.count()).toBe(0);
  });

  it('stores a mapping and reads it back', async () => {
    const stored = await saveStoredPlan({
      provider: 'RAZORPAY',
      tier: 'HARBOR',
      interval: 'monthly',
      currency: 'INR',
      priceMinor: planCatalog.HARBOR.prices.INR.monthlyMinor,
      providerPlanId: 'plan_harbor_inr_monthly',
    });

    expect(stored.providerPlanId).toBe('plan_harbor_inr_monthly');
    // Read from the catalog rather than hardcoded, so a price change cannot leave a
    // stale figure asserting the old one.
    expect(stored.priceMinor).toBe(planCatalog.HARBOR.prices.INR.monthlyMinor);

    const found = await findStoredPlan({ provider: 'RAZORPAY', tier: 'HARBOR', interval: 'monthly', currency: 'INR' });
    expect(found?.id).toBe(stored.id);
  });

  it('is safe to re-run a sync, reusing the existing mapping', async () => {
    const first = await saveStoredPlan({
      provider: 'RAZORPAY',
      tier: 'FAIRWAY',
      interval: 'monthly',
      currency: 'INR',
      priceMinor: planCatalog.FAIRWAY.prices.INR.monthlyMinor,
      providerPlanId: 'plan_fairway_original',
    });

    // Replacing a plan id would orphan any live subscription pointing at the
    // old one, so a sync must reuse rather than recreate.
    const second = await saveStoredPlan({
      provider: 'RAZORPAY',
      tier: 'FAIRWAY',
      interval: 'monthly',
      currency: 'INR',
      priceMinor: planCatalog.FAIRWAY.prices.INR.monthlyMinor,
      providerPlanId: 'plan_fairway_recreated',
    });

    expect(second.id).toBe(first.id);
    expect(second.providerPlanId).toBe('plan_fairway_recreated');
    expect(await prisma.billingPlan.count({ where: { provider: 'RAZORPAY', tier: 'FAIRWAY' } })).toBe(1);
  });

  it('refuses to check out a plan the provider has never been told about', async () => {
    await expect(
      requireStoredPlan({ provider: 'PADDLE', tier: 'ADMIRALTY', interval: 'annual', currency: 'USD' }),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_SYNCED', status: 503 });
  });

  it('refuses to check out at a price the catalog does not advertise', async () => {
    await prisma.billingPlan.create({
      data: {
        provider: 'RAZORPAY',
        tier: 'ADMIRALTY',
        interval: 'MONTHLY',
        currency: 'INR',
        priceMinor: 100,
        providerPlanId: 'plan_stale',
        updatedAt: new Date(),
      },
    });

    // A price change in code that has not been pushed to the provider must fail
    // loudly rather than quietly billing the old amount.
    await expect(
      requireStoredPlan({ provider: 'RAZORPAY', tier: 'ADMIRALTY', interval: 'monthly', currency: 'INR' }),
    ).rejects.toMatchObject({ code: 'PLAN_PRICE_DRIFT' });

    await prisma.billingPlan.deleteMany();
  });

  it('reports which plans still need creating', async () => {
    await saveStoredPlan({
      provider: 'PADDLE',
      tier: 'FAIRWAY',
      interval: 'monthly',
      currency: 'USD',
      priceMinor: planCatalog.FAIRWAY.prices.USD.monthlyMinor,
      providerPlanId: 'pri_paddle_fairway',
    });

    const report = await planSyncReport('PADDLE', 'USD');

    expect(report).toHaveLength(6 + planCatalog.FLEET.bands!.length);
    expect(report.filter((entry) => entry.status === 'missing')).toHaveLength(5 + planCatalog.FLEET.bands!.length);
    expect(report.find((entry) => entry.tier === 'FAIRWAY' && entry.interval === 'monthly')?.status).toBe('ready');

    await prisma.billingPlan.deleteMany();
  });
});

describe('razorpay recurring terms', () => {
  it('offers UPI only up to ₹15,000 and defaults to eNACH above it', () => {
    // Harbor monthly (₹12,499) debits on its own by card or UPI.
    expect(defaultMandateMethod(1_249_900)).toBe('card');
    expect(methodAllowed('upi', 1_249_900)).toBe(true);
    // Admiralty monthly (₹33,999) needs approval each time on a card, and UPI cannot carry it.
    expect(defaultMandateMethod(3_399_900)).toBe('emandate');
    expect(methodAllowed('upi', 3_399_900)).toBe(false);
    expect(methodAllowed('card', 3_399_900)).toBe(true);
    expect(methodOptions(3_399_900).find((option) => option.method === 'card')?.note).toMatch(/approve each charge/);
  });

  it('registers a mandate for at least ₹1,00,000 or twice the charge, and UPI at ₹15,000', () => {
    expect(mandateMaxFor('card', 329_900)).toBe(10_000_000);
    expect(mandateMaxFor('emandate', 33_999_000)).toBe(67_998_000);
    expect(mandateMaxFor('upi', 329_900)).toBe(1_500_000);
  });

  it('adds a month by calendar day, clamped to the shorter month, and a year for annual', () => {
    expect(addInterval(new Date('2026-01-31T10:00:00Z'), 'monthly').toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addInterval(new Date('2026-11-12T10:00:00Z'), 'monthly').toISOString()).toBe('2026-12-12T10:00:00.000Z');
    expect(addInterval(new Date('2026-11-12T10:00:00Z'), 'annual').toISOString()).toBe('2027-11-12T10:00:00.000Z');
    expect(subtractInterval(new Date('2026-12-12T10:00:00Z'), 'monthly').toISOString()).toBe('2026-11-12T10:00:00.000Z');
  });

  it('owes the price difference for the rest of the period on an upgrade, and nothing on a downgrade', () => {
    const periodStart = new Date('2026-11-01T00:00:00Z');
    const periodEnd = new Date('2026-12-01T00:00:00Z');
    const halfway = new Date('2026-11-16T00:00:00Z');
    // Fairway (₹3,299) to Harbor (₹12,499), half the period left: half of ₹9,200.
    expect(upgradeCarryOverMinor({ fromMinor: 329_900, toMinor: 1_249_900, periodStart, periodEnd, now: halfway })).toBe(460_000);
    expect(upgradeCarryOverMinor({ fromMinor: 1_249_900, toMinor: 329_900, periodStart, periodEnd, now: halfway })).toBe(0);
    expect(upgradeCarryOverMinor({ fromMinor: 329_900, toMinor: 1_249_900, periodStart, periodEnd, now: periodEnd })).toBe(0);
  });

  it('tells a recurring subscription from a Razorpay Subscription by its id', () => {
    expect(isRecurringKey(recurringSubscriptionKey('order_ABC'))).toBe(true);
    expect(isRecurringKey('sub_TyQprHlKWBa70P')).toBe(false);
    expect(normalisePhone('98190 12345')).toBe('+919819012345');
    expect(normalisePhone('+91-9819012345')).toBe('+919819012345');
    expect(normalisePhone('12345')).toBeNull();
  });
});

describe('webhook signature verification', () => {
  it('accepts a Razorpay signature over the exact body', () => {
    const secret = 'whsec_test_razorpay';
    const body = JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_1' } } } });
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    expect(() => verifyRazorpaySignature(body, signature, secret)).not.toThrow();
  });

  it('rejects a Razorpay signature that does not match', () => {
    const secret = 'whsec_test_razorpay';
    const body = '{"event":"subscription.activated"}';

    expect(() => verifyRazorpaySignature(body, 'deadbeef', secret)).toThrow(SignatureVerificationError);
    expect(() => verifyRazorpaySignature(body, undefined, secret)).toThrow(SignatureVerificationError);
  });

  it('rejects a body edited after signing, which is the whole point', () => {
    const secret = 'whsec_test_razorpay';
    const original = JSON.stringify({ event: 'subscription.activated', plan: 'FAIRWAY' });
    const signature = createHmac('sha256', secret).update(original).digest('hex');

    // An attacker who upgrades their own plan and reuses a captured signature.
    const tampered = JSON.stringify({ event: 'subscription.activated', plan: 'ADMIRALTY' });
    expect(() => verifyRazorpaySignature(tampered, signature, secret)).toThrow(SignatureVerificationError);
  });

  it('accepts a Paddle timestamped signature', async () => {
    const secret = 'pdl_test_secret';
    const body = JSON.stringify({ event_id: 'evt_1', event_type: 'subscription.activated' });
    const ts = String(Math.floor(Date.now() / 1000));
    const h1 = createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');

    await expect(verifyPaddleSignature(body, `ts=${ts};h1=${h1}`, secret)).resolves.toBeUndefined();
  });

  it('rejects a Paddle signature outside the tolerance window', async () => {
    const secret = 'pdl_test_secret';
    const body = '{"event_id":"evt_1"}';
    // An hour old, which is well beyond the SDK's accepted window.
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    const h1 = createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');

    // Cryptographically valid, but too old to trust. Without the timestamp
    // check this would be replayable forever.
    await expect(verifyPaddleSignature(body, `ts=${ts};h1=${h1}`, secret)).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it('rejects a malformed or forged Paddle header', async () => {
    const secret = 'pdl_test_secret';
    const body = '{"event_id":"evt_1"}';

    await expect(verifyPaddleSignature(body, undefined, secret)).rejects.toBeInstanceOf(SignatureVerificationError);
    await expect(verifyPaddleSignature(body, 'nonsense', secret)).rejects.toBeInstanceOf(SignatureVerificationError);
    await expect(verifyPaddleSignature(body, 'ts=abc;h1=deadbeef', secret)).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it('rejects a Paddle body edited after signing', async () => {
    const secret = 'pdl_test_secret';
    const original = JSON.stringify({ event_type: 'subscription.activated', plan: 'FAIRWAY' });
    const ts = String(Math.floor(Date.now() / 1000));
    const h1 = createHmac('sha256', secret).update(`${ts}:${original}`).digest('hex');

    const tampered = JSON.stringify({ event_type: 'subscription.activated', plan: 'ADMIRALTY' });
    await expect(verifyPaddleSignature(tampered, `ts=${ts};h1=${h1}`, secret)).rejects.toBeInstanceOf(SignatureVerificationError);
  });
});
