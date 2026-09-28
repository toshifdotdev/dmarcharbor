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
import { subscriptionEndAt, subscriptionMaxYears, verifyRazorpaySignature, withCustomerId } from '../src/billing/razorpay.provider.js';
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
      // Three paid tiers, two intervals each. The free tier has no provider
      // plan because there is nothing to charge.
      expect(entries).toHaveLength(6);
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
    expect(stored.priceMinor).toBe(659900);

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

    expect(report).toHaveLength(6);
    expect(report.filter((entry) => entry.status === 'missing')).toHaveLength(5);
    expect(report.find((entry) => entry.tier === 'FAIRWAY' && entry.interval === 'monthly')?.status).toBe('ready');

    await prisma.billingPlan.deleteMany();
  });
});

describe('razorpay subscription lifetime', () => {
  it('bounds the subscription by a date rather than a cycle count', () => {
    const now = new Date('2026-09-27T12:00:00.000Z');
    const endAt = subscriptionEndAt(now);

    const years = new Date(endAt * 1000).getUTCFullYear() - now.getUTCFullYear();
    expect(years).toBe(subscriptionMaxYears);
  });

  it('runs long enough that no realistic customer outlives it', () => {
    // The failure this prevents is a subscription that quietly ends when a
    // counter runs out, leaving a customer who paid without access. There is no
    // unlimited setting, because Razorpay rejects total_count of 0 and caps
    // subscriptions at 100 years, so the bound is set just inside that cap.
    expect(subscriptionMaxYears).toBeGreaterThanOrEqual(99);
    expect(subscriptionMaxYears).toBeLessThanOrEqual(100);
  });

  it('never sends a cycle count alongside the date, which Razorpay rejects', () => {
    // Razorpay returns 400 if both total_count and end_at are supplied, so the
    // create body must carry the date alone.
    const body = withCustomerId({
      plan_id: 'plan_00000000000001',
      customer_id: 'cust_1',
      end_at: subscriptionEndAt(),
      customer_notify: 1,
      notes: {},
    });

    expect('end_at' in body).toBe(true);
    expect('total_count' in (body as Record<string, unknown>)).toBe(false);
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
