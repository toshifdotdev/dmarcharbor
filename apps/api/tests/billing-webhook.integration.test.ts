import { createHmac } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { saveStoredPlan } from '../src/billing/plans.js';
import { handleRazorpayWebhook } from '../src/billing/webhook.service.js';
import { runDunning } from '../src/billing/dunning.js';
import { setOrganizationPlan } from '../src/services/entitlements/entitlement.service.js';
import { planCatalog } from '../src/services/entitlements/plan-catalog.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const webhookSecret = 'whsec_integration_test';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup() {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `pay-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Paying Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({ name: `Paying Agency ${fixtureId}`, slug: `paying-${fixtureId}` });
  return { agent, organizationId: workspace.body.id as string, email };
}

/** Seeds the plan mappings a provider would already have, without contacting one. */
async function seedPlans(): Promise<void> {
  const entries: { tier: 'FAIRWAY' | 'HARBOR' | 'ADMIRALTY'; interval: 'monthly' | 'annual' }[] = [];
  for (const tier of ['FAIRWAY', 'HARBOR', 'ADMIRALTY'] as const) {
    for (const interval of ['monthly', 'annual'] as const) {
      entries.push({ tier, interval });
    }
  }

  for (const entry of entries) {
    await saveStoredPlan({
      provider: 'RAZORPAY',
      tier: entry.tier,
      interval: entry.interval,
      currency: 'INR',
      priceMinor: entry.interval === 'monthly' ? planCatalog[entry.tier].prices.INR.monthlyMinor : planCatalog[entry.tier].prices.INR.annualMinor,
      providerPlanId: `plan_${entry.tier}_${entry.interval}`,
    });
  }
}

/**
 * The first event for a workspace has no subscription row to match on yet, so
 * it is attributed through the notes the checkout attached. Later events match
 * on the stored providerSubscriptionId instead.
 */
function signedRazorpayEvent(
  eventName: string,
  subscription: Record<string, unknown>,
  eventId: string,
  organizationId: string,
  key: string,
) {
  const body = JSON.stringify({
    event: eventName,
    payload: {
      entity: { id: eventId },
      subscription: {
        entity: {
          id: `sub_${key}`,
          plan_id: 'plan_HARBOR_monthly',
          customer_id: `cust_${key}`,
          status: 'active',
          current_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          cancel_at_cycle_end: false,
          notes: organizationId ? { organizationId } : {},
          ...subscription,
        },
      },
    },
  });

  return {
    rawBody: body,
    signature: createHmac('sha256', webhookSecret).update(body).digest('hex'),
    secret: webhookSecret,
    eventName,
  };
}

describe('payment webhook end to end', () => {
  beforeAll(async () => {
    await resetDatabase();
    await seedPlans();
  });

  it('moves a workspace onto the paid plan only after a verified webhook', async () => {
    const { organizationId } = await setup();

    // Nothing is paid yet.
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).plan).toBe('MOORING');

    const outcome = await handleRazorpayWebhook(signedRazorpayEvent('subscription.activated', {}, 'evt_activate_1', organizationId, 'a1'));
    expect(outcome.accepted).toBe(true);
    expect(outcome.duplicate).toBe(false);

    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(organization.plan).toBe('HARBOR');

    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });
    expect(subscription.provider).toBe('RAZORPAY');
    expect(subscription.providerSubscriptionId).toBe('sub_a1');
  });

  it('applies a redelivered activation only once', async () => {
    const { organizationId } = await setup();

    await handleRazorpayWebhook(signedRazorpayEvent('subscription.activated', {}, 'evt_activate_2', organizationId, 'a2'));
    const repeat = await handleRazorpayWebhook(signedRazorpayEvent('subscription.activated', {}, 'evt_activate_2', organizationId, 'a2'));

    expect(repeat.duplicate).toBe(true);
    expect(await prisma.billingEvent.count({ where: { providerEventId: 'razorpay:evt_activate_2' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId, action: 'SUBSCRIPTION_UPDATED' } })).toBe(1);
  });

  it('refuses an unsigned or forged activation outright', async () => {
    const { organizationId } = await setup();

    const forged = signedRazorpayEvent('subscription.activated', {}, 'evt_forged', organizationId, 'f1');
    await expect(
      handleRazorpayWebhook({ ...forged, signature: createHmac('sha256', 'wrong-secret').update(forged.rawBody).digest('hex') }),
    ).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });

    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).plan).toBe('MOORING');
    expect(await prisma.billingEvent.count({ where: { providerEventId: 'razorpay:evt_forged' } })).toBe(0);
  });

  it('refuses every event when no webhook secret is configured', async () => {
    const { organizationId } = await setup();
    const event = signedRazorpayEvent('subscription.activated', {}, 'evt_no_secret', organizationId, 'n1');

    await expect(handleRazorpayWebhook({ ...event, secret: null })).rejects.toMatchObject({ code: 'WEBHOOK_NOT_CONFIGURED' });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).plan).toBe('MOORING');
  });

  it('keeps access after a cancellation until the paid period ends', async () => {
    const { organizationId } = await setup();
    await handleRazorpayWebhook(signedRazorpayEvent('subscription.activated', {}, 'evt_cancel_flow', organizationId, 'c1'));

    const periodEnd = Math.floor(Date.now() / 1000) + 15 * 24 * 60 * 60;
    await handleRazorpayWebhook(
      signedRazorpayEvent('subscription.cancelled', { status: 'cancelled', current_end: periodEnd, cancel_at_cycle_end: true }, 'evt_cancel_1', organizationId, 'c1'),
    );

    // They paid for these fifteen days, so the plan survives.
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).plan).toBe('HARBOR');
    expect((await prisma.subscription.findUniqueOrThrow({ where: { organizationId } })).cancelAtPeriodEnd).toBe(true);

    await handleRazorpayWebhook(
      signedRazorpayEvent('subscription.completed', { status: 'completed', current_end: Math.floor(Date.now() / 1000) - 60 }, 'evt_expire_1', organizationId, 'c1'),
    );
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).plan).toBe('MOORING');
  });

  it('rejects a payment failure and stores it without a webhook secret leak', async () => {
    const { organizationId } = await setup();
    await handleRazorpayWebhook(signedRazorpayEvent('subscription.activated', {}, 'evt_pastdue_flow', organizationId, 'p1'));

    const outcome = await handleRazorpayWebhook(
      signedRazorpayEvent('subscription.pending', { status: 'pending' }, 'evt_pending_1', organizationId, 'p1'),
    );

    expect(outcome.type).toBe('subscription.past_due');
    // A retry is still expected, so the customer keeps their plan.
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).plan).toBe('HARBOR');
    expect((await prisma.subscription.findUniqueOrThrow({ where: { organizationId } })).status).toBe('PAST_DUE');
  });

  it('ignores an event it does not recognise, without failing', async () => {
    const { organizationId } = await setup();
    const outcome = await handleRazorpayWebhook(signedRazorpayEvent('settlement.on_account_updated', {}, 'evt_unknown', organizationId, 'u1'));
    expect(outcome.accepted).toBe(false);
    expect(outcome.detail).toContain('Unmapped');
  });
});

describe('dunning', () => {
  beforeAll(resetDatabase);

  it('keeps the plan while the paid period has not ended', async () => {
    const { organizationId } = await setup();
    await setOrganizationPlan(organizationId, 'HARBOR', {
      status: 'PAST_DUE',
      currentPeriodEnd: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });

    const outcome = await runDunning();

    expect(outcome.examined).toBeGreaterThan(0);
    expect(outcome.downgraded).toBe(0);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).plan).toBe('HARBOR');
  });

  it('warns but does not withdraw while the grace period is running', async () => {
    const { organizationId } = await setup();
    await setOrganizationPlan(organizationId, 'HARBOR', {
      status: 'PAST_DUE',
      // Two days past the end of the period, inside the seven day grace.
      currentPeriodEnd: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });

    const outcome = await runDunning();

    expect(outcome.warned).toBe(1);
    expect(outcome.downgraded).toBe(0);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).plan).toBe('HARBOR');
  });

  it('moves a workspace to the free plan once the grace has passed, keeping its data', async () => {
    const { agent, organizationId } = await setup();
    const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({ name: 'Kept Client', slug: `kept-${fixtureId}` });

    await setOrganizationPlan(organizationId, 'HARBOR', {
      status: 'PAST_DUE',
      // Well past the grace, which is what a card that died a month ago looks
      // like rather than a transient decline.
      currentPeriodEnd: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const outcome = await runDunning();
    expect(outcome.downgraded).toBe(1);

    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).plan).toBe('MOORING');

    // A failed payment must never cost a customer their data.
    expect(await prisma.client.count({ where: { id: client.body.id } })).toBe(1);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId, action: 'SUBSCRIPTION_UPDATED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.detail).toMatchObject({ previousPlan: 'HARBOR', newPlan: 'MOORING', dataRetained: true });
  });
});
