import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertDodoConfig, env } from '../src/config/env.js';
import {
  dodoAllowedForWorkspace,
  dodoPaidThrough,
  dodoQuantityRange,
  dodoQuantityUpdateBody,
  dodoTestWorkspaceIds,
  verifyDodoSignature,
} from '../src/billing/dodo.provider.js';
import { resolveProviderForCheckout } from '../src/billing/registry.js';
import {
  checkoutAttribution,
  checkoutAttributionMatches,
  dodoAttribution,
  dodoAttributionMatches,
  paddleAttribution,
  paddleAttributionMatches,
} from '../src/billing/paddle-attribution.js';
import { BillingProviderError, SignatureVerificationError } from '../src/billing/provider.js';
import { dodoEventMap, dodoStatusMap } from '../src/billing/webhook.service.js';
import { bandIndexFor, perDomainBill, planCatalog } from '../src/services/entitlements/plan-catalog.js';
import {
  buildDodoDisputeWebhookFixture,
  buildDodoPaymentWebhookFixture,
  buildDodoProductFixture,
  buildDodoRefundWebhookFixture,
  buildDodoSubscriptionWebhookFixture,
} from './fixtures/dodo-webhooks.js';

const FAKE_SECRET_RAW = Buffer.from('dodo-unit-test-fake-webhook-secret-32b').toString('base64');
const FAKE_SECRET = `whsec_${FAKE_SECRET_RAW}`;

function signStandardWebhook(
  webhookId: string,
  timestampSeconds: number,
  body: string,
  base64Key = FAKE_SECRET_RAW,
): string {
  const key = Buffer.from(base64Key, 'base64');
  const digest = createHmac('sha256', key)
    .update(`${webhookId}.${timestampSeconds}.${body}`)
    .digest('base64');
  return `v1,${digest}`;
}

describe('Dodo configuration boot guard (assertDodoConfig)', () => {
  it('allows all Dodo variables to be omitted', () => {
    expect(() => assertDodoConfig({})).not.toThrow();
  });

  it('refuses DODO_API_KEY without DODO_WEBHOOK_SECRET and vice versa', () => {
    expect(() =>
      assertDodoConfig({ apiKey: 'dodo_test_fake', environment: 'test_mode' }),
    ).toThrow(/DODO_API_KEY and DODO_WEBHOOK_SECRET must be configured together/);

    expect(() =>
      assertDodoConfig({ webhookSecret: FAKE_SECRET, environment: 'test_mode' }),
    ).toThrow(/DODO_API_KEY and DODO_WEBHOOK_SECRET must be configured together/);
  });

  it('refuses DODO_API_KEY and DODO_WEBHOOK_SECRET when DODO_ENVIRONMENT is missing', () => {
    expect(() =>
      assertDodoConfig({ apiKey: 'dodo_test_fake', webhookSecret: FAKE_SECRET }),
    ).toThrow(/DODO_ENVIRONMENT \(test_mode or live_mode\) must be set/);
  });

  it('accepts test_mode and live_mode when key and secret are both set', () => {
    expect(() =>
      assertDodoConfig({
        apiKey: 'dodo_test_fake',
        webhookSecret: FAKE_SECRET,
        environment: 'test_mode',
      }),
    ).not.toThrow();

    expect(() =>
      assertDodoConfig({
        apiKey: 'dodo_live_fake',
        webhookSecret: FAKE_SECRET,
        environment: 'live_mode',
      }),
    ).not.toThrow();
  });
});

describe('verifyDodoSignature (Standard Webhooks)', () => {
  const now = new Date('2026-11-16T12:00:00.000Z');
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const webhookId = 'msg_2p9xK3nL8vR1qW5zY7mJ';
  const rawBody = JSON.stringify({
    business_id: 'bus_fake_123',
    type: 'subscription.active',
    timestamp: '2026-11-16T12:00:00.000Z',
    data: { subscription_id: 'sub_fake_123', status: 'active' },
  });

  it('accepts a valid v1 signature with a whsec_ prefixed secret', async () => {
    const sig = signStandardWebhook(webhookId, nowSeconds, rawBody);
    await expect(
      verifyDodoSignature(
        rawBody,
        {
          webhookId,
          webhookTimestamp: String(nowSeconds),
          webhookSignature: sig,
        },
        FAKE_SECRET,
        now,
      ),
    ).resolves.toBeUndefined();
  });

  it('accepts a valid v1 signature when the secret has no whsec_ prefix', async () => {
    const sig = signStandardWebhook(webhookId, nowSeconds, rawBody);
    await expect(
      verifyDodoSignature(
        rawBody,
        {
          webhookId,
          webhookTimestamp: String(nowSeconds),
          webhookSignature: sig,
        },
        FAKE_SECRET_RAW,
        now,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a tampered body', async () => {
    const sig = signStandardWebhook(webhookId, nowSeconds, rawBody);
    const tamperedBody = rawBody.replace('sub_fake_123', 'sub_fake_999');

    await expect(
      verifyDodoSignature(
        tamperedBody,
        {
          webhookId,
          webhookTimestamp: String(nowSeconds),
          webhookSignature: sig,
        },
        FAKE_SECRET,
        now,
      ),
    ).rejects.toThrow(SignatureVerificationError);
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const otherSecretRaw = Buffer.from('another-completely-different-secret-key').toString('base64');
    const sig = signStandardWebhook(webhookId, nowSeconds, rawBody, otherSecretRaw);

    await expect(
      verifyDodoSignature(
        rawBody,
        {
          webhookId,
          webhookTimestamp: String(nowSeconds),
          webhookSignature: sig,
        },
        FAKE_SECRET,
        now,
      ),
    ).rejects.toThrow(SignatureVerificationError);
  });

  it('rejects a timestamp older than 5 minutes or more than 5 minutes in the future', async () => {
    const oldTimestamp = nowSeconds - 301;
    const oldSig = signStandardWebhook(webhookId, oldTimestamp, rawBody);

    await expect(
      verifyDodoSignature(
        rawBody,
        {
          webhookId,
          webhookTimestamp: String(oldTimestamp),
          webhookSignature: oldSig,
        },
        FAKE_SECRET,
        now,
      ),
    ).rejects.toThrow(/too old to trust/);

    const futureTimestamp = nowSeconds + 301;
    const futureSig = signStandardWebhook(webhookId, futureTimestamp, rawBody);

    await expect(
      verifyDodoSignature(
        rawBody,
        {
          webhookId,
          webhookTimestamp: String(futureTimestamp),
          webhookSignature: futureSig,
        },
        FAKE_SECRET,
        now,
      ),
    ).rejects.toThrow(/too old to trust/);
  });

  it('accepts a header carrying several space-delimited signatures when one matches', async () => {
    const rotatedOldKey = Buffer.from('rotated-previous-webhook-secret-key-00').toString('base64');
    const oldSig = signStandardWebhook(webhookId, nowSeconds, rawBody, rotatedOldKey);
    const validSig = signStandardWebhook(webhookId, nowSeconds, rawBody, FAKE_SECRET_RAW);

    await expect(
      verifyDodoSignature(
        rawBody,
        {
          webhookId,
          webhookTimestamp: String(nowSeconds),
          webhookSignature: `${oldSig} ${validSig}`,
        },
        FAKE_SECRET,
        now,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects missing or malformed headers', async () => {
    const validSig = signStandardWebhook(webhookId, nowSeconds, rawBody);

    await expect(
      verifyDodoSignature(
        rawBody,
        { webhookId: undefined, webhookTimestamp: String(nowSeconds), webhookSignature: validSig },
        FAKE_SECRET,
        now,
      ),
    ).rejects.toThrow(/missing required Standard Webhooks headers/);

    await expect(
      verifyDodoSignature(
        rawBody,
        { webhookId, webhookTimestamp: 'not-a-timestamp', webhookSignature: validSig },
        FAKE_SECRET,
        now,
      ),
    ).rejects.toThrow(/timestamp was not a number/);

    await expect(
      verifyDodoSignature(
        rawBody,
        { webhookId, webhookTimestamp: String(nowSeconds), webhookSignature: 'v2,abcdef' },
        FAKE_SECRET,
        now,
      ),
    ).rejects.toThrow(/malformed/);

    await expect(
      verifyDodoSignature(
        rawBody,
        { webhookId, webhookTimestamp: String(nowSeconds), webhookSignature: 'malformed_no_comma' },
        FAKE_SECRET,
        now,
      ),
    ).rejects.toThrow(/malformed/);
  });
});

describe('Dodo event mapping and paid-through calculation', () => {
  it('maps Dodo subscription and payment events onto internal BillingEventType values', () => {
    expect(dodoEventMap['subscription.active']).toBe('subscription.activated');
    expect(dodoEventMap['subscription.renewed']).toBe('subscription.updated');
    expect(dodoEventMap['subscription.plan_changed']).toBe('subscription.updated');
    expect(dodoEventMap['subscription.updated']).toBe('subscription.updated');
    expect(dodoEventMap['subscription.unpaused']).toBe('subscription.activated');
    expect(dodoEventMap['subscription.past_due']).toBe('subscription.past_due');
    expect(dodoEventMap['subscription.on_hold']).toBe('subscription.past_due');
    expect(dodoEventMap['subscription.paused']).toBe('subscription.past_due');
    expect(dodoEventMap['subscription.failed']).toBe('subscription.past_due');
    expect(dodoEventMap['subscription.cancelled']).toBe('subscription.cancelled');
    expect(dodoEventMap['subscription.expired']).toBe('subscription.expired');
    expect(dodoEventMap['payment.succeeded']).toBe('checkout.completed');
    expect(dodoEventMap['payment.failed']).toBe('payment.failed');

    // Events that move no subscription money are unmapped.
    expect(dodoEventMap['payment.processing']).toBeUndefined();
    expect(dodoEventMap['payment.cancelled']).toBeUndefined();
    expect(dodoEventMap['subscription.update_payment_method']).toBeUndefined();
  });

  it('maps Dodo subscription statuses conservatively so unpaid states never map to active', () => {
    expect(dodoStatusMap.active).toBe('active');
    expect(dodoStatusMap.past_due).toBe('past_due');
    expect(dodoStatusMap.on_hold).toBe('past_due');
    expect(dodoStatusMap.paused).toBe('past_due');
    expect(dodoStatusMap.failed).toBe('past_due');
    expect(dodoStatusMap.pending).toBe('past_due');
    expect(dodoStatusMap.cancelled).toBe('cancelled');
    expect(dodoStatusMap.expired).toBe('expired');
  });

  it('computes paid-through dates for active, period-end cancelled, and immediately cancelled subscriptions', () => {
    const nextBilling = '2026-12-16T00:00:00.000Z';
    const cancelledAt = '2026-11-16T12:00:00.000Z';

    // Active subscription is paid through next_billing_date.
    expect(dodoPaidThrough('active', nextBilling, null, false)).toBe(nextBilling);

    // Scheduled cancellation at period end keeps next_billing_date.
    expect(dodoPaidThrough('active', nextBilling, cancelledAt, true)).toBe(nextBilling);

    // Immediate cancellation uses cancelled_at so access ends immediately.
    expect(dodoPaidThrough('cancelled', nextBilling, cancelledAt, false)).toBe(cancelledAt);
  });
});

describe('checkout attribution', () => {
  it('signs and verifies workspace attribution per provider', () => {
    const orgId = 'org_attribution_test_1';
    const dodoToken = dodoAttribution(orgId);
    const paddleToken = paddleAttribution(orgId);

    expect(dodoAttributionMatches(orgId, dodoToken)).toBe(true);
    expect(paddleAttributionMatches(orgId, paddleToken)).toBe(true);
    expect(checkoutAttributionMatches(orgId, checkoutAttribution(orgId, 'DODO'), 'DODO')).toBe(true);

    // Forged workspace id or empty token is rejected.
    expect(dodoAttributionMatches('org_other_workspace', dodoToken)).toBe(false);
    expect(dodoAttributionMatches(orgId, '')).toBe(false);
    expect(dodoAttributionMatches(orgId, null)).toBe(false);

    // Domain-separated: a Paddle token is rejected on a Dodo webhook and vice versa.
    expect(dodoAttributionMatches(orgId, paddleToken)).toBe(false);
    expect(paddleAttributionMatches(orgId, dodoToken)).toBe(false);
  });
});

describe('Dodo quantity range, update payload and Fleet band selection', () => {
  it('restricts flat plans to quantity 1 and Fleet to 1..5000', () => {
    expect(dodoQuantityRange('FAIRWAY')).toEqual({ minimum: 1, maximum: 1 });
    expect(dodoQuantityRange('HARBOR')).toEqual({ minimum: 1, maximum: 1 });
    expect(dodoQuantityRange('ADMIRALTY')).toEqual({ minimum: 1, maximum: 1 });
    expect(dodoQuantityRange('FLEET')).toEqual({
      minimum: 1,
      maximum: planCatalog.FLEET.maxActiveDomains,
    });
  });

  it('builds a do_not_bill changePlan payload for pre-renewal quantity sync', () => {
    expect(dodoQuantityUpdateBody('pdt_fleet_band_1', 350)).toEqual({
      product_id: 'pdt_fleet_band_1',
      quantity: 350,
      proration_billing_mode: 'do_not_bill',
    });
  });

  it('selects the right Fleet band and minimum across volume thresholds', () => {
    expect(bandIndexFor('FLEET', 50)).toBe(0);
    expect(perDomainBill('FLEET', 50, 'USD')).toEqual({
      band: 0,
      minimum: 75,
      quantity: 75,
      unitMinor: 200,
      totalMinor: 15000,
    });

    expect(bandIndexFor('FLEET', 250)).toBe(1);
    expect(perDomainBill('FLEET', 250, 'USD')).toEqual({
      band: 1,
      minimum: 320,
      quantity: 320,
      unitMinor: 125,
      totalMinor: 40000,
    });

    expect(bandIndexFor('FLEET', 800)).toBe(2);
    expect(perDomainBill('FLEET', 800, 'USD')).toEqual({
      band: 2,
      minimum: 625,
      quantity: 800,
      unitMinor: 100,
      totalMinor: 80000,
    });

    expect(bandIndexFor('FLEET', 3000)).toBe(3);
    expect(perDomainBill('FLEET', 3000, 'USD')).toEqual({
      band: 3,
      minimum: 2667,
      quantity: 3000,
      unitMinor: 75,
      totalMinor: 225000,
    });
  });
});

describe('Dodo test-mode workspace allowlist (DODO_TEST_WORKSPACE_IDS)', () => {
  it('allows USD checkout only for workspaces listed in DODO_TEST_WORKSPACE_IDS when in test_mode, and ignores the list in live_mode', () => {
    const mutableEnv = env as Record<string, unknown>;
    const prevKey = mutableEnv.DODO_API_KEY;
    const prevSecret = mutableEnv.DODO_WEBHOOK_SECRET;
    const prevMode = mutableEnv.DODO_ENVIRONMENT;
    const prevIds = mutableEnv.DODO_TEST_WORKSPACE_IDS;

    try {
      mutableEnv.DODO_API_KEY = 'dodo_test_fake_key';
      mutableEnv.DODO_WEBHOOK_SECRET = FAKE_SECRET;
      mutableEnv.DODO_ENVIRONMENT = 'test_mode';
      mutableEnv.DODO_TEST_WORKSPACE_IDS = ' ws_reviewer_1 , ws_reviewer_2 , ';

      expect([...dodoTestWorkspaceIds()]).toEqual(['ws_reviewer_1', 'ws_reviewer_2']);

      // In test_mode: anonymous visitors and non-listed workspaces are refused.
      expect(dodoAllowedForWorkspace()).toBe(false);
      expect(dodoAllowedForWorkspace(null)).toBe(false);
      expect(dodoAllowedForWorkspace('ws_stranger')).toBe(false);
      expect(() =>
        resolveProviderForCheckout({ currency: 'USD', organizationId: 'ws_stranger' }),
      ).toThrow(BillingProviderError);

      // In test_mode: listed workspaces are permitted.
      expect(dodoAllowedForWorkspace('ws_reviewer_1')).toBe(true);
      expect(dodoAllowedForWorkspace('ws_reviewer_2')).toBe(true);
      expect(resolveProviderForCheckout({ currency: 'USD', organizationId: 'ws_reviewer_1' }).name).toBe('DODO');

      // In test_mode with empty allowlist: nobody is permitted.
      mutableEnv.DODO_TEST_WORKSPACE_IDS = '';
      expect(dodoAllowedForWorkspace('ws_reviewer_1')).toBe(false);

      // In live_mode: DODO_TEST_WORKSPACE_IDS is ignored and everyone is permitted.
      mutableEnv.DODO_ENVIRONMENT = 'live_mode';
      mutableEnv.DODO_TEST_WORKSPACE_IDS = 'ws_reviewer_1';
      expect(dodoAllowedForWorkspace()).toBe(true);
      expect(dodoAllowedForWorkspace(null)).toBe(true);
      expect(dodoAllowedForWorkspace('ws_stranger')).toBe(true);
      expect(resolveProviderForCheckout({ currency: 'USD', organizationId: 'ws_stranger' }).name).toBe('DODO');

      // Unconfigured: always false.
      mutableEnv.DODO_API_KEY = undefined;
      mutableEnv.DODO_WEBHOOK_SECRET = undefined;
      mutableEnv.DODO_ENVIRONMENT = undefined;
      expect(dodoAllowedForWorkspace('ws_reviewer_1')).toBe(false);
    } finally {
      mutableEnv.DODO_API_KEY = prevKey;
      mutableEnv.DODO_WEBHOOK_SECRET = prevSecret;
      mutableEnv.DODO_ENVIRONMENT = prevMode;
      mutableEnv.DODO_TEST_WORKSPACE_IDS = prevIds;
    }
  });
});

describe('Dodo Test Mode API & Webhook fixtures', () => {
  it('constructs field-complete sanitized Dodo product and webhook payloads and verifies signatures over them', async () => {
    const product = buildDodoProductFixture({ productId: 'pdt_fixture_1', priceMinor: 14900 });
    expect(product.product_id).toBe('pdt_fixture_1');
    expect(product.tax_category).toBe('saas');
    expect(product.price.type).toBe('recurring_price');

    const subEvent = buildDodoSubscriptionWebhookFixture({
      type: 'subscription.active',
      subscriptionId: 'sub_fixture_1',
      productId: 'pdt_fixture_1',
    });
    const payEvent = buildDodoPaymentWebhookFixture({
      type: 'payment.succeeded',
      paymentId: 'pay_fixture_1',
      subscriptionId: 'sub_fixture_1',
    });
    const refundEvent = buildDodoRefundWebhookFixture({
      type: 'refund.succeeded',
      refundId: 'ref_fixture_1',
      paymentId: 'pay_fixture_1',
    });
    const disputeEvent = buildDodoDisputeWebhookFixture({
      type: 'dispute.opened',
      disputeId: 'dis_fixture_1',
      paymentId: 'pay_fixture_1',
    });

    // Dispute webhook payloads have no customer or subscription_id field in Dodo's schema.
    expect(disputeEvent.data).not.toHaveProperty('customer');
    expect(disputeEvent.data).not.toHaveProperty('subscription_id');
    expect(disputeEvent.data.payment_id).toBe('pay_fixture_1');

    const now = new Date('2026-11-16T20:15:00.000Z');
    const ts = Math.floor(now.getTime() / 1000);
    for (const [idx, payload] of [subEvent, payEvent, refundEvent, disputeEvent].entries()) {
      const rawBody = JSON.stringify(payload);
      const id = `msg_fixture_${idx}`;
      const sig = signStandardWebhook(id, ts, rawBody);
      await expect(
        verifyDodoSignature(
          rawBody,
          { webhookId: id, webhookTimestamp: String(ts), webhookSignature: sig },
          FAKE_SECRET,
          now,
        ),
      ).resolves.toBeUndefined();
    }
  });
});
