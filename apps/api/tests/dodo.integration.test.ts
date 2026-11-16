import { createHmac } from 'node:crypto';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dodoMocks = vi.hoisted(() => {
  const customersList = vi.fn();
  const customersCreate = vi.fn();
  const customerPortalCreate = vi.fn();
  const checkoutSessionsCreate = vi.fn();
  const subscriptionsRetrieve = vi.fn();
  const subscriptionsUpdate = vi.fn();
  const subscriptionsChangePlan = vi.fn();
  const subscriptionsPreviewChangePlan = vi.fn();
  const paymentsList = vi.fn();
  const refundsCreate = vi.fn();
  const productsCreate = vi.fn();

  class MockAPIError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'APIError';
      this.status = status;
    }
  }

  class MockDodoPayments {
    customers = {
      list: customersList,
      create: customersCreate,
      customerPortal: {
        create: customerPortalCreate,
      },
    };
    checkoutSessions = {
      create: checkoutSessionsCreate,
    };
    subscriptions = {
      retrieve: subscriptionsRetrieve,
      update: subscriptionsUpdate,
      changePlan: subscriptionsChangePlan,
      previewChangePlan: subscriptionsPreviewChangePlan,
    };
    payments = {
      list: paymentsList,
    };
    refunds = {
      create: refundsCreate,
    };
    products = {
      create: productsCreate,
    };
  }

  return {
    customersList,
    customersCreate,
    customerPortalCreate,
    checkoutSessionsCreate,
    subscriptionsRetrieve,
    subscriptionsUpdate,
    subscriptionsChangePlan,
    subscriptionsPreviewChangePlan,
    paymentsList,
    refundsCreate,
    productsCreate,
    MockAPIError,
    MockDodoPayments,
  };
});

vi.mock('dodopayments', () => ({
  default: dodoMocks.MockDodoPayments,
  DodoPayments: dodoMocks.MockDodoPayments,
  APIError: dodoMocks.MockAPIError,
}));

import { env } from '../src/config/env.js';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { dodoAttribution } from '../src/billing/paddle-attribution.js';
import { expectedPlans, saveStoredPlan } from '../src/billing/plans.js';
import { providerForCurrency, providerReady, resolveProviderForCheckout } from '../src/billing/registry.js';
import { runDunning, runReconciliation } from '../src/billing/dunning.js';
import { syncPerDomainQuantities } from '../src/billing/quantity.js';

const FAKE_DODO_SECRET_RAW = Buffer.from('dodo-integration-fake-webhook-secret-key').toString('base64');
const FAKE_DODO_SECRET = `whsec_${FAKE_DODO_SECRET_RAW}`;
const FAKE_STAFF_KEY = 'staff-key-for-dodo-integration-tests-only-000000';
const password = 'correct-horse-battery-staple';
let fixtureId = 0;

function signDodoWebhook(webhookId: string, body: string, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(FAKE_DODO_SECRET_RAW, 'base64');
  const sig = createHmac('sha256', key)
    .update(`${webhookId}.${timestampSeconds}.${body}`)
    .digest('base64');
  return {
    'webhook-id': webhookId,
    'webhook-timestamp': String(timestampSeconds),
    'webhook-signature': `v1,${sig}`,
  };
}

function asyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    },
  };
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "refund_record", "billing_charge", "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function seedDodoUsdPlans(): Promise<void> {
  for (const entry of expectedPlans('USD')) {
    const suffix = entry.tier === 'FLEET' ? `_band_${entry.band}` : `_${entry.interval}`;
    await saveStoredPlan({
      provider: 'DODO',
      tier: entry.tier,
      interval: entry.interval,
      currency: 'USD',
      band: entry.band,
      priceMinor: entry.priceMinor,
      providerPlanId: `pdt_dodo_${entry.tier.toLowerCase()}${suffix}`,
    });
  }
}

async function createWorkspace(label: string): Promise<{
  agent: ReturnType<typeof request.agent>;
  organizationId: string;
  email: string;
}> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `dodo-${label}-${Date.now()}-${fixtureId}@example.com`;

  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'MSP Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const created = await agent.post('/api/workspaces').send({
    name: `Dodo Workspace ${fixtureId}`,
    slug: `dodo-ws-${label}-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status).toBe(201);

  return { agent, organizationId: created.body.id as string, email };
}

describe('Dodo Payments integration', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();

    const mutableEnv = env as Record<string, unknown>;
    mutableEnv.DODO_API_KEY = 'dodo_test_fake_api_key';
    mutableEnv.DODO_WEBHOOK_SECRET = FAKE_DODO_SECRET;
    mutableEnv.DODO_ENVIRONMENT = 'test_mode';
    mutableEnv.PADDLE_API_KEY = undefined;
    mutableEnv.PADDLE_WEBHOOK_SECRET = undefined;
    mutableEnv.STAFF_API_KEY = FAKE_STAFF_KEY;

    let productSeq = 0;
    dodoMocks.productsCreate.mockImplementation(async (params: { metadata?: Record<string, string> }) => {
      productSeq += 1;
      return {
        product_id: `pdt_synced_${params.metadata?.tier?.toLowerCase() ?? 'plan'}_${productSeq}`,
      };
    });

    dodoMocks.customersList.mockImplementation(() => asyncIterable([]));
    dodoMocks.customersCreate.mockImplementation(async (params: { email: string; name: string }) => ({
      customer_id: `cus_dodo_${fixtureId}`,
      email: params.email,
      name: params.name,
    }));
    dodoMocks.checkoutSessionsCreate.mockImplementation(async () => ({
      session_id: `cks_dodo_${fixtureId}`,
      checkout_url: `https://test.checkout.dodopayments.com/session/cks_dodo_${fixtureId}`,
    }));
    dodoMocks.customerPortalCreate.mockImplementation(async () => ({
      link: `https://test.customer.dodopayments.com/session/cps_${fixtureId}`,
    }));
    dodoMocks.subscriptionsUpdate.mockResolvedValue({ subscription_id: `sub_dodo_${fixtureId}` });
    dodoMocks.subscriptionsChangePlan.mockResolvedValue({});
  });

  describe('currency routing, provider readiness, and staff plan sync', () => {
    it('routes USD to DODO when configured, falls back to PADDLE when unconfigured, and keeps existing PADDLE subscriptions on PADDLE', async () => {
      const mutableEnv = env as Record<string, unknown>;

      expect(providerForCurrency('USD')).toBe('DODO');
      expect(providerForCurrency('INR')).toBe('RAZORPAY');

      // Existing PADDLE subscriber stays on PADDLE even while DODO is configured.
      mutableEnv.PADDLE_API_KEY = 'pdl_fake_key';
      mutableEnv.PADDLE_WEBHOOK_SECRET = 'pdl_fake_secret';
      const sticky = resolveProviderForCheckout({ currency: 'USD', existingProvider: 'PADDLE' });
      expect(sticky.name).toBe('PADDLE');

      // When DODO is unconfigured, USD falls back to PADDLE.
      mutableEnv.DODO_API_KEY = undefined;
      mutableEnv.DODO_WEBHOOK_SECRET = undefined;
      mutableEnv.DODO_ENVIRONMENT = undefined;
      expect(providerForCurrency('USD')).toBe('PADDLE');
    });

    it('advertises USD in /api/capabilities only after every expected USD plan is stored for DODO, and syncs them via POST /api/billing/plan-sync', async () => {
      // Configured, but no plans stored yet -> providerReady('DODO') is false and capabilities excludes USD.
      expect(await providerReady('DODO')).toBe(false);
      const beforeSync = await request(app).get('/api/capabilities');
      expect(beforeSync.status).toBe(200);
      expect(beforeSync.body.currencies).not.toContain('USD');
      expect(beforeSync.body.providers.dodo).toBe(false);

      // Staff route syncs all expected USD plans into Dodo and stores them in billing_plan.
      const syncRes = await request(app)
        .post('/api/billing/plan-sync?provider=DODO&currency=USD')
        .set('Authorization', `Bearer ${FAKE_STAFF_KEY}`);

      expect(syncRes.status).toBe(200);
      expect(syncRes.body.provider).toBe('DODO');
      expect(syncRes.body.currency).toBe('USD');
      expect(syncRes.body.created).toBe(expectedPlans('USD').length);
      expect(syncRes.body.reused).toBe(0);
      expect(syncRes.body.plans.every((p: { status: string }) => p.status === 'ready')).toBe(true);
      expect(dodoMocks.productsCreate).toHaveBeenCalledTimes(expectedPlans('USD').length);
      expect(dodoMocks.productsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tax_category: 'saas',
          price: expect.objectContaining({
            type: 'recurring_price',
            currency: 'USD',
            subscription_period_count: 20,
            subscription_period_interval: 'Year',
          }),
        }),
      );

      // Re-running is idempotent: 0 created, all reused.
      const rerunRes = await request(app)
        .post('/api/billing/plan-sync?provider=DODO&currency=USD')
        .set('Authorization', `Bearer ${FAKE_STAFF_KEY}`);
      expect(rerunRes.status).toBe(200);
      expect(rerunRes.body.created).toBe(0);
      expect(rerunRes.body.reused).toBe(expectedPlans('USD').length);

      // Now providerReady('DODO') is true and /api/capabilities lists USD.
      expect(await providerReady('DODO')).toBe(true);
      const afterSync = await request(app).get('/api/capabilities');
      expect(afterSync.status).toBe(200);
      expect(afterSync.body.currencies).toContain('USD');
      expect(afterSync.body.providers.dodo).toBe(true);
    });
  });

  describe('checkout, webhook activation, renewal, portal, cancel/resume, and immediate cancel', () => {
    it('creates a Dodo checkout session, activates on subscription.active, renews, opens portal, cancels at period end, resumes, and cancels immediately', async () => {
      await seedDodoUsdPlans();
      const { agent, organizationId, email } = await createWorkspace('lifecycle');

      await agent.patch(`/api/workspaces/${organizationId}/billing/currency`).send({ currency: 'USD' });

      const checkout = await agent.post(`/api/workspaces/${organizationId}/billing/checkout`).send({
        plan: 'HARBOR',
        interval: 'monthly',
        currency: 'USD',
        contact: { name: 'MSP Owner', email },
      });

      expect(checkout.status).toBe(201);
      expect(checkout.body.provider).toBe('DODO');
      expect(checkout.body.url).toContain('https://test.checkout.dodopayments.com/session/');
      expect(dodoMocks.checkoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          product_cart: [{ product_id: 'pdt_dodo_harbor_monthly', quantity: 1 }],
          billing_currency: 'USD',
          return_url: expect.stringContaining('/billing?checkout=complete'),
          metadata: expect.objectContaining({
            organizationId,
            attribution: dodoAttribution(organizationId),
            planTier: 'HARBOR',
          }),
        }),
      );

      // Plan is still MOORING before the webhook arrives.
      const beforeWebhook = await agent.get(`/api/workspaces/${organizationId}/billing`);
      expect(beforeWebhook.body.plan).toBe('MOORING');

      // Send subscription.active webhook.
      const period1End = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const activePayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.active',
        timestamp: new Date().toISOString(),
        data: {
          subscription_id: 'sub_dodo_lifecycle_1',
          product_id: 'pdt_dodo_harbor_monthly',
          customer: { customer_id: 'cus_dodo_lifecycle_1', email, name: 'MSP Owner' },
          currency: 'USD',
          status: 'active',
          quantity: 1,
          cancel_at_next_billing_date: false,
          next_billing_date: period1End,
          metadata: {
            organizationId,
            attribution: dodoAttribution(organizationId),
          },
        },
      });

      const activeRes = await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_active_1', activePayload))
        .send(activePayload);

      expect(activeRes.status).toBe(200);
      expect(activeRes.body).toMatchObject({
        accepted: true,
        duplicate: false,
        type: 'subscription.activated',
        organizationId,
      });

      const afterActive = await agent.get(`/api/workspaces/${organizationId}/billing`);
      expect(afterActive.body.plan).toBe('HARBOR');
      expect(afterActive.body.provider).toBe('DODO');
      expect(afterActive.body.status).toBe('ACTIVE');
      expect(afterActive.body.currentPeriodEnd).toBe(period1End);

      // Open customer billing portal.
      const portalRes = await agent.post(`/api/workspaces/${organizationId}/billing/portal`).send({});
      expect(portalRes.status).toBe(200);
      expect(portalRes.body.url).toContain('https://test.customer.dodopayments.com/session/');
      expect(dodoMocks.customerPortalCreate).toHaveBeenCalledWith(
        'cus_dodo_lifecycle_1',
        expect.objectContaining({
          return_url: expect.stringContaining('/billing'),
          send_email: false,
        }),
      );

      // Renewal webhook advances currentPeriodEnd.
      const period2End = new Date(Date.now() + 60 * 86_400_000).toISOString();
      const renewedPayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.renewed',
        timestamp: new Date(Date.now() + 1000).toISOString(),
        data: {
          subscription_id: 'sub_dodo_lifecycle_1',
          product_id: 'pdt_dodo_harbor_monthly',
          customer: { customer_id: 'cus_dodo_lifecycle_1', email, name: 'MSP Owner' },
          currency: 'USD',
          status: 'active',
          quantity: 1,
          cancel_at_next_billing_date: false,
          next_billing_date: period2End,
        },
      });

      const renewedRes = await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_renew_1', renewedPayload))
        .send(renewedPayload);
      expect(renewedRes.status).toBe(200);
      expect(renewedRes.body.accepted).toBe(true);

      const afterRenew = await agent.get(`/api/workspaces/${organizationId}/billing`);
      expect(afterRenew.body.currentPeriodEnd).toBe(period2End);

      // Cancel at period end: keeps HARBOR until period2End.
      const cancelRes = await agent.post(`/api/workspaces/${organizationId}/billing/cancel`).send({});
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.status).toBe('cancelling');
      expect(dodoMocks.subscriptionsUpdate).toHaveBeenCalledWith('sub_dodo_lifecycle_1', {
        cancel_at_next_billing_date: true,
      });

      const afterCancel = await agent.get(`/api/workspaces/${organizationId}/billing`);
      expect(afterCancel.body.plan).toBe('HARBOR');
      expect(afterCancel.body.cancelAtPeriodEnd).toBe(true);

      // Resume before period end.
      const resumeRes = await agent.post(`/api/workspaces/${organizationId}/billing/resume`).send({});
      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body.status).toBe('active');
      expect(dodoMocks.subscriptionsUpdate).toHaveBeenCalledWith('sub_dodo_lifecycle_1', {
        cancel_at_next_billing_date: false,
      });

      const afterResume = await agent.get(`/api/workspaces/${organizationId}/billing`);
      expect(afterResume.body.cancelAtPeriodEnd).toBe(false);

      // Immediate cancel webhook revokes access immediately.
      const cancelledNow = new Date(Date.now() - 1000).toISOString();
      const immediateCancelPayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.cancelled',
        timestamp: new Date(Date.now() + 5000).toISOString(),
        data: {
          subscription_id: 'sub_dodo_lifecycle_1',
          product_id: 'pdt_dodo_harbor_monthly',
          customer: { customer_id: 'cus_dodo_lifecycle_1', email, name: 'MSP Owner' },
          currency: 'USD',
          status: 'cancelled',
          quantity: 1,
          cancel_at_next_billing_date: false,
          next_billing_date: period2End,
          cancelled_at: cancelledNow,
        },
      });

      const immediateCancelRes = await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_cancel_imm_1', immediateCancelPayload))
        .send(immediateCancelPayload);
      expect(immediateCancelRes.status).toBe(200);

      const afterImmediateCancel = await agent.get(`/api/workspaces/${organizationId}/billing`);
      expect(afterImmediateCancel.body.plan).toBe('MOORING');
      expect(afterImmediateCancel.body.status).toBe('CANCELLED');
    });
  });

  describe('failed payment, dunning warning, recovery, and grace-expiry withdrawal', () => {
    it('moves to PAST_DUE on subscription.on_hold, warns via dunning, recovers on renewal, and withdraws + cancels at Dodo when grace expires', async () => {
      await seedDodoUsdPlans();
      const { agent, organizationId, email } = await createWorkspace('dunning');

      const pastPeriodEnd = new Date(Date.now() - 2 * 86_400_000).toISOString();
      const activatePayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.active',
        timestamp: new Date(Date.now() - 32 * 86_400_000).toISOString(),
        data: {
          subscription_id: 'sub_dodo_dunning_1',
          product_id: 'pdt_dodo_harbor_monthly',
          customer: { customer_id: 'cus_dodo_dunning_1', email, name: 'MSP Owner' },
          currency: 'USD',
          status: 'active',
          quantity: 1,
          cancel_at_next_billing_date: false,
          next_billing_date: pastPeriodEnd,
          metadata: {
            organizationId,
            attribution: dodoAttribution(organizationId),
          },
        },
      });

      await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_dun_active', activatePayload))
        .send(activatePayload);

      // Failed renewal arrives as subscription.on_hold.
      const onHoldPayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.on_hold',
        timestamp: new Date(Date.now() - 86_400_000).toISOString(),
        data: {
          subscription_id: 'sub_dodo_dunning_1',
          product_id: 'pdt_dodo_harbor_monthly',
          customer: { customer_id: 'cus_dodo_dunning_1', email, name: 'MSP Owner' },
          currency: 'USD',
          status: 'on_hold',
          quantity: 1,
          cancel_at_next_billing_date: false,
          next_billing_date: pastPeriodEnd,
        },
      });

      const onHoldRes = await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_dun_onhold', onHoldPayload))
        .send(onHoldPayload);
      expect(onHoldRes.status).toBe(200);
      expect(onHoldRes.body.type).toBe('subscription.past_due');

      // First dunning pass warns the workspace and keeps HARBOR during the 7-day grace window.
      const warnOutcome = await runDunning(new Date());
      expect(warnOutcome.warned).toBe(1);

      const warnedStatus = await agent.get(`/api/workspaces/${organizationId}/billing`);
      expect(warnedStatus.body.plan).toBe('HARBOR');
      expect(warnedStatus.body.dunningStage).toBe('WARNED');

      // Recovery: customer updates card and subscription.renewed arrives.
      const recoveredPeriodEnd = new Date(Date.now() + 28 * 86_400_000).toISOString();
      const recoveryPayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.renewed',
        timestamp: new Date().toISOString(),
        data: {
          subscription_id: 'sub_dodo_dunning_1',
          product_id: 'pdt_dodo_harbor_monthly',
          customer: { customer_id: 'cus_dodo_dunning_1', email, name: 'MSP Owner' },
          currency: 'USD',
          status: 'active',
          quantity: 1,
          cancel_at_next_billing_date: false,
          next_billing_date: recoveredPeriodEnd,
        },
      });

      await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_dun_recover', recoveryPayload))
        .send(recoveryPayload);

      const recoveredStatus = await agent.get(`/api/workspaces/${organizationId}/billing`);
      expect(recoveredStatus.body.status).toBe('ACTIVE');
      expect(recoveredStatus.body.dunningStage).toBe('NONE');
      expect(recoveredStatus.body.graceEnds).toBeNull();

      // Now simulate another failed renewal that goes unrecovered past the 7-day grace window.
      const expiredPeriodEnd = new Date(Date.now() - 10 * 86_400_000);
      await prisma.subscription.update({
        where: { organizationId },
        data: {
          status: 'PAST_DUE',
          currentPeriodEnd: expiredPeriodEnd,
          dunningStage: 'WARNED',
          graceEndsAt: new Date(Date.now() - 86_400_000),
        },
      });
      dodoMocks.subscriptionsRetrieve.mockResolvedValue({
        subscription_id: 'sub_dodo_dunning_1',
        status: 'on_hold',
        product_id: 'pdt_dodo_harbor_monthly',
        currency: 'USD',
        quantity: 1,
      });

      const withdrawOutcome = await runDunning(new Date());
      expect(withdrawOutcome.downgraded).toBe(1);
      expect(dodoMocks.subscriptionsUpdate).toHaveBeenCalledWith('sub_dodo_dunning_1', {
        status: 'cancelled',
      });

      const withdrawnStatus = await agent.get(`/api/workspaces/${organizationId}/billing`);
      expect(withdrawnStatus.body.plan).toBe('MOORING');
      expect(withdrawnStatus.body.dunningStage).toBe('WITHDRAWN');
    });
  });

  describe('prorated upgrade, downgrade, and preview', () => {
    it('previews and applies prorated upgrades and downgrades immediately via Dodo subscriptions.changePlan', async () => {
      await seedDodoUsdPlans();
      const { agent, organizationId, email } = await createWorkspace('proration');

      const periodEnd = new Date(Date.now() + 20 * 86_400_000).toISOString();
      const activatePayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.active',
        timestamp: new Date().toISOString(),
        data: {
          subscription_id: 'sub_dodo_change_1',
          product_id: 'pdt_dodo_harbor_monthly',
          customer: { customer_id: 'cus_dodo_change_1', email, name: 'MSP Owner' },
          currency: 'USD',
          status: 'active',
          quantity: 1,
          cancel_at_next_billing_date: false,
          next_billing_date: periodEnd,
          metadata: {
            organizationId,
            attribution: dodoAttribution(organizationId),
          },
        },
      });

      await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_change_active', activatePayload))
        .send(activatePayload);

      dodoMocks.subscriptionsRetrieve.mockResolvedValue({
        subscription_id: 'sub_dodo_change_1',
        status: 'active',
        product_id: 'pdt_dodo_harbor_monthly',
        customer: { customer_id: 'cus_dodo_change_1' },
        currency: 'USD',
        quantity: 1,
        cancel_at_next_billing_date: false,
        next_billing_date: periodEnd,
      });

      dodoMocks.subscriptionsPreviewChangePlan.mockResolvedValue({
        immediate_charge: {
          effective_at: new Date().toISOString(),
          line_items: [],
          summary: {
            currency: 'USD',
            customer_credits: 0,
            customer_credits_currency: 'USD',
            settlement_amount: 16667,
            settlement_currency: 'USD',
            total_amount: 16667,
          },
        },
        new_plan: {
          subscription_id: 'sub_dodo_change_1',
          product_id: 'pdt_dodo_admiralty_monthly',
          currency: 'USD',
          status: 'active',
          quantity: 1,
          recurring_pre_tax_amount: 39900,
          next_billing_date: periodEnd,
        },
      });

      const previewUp = await agent.post(`/api/workspaces/${organizationId}/billing/plan/preview`).send({
        plan: 'ADMIRALTY',
        interval: 'monthly',
      });
      expect(previewUp.status).toBe(200);
      expect(previewUp.body).toMatchObject({
        plan: 'ADMIRALTY',
        effectiveAt: 'immediate',
        currency: 'USD',
        chargeNowMinor: 16667,
        creditMinor: 0,
        nextAmountMinor: 39900,
        includesTax: true,
      });

      // Apply upgrade to ADMIRALTY.
      const upgradeRes = await agent.patch(`/api/workspaces/${organizationId}/billing/plan`).send({
        plan: 'ADMIRALTY',
        interval: 'monthly',
      });
      expect(upgradeRes.status).toBe(200);
      expect(upgradeRes.body.status).toBe('applied');
      expect(upgradeRes.body.effectiveAt).toBe('immediate');
      expect(dodoMocks.subscriptionsChangePlan).toHaveBeenCalledWith('sub_dodo_change_1', {
        product_id: 'pdt_dodo_admiralty_monthly',
        quantity: 1,
        proration_billing_mode: 'prorated_immediately',
        on_payment_failure: 'prevent_change',
      });

      const afterUpgrade = await agent.get(`/api/workspaces/${organizationId}/billing`);
      expect(afterUpgrade.body.plan).toBe('ADMIRALTY');

      // Apply downgrade to FAIRWAY immediately with proration.
      dodoMocks.subscriptionsRetrieve.mockResolvedValue({
        subscription_id: 'sub_dodo_change_1',
        status: 'active',
        product_id: 'pdt_dodo_admiralty_monthly',
        customer: { customer_id: 'cus_dodo_change_1' },
        currency: 'USD',
        quantity: 1,
        cancel_at_next_billing_date: false,
        next_billing_date: periodEnd,
      });

      const downgradeRes = await agent.patch(`/api/workspaces/${organizationId}/billing/plan`).send({
        plan: 'FAIRWAY',
        interval: 'monthly',
      });
      expect(downgradeRes.status).toBe(200);
      expect(downgradeRes.body.status).toBe('applied');
      expect(dodoMocks.subscriptionsChangePlan).toHaveBeenCalledWith('sub_dodo_change_1', {
        product_id: 'pdt_dodo_fairway_monthly',
        quantity: 1,
        proration_billing_mode: 'prorated_immediately',
        on_payment_failure: 'prevent_change',
      });

      const afterDowngrade = await agent.get(`/api/workspaces/${organizationId}/billing`);
      expect(afterDowngrade.body.plan).toBe('FAIRWAY');
      expect(afterDowngrade.body.pendingPlan).toBeNull();
    });
  });

  describe('Fleet checkout quantity correction and pre-renewal band sync', () => {
    it('corrects a customer-edited checkout quantity on subscription.active and moves Fleet bands before renewal with do_not_bill', async () => {
      await seedDodoUsdPlans();
      const { agent, organizationId, email } = await createWorkspace('fleet');

      const periodEnd = new Date(Date.now() + 24 * 60 * 60 * 1000); // Inside 48h renewal window
      dodoMocks.subscriptionsRetrieve.mockResolvedValue({
        subscription_id: 'sub_dodo_fleet_1',
        status: 'active',
        product_id: 'pdt_dodo_fleet_band_0',
        customer: { customer_id: 'cus_dodo_fleet_1' },
        currency: 'USD',
        quantity: 300,
        cancel_at_next_billing_date: false,
        next_billing_date: periodEnd.toISOString(),
      });

      // Customer edited quantity to 300 in checkout, while workspace has 0 active domains (billable minimum = 75, band 0).
      const activePayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.active',
        timestamp: new Date().toISOString(),
        data: {
          subscription_id: 'sub_dodo_fleet_1',
          product_id: 'pdt_dodo_fleet_band_0',
          customer: { customer_id: 'cus_dodo_fleet_1', email, name: 'MSP Owner' },
          currency: 'USD',
          status: 'active',
          quantity: 300,
          cancel_at_next_billing_date: false,
          next_billing_date: periodEnd.toISOString(),
          metadata: {
            organizationId,
            attribution: dodoAttribution(organizationId),
          },
        },
      });

      const res = await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_fleet_active', activePayload))
        .send(activePayload);
      expect(res.status).toBe(200);

      // Wait briefly for the fire-and-forget correctCheckoutQuantity promise to settle.
      await vi.waitFor(() => {
        expect(dodoMocks.subscriptionsChangePlan).toHaveBeenCalledWith('sub_dodo_fleet_1', {
          product_id: 'pdt_dodo_fleet_band_0',
          quantity: 75,
          proration_billing_mode: 'prorated_immediately',
          on_payment_failure: 'prevent_change',
        });
      });

      const subAfterCorrection = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });
      expect(subAfterCorrection.quantity).toBe(75);

      // Now add 250 verified domains so the workspace crosses into Fleet band 1 (minimum 320 domains).
      const client = await agent
        .post(`/api/workspaces/${organizationId}/clients`)
        .send({ name: 'Fleet Client', slug: `fleet-client-${Date.now()}` });
      expect(client.status).toBe(201);

      await prisma.domain.createMany({
        data: Array.from({ length: 250 }, (_, index) => ({
          clientId: client.body.id as string,
          name: `fleet-domain-${index}.test`,
          slug: `fleet-domain-${index}-${fixtureId}`,
          status: 'VERIFIED' as const,
          verifiedAt: new Date(),
        })),
      });

      dodoMocks.subscriptionsChangePlan.mockClear();
      dodoMocks.subscriptionsRetrieve.mockResolvedValue({
        subscription_id: 'sub_dodo_fleet_1',
        status: 'active',
        product_id: 'pdt_dodo_fleet_band_0',
        customer: { customer_id: 'cus_dodo_fleet_1' },
        currency: 'USD',
        quantity: 75,
        cancel_at_next_billing_date: false,
        next_billing_date: periodEnd.toISOString(),
      });

      const syncOutcome = await syncPerDomainQuantities(new Date());
      expect(syncOutcome.updated).toBe(1);
      expect(dodoMocks.subscriptionsChangePlan).toHaveBeenCalledWith('sub_dodo_fleet_1', {
        product_id: 'pdt_dodo_fleet_band_1',
        quantity: 320,
        proration_billing_mode: 'do_not_bill',
      });

      const subAfterBandSync = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });
      expect(subAfterBandSync.quantity).toBe(320);
    });
  });

  describe('staff refund route', () => {
    it('refunds the initial Dodo payment in full and cancels the subscription immediately', async () => {
      await seedDodoUsdPlans();
      const { organizationId, email } = await createWorkspace('refund');

      const periodEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const activePayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.active',
        timestamp: new Date().toISOString(),
        data: {
          subscription_id: 'sub_dodo_refund_1',
          product_id: 'pdt_dodo_harbor_monthly',
          customer: { customer_id: 'cus_dodo_refund_1', email, name: 'MSP Owner' },
          currency: 'USD',
          status: 'active',
          quantity: 1,
          cancel_at_next_billing_date: false,
          next_billing_date: periodEnd,
          metadata: {
            organizationId,
            attribution: dodoAttribution(organizationId),
          },
        },
      });

      await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_refund_active', activePayload))
        .send(activePayload);

      await prisma.organization.update({
        where: { id: organizationId },
        data: { preferredCurrency: 'USD' },
      });

      // Return two payments (a later plan_change and the original 'new' payment) to prove the initial payment is refunded.
      dodoMocks.paymentsList.mockImplementation(() =>
        asyncIterable([
          {
            payment_id: 'pay_dodo_later_upgrade',
            charge_type: 'plan_change',
            total_amount: 5000,
            created_at: new Date().toISOString(),
            status: 'succeeded',
          },
          {
            payment_id: 'pay_dodo_initial_checkout',
            charge_type: 'new',
            total_amount: 16092, // $149 + tax
            created_at: new Date(Date.now() - 86_400_000).toISOString(),
            status: 'succeeded',
          },
        ]),
      );

      dodoMocks.refundsCreate.mockResolvedValue({
        refund_id: 'ref_dodo_1',
        payment_id: 'pay_dodo_initial_checkout',
        amount: 16092,
        currency: 'USD',
        status: 'succeeded',
      });

      dodoMocks.subscriptionsRetrieve.mockResolvedValue({
        subscription_id: 'sub_dodo_refund_1',
        status: 'active',
        product_id: 'pdt_dodo_harbor_monthly',
        currency: 'USD',
        quantity: 1,
      });

      const refundRes = await request(app)
        .post(`/api/workspaces/${organizationId}/refund`)
        .set('Authorization', `Bearer ${FAKE_STAFF_KEY}`)
        .send({ reason: '14-day money-back guarantee requested by owner.' });

      expect(refundRes.status).toBe(201);
      expect(refundRes.body.refunded).toBe(true);
      expect(refundRes.body.providerRefundId).toBe('ref_dodo_1');
      expect(refundRes.body.amountMinor).toBe(16092);

      expect(dodoMocks.refundsCreate).toHaveBeenCalledWith({
        payment_id: 'pay_dodo_initial_checkout',
        reason: '14-day money-back guarantee requested by owner.',
      });
      expect(dodoMocks.subscriptionsUpdate).toHaveBeenCalledWith('sub_dodo_refund_1', {
        status: 'cancelled',
      });
    });
  });

  describe('reconciliation, duplicate/out-of-order webhooks, forged workspace id, and unpaid events', () => {
    it('repairs a missed upgrade webhook via on-demand reconciliation', async () => {
      await seedDodoUsdPlans();
      const { agent, organizationId, email } = await createWorkspace('reconcile');

      const periodEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const activePayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.active',
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        data: {
          subscription_id: 'sub_dodo_reconcile_1',
          product_id: 'pdt_dodo_fairway_monthly',
          customer: { customer_id: 'cus_dodo_reconcile_1', email, name: 'MSP Owner' },
          currency: 'USD',
          status: 'active',
          quantity: 1,
          cancel_at_next_billing_date: false,
          next_billing_date: periodEnd,
          metadata: {
            organizationId,
            attribution: dodoAttribution(organizationId),
          },
        },
      });

      await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_rec_active', activePayload))
        .send(activePayload);

      expect((await agent.get(`/api/workspaces/${organizationId}/billing`)).body.plan).toBe('FAIRWAY');

      // Remote subscription at Dodo is now ADMIRALTY, but its webhook was missed.
      dodoMocks.subscriptionsRetrieve.mockResolvedValue({
        subscription_id: 'sub_dodo_reconcile_1',
        status: 'active',
        product_id: 'pdt_dodo_admiralty_monthly',
        customer: { customer_id: 'cus_dodo_reconcile_1' },
        currency: 'USD',
        quantity: 1,
        cancel_at_next_billing_date: false,
        next_billing_date: periodEnd,
      });

      const recOutcome = await runReconciliation(new Date());
      expect(recOutcome.examined).toBe(1);
      expect(recOutcome.repaired).toBe(1);

      expect((await agent.get(`/api/workspaces/${organizationId}/billing`)).body.plan).toBe('ADMIRALTY');
    });

    it('deduplicates redelivered webhook-id values and drops out-of-order stale events', async () => {
      await seedDodoUsdPlans();
      const { agent, organizationId, email } = await createWorkspace('dedup');

      const periodEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const newerTime = new Date('2026-11-16T12:00:00.000Z').toISOString();
      const olderTime = new Date('2026-11-16T11:00:00.000Z').toISOString();

      const harborPayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.active',
        timestamp: newerTime,
        data: {
          subscription_id: 'sub_dodo_dedup_1',
          product_id: 'pdt_dodo_harbor_monthly',
          customer: { customer_id: 'cus_dodo_dedup_1', email, name: 'MSP Owner' },
          currency: 'USD',
          status: 'active',
          quantity: 1,
          cancel_at_next_billing_date: false,
          next_billing_date: periodEnd,
          metadata: {
            organizationId,
            attribution: dodoAttribution(organizationId),
          },
        },
      });

      const first = await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_dedup_same_id', harborPayload))
        .send(harborPayload);
      expect(first.status).toBe(200);
      expect(first.body.duplicate).toBe(false);

      // Same webhook-id redelivered.
      const second = await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_dedup_same_id', harborPayload))
        .send(harborPayload);
      expect(second.status).toBe(200);
      expect(second.body.duplicate).toBe(true);

      // Out-of-order older event claiming FAIRWAY must not overwrite HARBOR.
      const stalePayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.updated',
        timestamp: olderTime,
        data: {
          subscription_id: 'sub_dodo_dedup_1',
          product_id: 'pdt_dodo_fairway_monthly',
          customer: { customer_id: 'cus_dodo_dedup_1', email, name: 'MSP Owner' },
          currency: 'USD',
          status: 'active',
          quantity: 1,
          cancel_at_next_billing_date: false,
          next_billing_date: periodEnd,
        },
      });

      const staleRes = await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_dedup_stale', stalePayload))
        .send(stalePayload);
      expect(staleRes.status).toBe(200);

      expect((await agent.get(`/api/workspaces/${organizationId}/billing`)).body.plan).toBe('HARBOR');
    });

    it('refuses a forged workspace id in metadata and never grants a plan on unpaid events', async () => {
      await seedDodoUsdPlans();
      const victim = await createWorkspace('victim');
      const attacker = await createWorkspace('attacker');

      const periodEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();

      // Attacker signs with their own attribution (or wrong attribution) but claims victim's organizationId.
      const forgedPayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.active',
        timestamp: new Date().toISOString(),
        data: {
          subscription_id: 'sub_dodo_forged_1',
          product_id: 'pdt_dodo_fairway_monthly',
          customer: { customer_id: 'cus_dodo_attacker', email: attacker.email, name: 'Attacker' },
          currency: 'USD',
          status: 'active',
          quantity: 1,
          cancel_at_next_billing_date: false,
          next_billing_date: periodEnd,
          metadata: {
            organizationId: victim.organizationId,
            attribution: dodoAttribution(attacker.organizationId),
          },
        },
      });

      const forgedRes = await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_forged_1', forgedPayload))
        .send(forgedPayload);

      expect(forgedRes.status).toBe(200);
      expect(forgedRes.body.accepted).toBe(false);
      expect(forgedRes.body.organizationId).toBeNull();
      expect((await victim.agent.get(`/api/workspaces/${victim.organizationId}/billing`)).body.plan).toBe('MOORING');

      // Unpaid events: subscription with status 'pending', subscription.failed on new checkout, and payment.processing.
      const pendingPayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.updated',
        timestamp: new Date().toISOString(),
        data: {
          subscription_id: 'sub_dodo_unpaid_1',
          product_id: 'pdt_dodo_harbor_monthly',
          customer: { customer_id: 'cus_dodo_victim', email: victim.email, name: 'Victim' },
          currency: 'USD',
          status: 'pending',
          quantity: 1,
          cancel_at_next_billing_date: false,
          next_billing_date: periodEnd,
          metadata: {
            organizationId: victim.organizationId,
            attribution: dodoAttribution(victim.organizationId),
          },
        },
      });

      const pendingRes = await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_unpaid_pending', pendingPayload))
        .send(pendingPayload);
      expect(pendingRes.status).toBe(200);
      expect(pendingRes.body.accepted).toBe(false);

      const failedInitPayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'subscription.failed',
        timestamp: new Date().toISOString(),
        data: {
          subscription_id: 'sub_dodo_unpaid_2',
          product_id: 'pdt_dodo_harbor_monthly',
          customer: { customer_id: 'cus_dodo_victim', email: victim.email, name: 'Victim' },
          currency: 'USD',
          status: 'failed',
          quantity: 1,
          cancel_at_next_billing_date: false,
          next_billing_date: periodEnd,
          metadata: {
            organizationId: victim.organizationId,
            attribution: dodoAttribution(victim.organizationId),
          },
        },
      });

      const failedInitRes = await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_unpaid_failed', failedInitPayload))
        .send(failedInitPayload);
      expect(failedInitRes.status).toBe(200);
      expect(failedInitRes.body.accepted).toBe(false);

      expect((await victim.agent.get(`/api/workspaces/${victim.organizationId}/billing`)).body.plan).toBe('MOORING');

      // Refund and dispute events go to recordProviderMoneyBack and leave the plan unchanged.
      const disputePayload = JSON.stringify({
        business_id: 'bus_dodo_test',
        type: 'dispute.opened',
        timestamp: new Date().toISOString(),
        data: {
          dispute_id: 'dp_dodo_1',
          payment_id: 'pay_dodo_1',
          amount: '14900',
          currency: 'USD',
          dispute_status: 'dispute_opened',
          dispute_stage: 'dispute',
          metadata: {
            organizationId: victim.organizationId,
            attribution: dodoAttribution(victim.organizationId),
          },
        },
      });

      const disputeRes = await request(app)
        .post('/api/webhooks/dodo')
        .set('Content-Type', 'application/json')
        .set(signDodoWebhook('msg_dispute_1', disputePayload))
        .send(disputePayload);
      expect(disputeRes.status).toBe(200);
      expect(disputeRes.body.accepted).toBe(false);
      expect(disputeRes.body.detail).toContain('Refund or dispute recorded for review');

      const auditEntry = await prisma.auditLog.findFirst({
        where: { organizationId: victim.organizationId, action: 'SUBSCRIPTION_UPDATED' },
      });
      expect(auditEntry).not.toBeNull();
    });
  });
});
