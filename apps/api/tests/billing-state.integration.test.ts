import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { MockBillingProvider } from '../src/billing/mock-provider.js';
import {
  BillingStateError,
  applyBillingEvent,
  applyDuePendingPlans,
  reconcileWithProvider,
} from '../src/billing/subscription-state.js';
import type { BillingEvent, BillingInterval, CheckoutRequest } from '../src/billing/provider.js';
import { resolveEntitlements } from '../src/services/entitlements/entitlement.service.js';
import { planCatalog } from '../src/services/entitlements/plan-catalog.js';

let fixtureId = 0;

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

const password = 'correct-horse-battery-staple';

async function setupWorkspace() {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `billing-${Date.now()}-${fixtureId}@example.com`;

  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Billing Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: `Billing Agency ${fixtureId}`,
    slug: `billing-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
  const organizationId = workspace.body.id as string;
  const user = await prisma.user.findFirstOrThrow({ where: { members: { some: { organizationId } } }, select: { id: true } });

  return { agent, organizationId, userId: user.id };
}

function checkoutRequest(organizationId: string, overrides: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    organizationId,
    plan: 'HARBOR',
    interval: 'monthly' as BillingInterval,
    currency: 'USD',
    contact: { name: 'Billing Owner', email: 'owner@example.com' },
    successUrl: 'https://app.example.com/billing/complete',
    cancelUrl: 'https://app.example.com/billing',
    reference: organizationId,
    ...overrides,
  };
}

function event(organizationId: string, overrides: Partial<BillingEvent> = {}): BillingEvent {
  return {
    providerEventId: `evt_${Math.random().toString(36).slice(2)}`,
    type: 'subscription.activated',
    provider: 'RAZORPAY',
    providerSubscriptionId: `sub_${fixtureId}`,
    providerCustomerId: `cust_${fixtureId}`,
    organizationId,
    plan: 'HARBOR',
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: false,
    nextAttemptAt: null,
    occurredAt: new Date(),
    raw: { note: 'fixture' },
    ...overrides,
  };
}

describe('subscription state machine', () => {
  beforeAll(resetDatabase);

  it('moves a workspace onto the paid plan and records the change', async () => {
    const { organizationId, userId } = await setupWorkspace();

    const result = await applyBillingEvent(event(organizationId));

    expect(result.applied).toBe(true);
    expect(result.plan).toBe('HARBOR');

    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(organization.plan).toBe('HARBOR');

    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });
    expect(subscription.plan).toBe('HARBOR');
    expect(subscription.status).toBe('ACTIVE');
    expect(subscription.provider).toBe('RAZORPAY');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId, action: 'SUBSCRIPTION_UPDATED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.actorUserId).toBeNull();
    expect(audit.detail).toMatchObject({ effectivePlan: 'HARBOR', provider: 'RAZORPAY' });
    expect(userId).toBeTruthy();
  });

  it('keeps the plan and the subscription row in agreement', async () => {
    const { organizationId } = await setupWorkspace();

    await applyBillingEvent(event(organizationId));

    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });

    // Entitlement resolution reads the organisation, so these two must never
    // drift or a customer pays for a plan they cannot use.
    expect(subscription.plan).toBe(organization.plan);
  });

  it('applies a repeated webhook only once', async () => {
    const { organizationId } = await setupWorkspace();
    const first = event(organizationId, { providerEventId: 'evt_duplicate' });

    /**
     * The claim and the state change are one transaction now, so there is no
     * separate claim step to call. This previously read
     * `claimBillingEvent(first)` then `applyBillingEvent(first)`, which is
     * precisely the sequence that let an event be recorded as consumed and then
     * fail to apply.
     */
    const applied = await applyBillingEvent(first);
    expect(applied.applied).toBe(true);
    expect(applied.duplicate).toBe(false);

    // Razorpay and Paddle both redeliver, so the same id comes back.
    const redelivered = await applyBillingEvent(first);
    expect(redelivered.duplicate).toBe(true);
    expect(redelivered.applied).toBe(false);

    const stored = await prisma.billingEvent.count({ where: { providerEventId: 'evt_duplicate' } });
    expect(stored).toBe(1);

    const audit = await prisma.auditLog.count({ where: { organizationId, action: 'SUBSCRIPTION_UPDATED' } });
    expect(audit).toBe(1);
  });

  it('drops an event that happened before the last one it accepted', async () => {
    const { organizationId } = await setupWorkspace();

    const cancelled = event(organizationId, {
      providerEventId: 'evt_newer_cancel',
      status: 'cancelled',
      occurredAt: new Date('2030-06-01T00:00:00.000Z'),
    });
    await applyBillingEvent(cancelled);

    // A late activation, carrying an older timestamp. Both providers redeliver out
    // of order, so this is routine rather than exotic, and applying it would tell
    // a customer who cancelled that they are renewing.
    const staleActivation = event(organizationId, {
      providerEventId: 'evt_stale_activate',
      status: 'active',
      occurredAt: new Date('2030-05-01T00:00:00.000Z'),
    });
    const outcome = await applyBillingEvent(staleActivation);

    expect(outcome.applied).toBe(false);

    const stored = await prisma.subscription.findUniqueOrThrow({
      where: { organizationId },
      select: { status: true },
    });
    expect(stored.status).toBe('CANCELLED');

    // Recorded rather than dropped silently, so an operator can see the provider
    // sent something we chose not to act on.
    const audited = await prisma.auditLog.count({
      where: { organizationId, action: 'SUBSCRIPTION_UPDATED', detail: { path: ['event'], equals: 'stale_event_ignored' } },
    });
    expect(audited).toBe(1);
  });

  it('refuses an event that resolves to no plan rather than granting the free tier', async () => {
    const { organizationId } = await setupWorkspace();

    const before = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { plan: true },
    });

    // `?? 'MOORING'` used to turn an unresolvable plan id into a free plan for a
    // customer the provider was still charging.
    await expect(
      applyBillingEvent(event(organizationId, { providerEventId: 'evt_no_plan', plan: null })),
    ).rejects.toThrow(BillingStateError);

    const after = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { plan: true },
    });
    expect(after.plan).toBe(before.plan);
  });

  it('keeps the paid period when a cancellation event omits it', async () => {
    const { organizationId } = await setupWorkspace();
    const periodEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);

    await prisma.subscription.create({
      data: {
        organizationId,
        plan: 'HARBOR',
        status: 'ACTIVE',
        provider: 'RAZORPAY',
        providerSubscriptionId: `sub_period_${Date.now()}`,
        currentPeriodEnd: periodEnd,
      },
    });
    await prisma.organization.update({ where: { id: organizationId }, data: { plan: 'HARBOR' } });

    // No currentPeriodEnd on the event. The refund policy promises cancelling
    // keeps the paid period, and reading the payload's null as "not paid through"
    // is what broke that promise.
    await applyBillingEvent(
      event(organizationId, {
        providerEventId: 'evt_cancel_no_period',
        plan: 'HARBOR',
        status: 'cancelled',
        currentPeriodEnd: null,
      }),
    );

    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { plan: true },
    });
    expect(organization.plan).toBe('HARBOR');
  });

  it('keeps both plan records in step when a pending change lands', async () => {
    const { organizationId } = await setupWorkspace();

    await prisma.subscription.create({
      data: {
        organizationId,
        plan: 'HARBOR',
        status: 'ACTIVE',
        provider: 'NONE',
        currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        pendingPlan: 'FAIRWAY',
        pendingPlanInterval: 'MONTHLY',
      },
    });
    await prisma.organization.update({ where: { id: organizationId }, data: { plan: 'HARBOR' } });

    await applyDuePendingPlans();

    // The whole defect in one assertion: the billing page reads the organisation
    // and every quota used to read the subscription, so a downgrade that wrote
    // only one of them left a customer paying Fairway and being served Admiralty.
    const [organization, subscription] = await Promise.all([
      prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { plan: true } }),
      prisma.subscription.findUniqueOrThrow({ where: { organizationId }, select: { plan: true, pendingPlan: true } }),
    ]);

    expect(organization.plan).toBe('FAIRWAY');
    expect(subscription.plan).toBe('FAIRWAY');
    expect(subscription.pendingPlan).toBeNull();

    const entitlements = await resolveEntitlements(organizationId);
    expect(entitlements.plan).toBe('FAIRWAY');
  });

  it('keeps a pending downgrade across a renewal that still reports the old plan', async () => {
    const { organizationId } = await setupWorkspace();

    await prisma.subscription.create({
      data: {
        organizationId,
        plan: 'HARBOR',
        status: 'ACTIVE',
        provider: 'NONE',
        providerSubscriptionId: `sub_keep_${Date.now()}`,
        currentPeriodEnd: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        pendingPlan: 'FAIRWAY',
        pendingPlanInterval: 'MONTHLY',
      },
    });

    // The clear condition was the negation of its own comment, so a renewal
    // reporting the still-current tier erased the request and the customer was
    // told "scheduled for cycle end" and kept paying the higher price for ever.
    await applyBillingEvent(
      event(organizationId, {
        providerEventId: 'evt_renewal_old_price',
        plan: 'HARBOR',
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000),
      }),
    );

    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { organizationId },
      select: { pendingPlan: true },
    });
    expect(subscription.pendingPlan).toBe('FAIRWAY');
  });

  it('handles two deliveries of one event arriving at the same time', async () => {
    const { organizationId } = await setupWorkspace();
    const concurrent = event(organizationId, { providerEventId: 'evt_race' });

    // Both deliveries now race inside one transaction each, so the unique index
    // is what decides: one commits the event and its transition, the other finds
    // the row already claimed.
    const results = await Promise.all([applyBillingEvent(concurrent), applyBillingEvent(concurrent)]);

    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(await prisma.billingEvent.count({ where: { providerEventId: 'evt_race' } })).toBe(1);

    const audit = await prisma.auditLog.count({
      where: { organizationId, action: 'SUBSCRIPTION_UPDATED', detail: { path: ['event'], equals: 'subscription.activated' } },
    });
    expect(audit).toBe(1);
  });

  it('keeps the plan after cancelling, until the paid period ends', async () => {
    const { organizationId } = await setupWorkspace();
    await applyBillingEvent(event(organizationId));

    const periodEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    await applyBillingEvent(
      event(organizationId, {
        type: 'subscription.cancelled',
        status: 'cancelled',
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: true,
      }),
    );

    // They paid for this period, so they keep the plan until it runs out.
    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(organization.plan).toBe('HARBOR');
    expect((await prisma.subscription.findUniqueOrThrow({ where: { organizationId } })).cancelAtPeriodEnd).toBe(true);

    // Once the period has gone, the free plan takes over.
    await applyBillingEvent(
      event(organizationId, {
        type: 'subscription.expired',
        status: 'expired',
        currentPeriodEnd: new Date(Date.now() - 1000),
      }),
    );
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(after.plan).toBe('MOORING');
  });

  it('does not drop access immediately when a card fails', async () => {
    const { organizationId } = await setupWorkspace();
    await applyBillingEvent(event(organizationId));

    await applyBillingEvent(
      event(organizationId, {
        type: 'payment.failed',
        status: 'past_due',
        nextAttemptAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      }),
    );

    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });

    // Billing will retry, so locking the customer out mid period would be a
    // data availability problem for something that may yet succeed.
    expect(organization.plan).toBe('HARBOR');
    expect(subscription.status).toBe('PAST_DUE');
  });

  it('refuses an event that does not identify a workspace', async () => {
    const { organizationId } = await setupWorkspace();
    const orphan = event(organizationId, { organizationId: null });

    await expect(applyBillingEvent(orphan)).rejects.toBeInstanceOf(BillingStateError);
  });

  it('upgrades and downgrades through the same path', async () => {
    const { organizationId } = await setupWorkspace();
    await applyBillingEvent(event(organizationId, { plan: 'FAIRWAY' }));
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).plan).toBe('FAIRWAY');

    await applyBillingEvent(event(organizationId, { plan: 'ADMIRALTY' }));
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).plan).toBe('ADMIRALTY');

    await applyBillingEvent(event(organizationId, { plan: 'MOORING' }));
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).plan).toBe('MOORING');
  });

  it('reconciles a missed webhook against the provider', async () => {
    const { organizationId } = await setupWorkspace();

    const provider = new MockBillingProvider();
    const session = await provider.createCheckout(checkoutRequest(organizationId, { plan: 'FAIRWAY' }));
    const remote = provider.completeCheckout(session.id);

    await applyBillingEvent(event(organizationId, { plan: 'FAIRWAY', providerSubscriptionId: remote.providerSubscriptionId }));

    // The customer upgraded with the provider, but the webhook never arrived,
    // which is the case a scheduled comparison is the only way to catch.
    provider.forceRemoteState(remote.providerSubscriptionId, {
      plan: 'ADMIRALTY',
      currentPeriodEnd: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000),
    });

    const reconciled = await reconcileWithProvider(organizationId, provider);

    expect(reconciled?.applied).toBe(true);
    expect(reconciled?.plan).toBe('ADMIRALTY');
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).plan).toBe('ADMIRALTY');
  });

  it('does not reapply a reconciliation that has already run', async () => {
    const { organizationId } = await setupWorkspace();

    const provider = new MockBillingProvider();
    const session = await provider.createCheckout(checkoutRequest(organizationId, { plan: 'FAIRWAY' }));
    const remote = provider.completeCheckout(session.id);
    await applyBillingEvent(event(organizationId, { plan: 'FAIRWAY', providerSubscriptionId: remote.providerSubscriptionId }));

    expect((await reconcileWithProvider(organizationId, provider))?.applied).toBe(true);

    const second = await reconcileWithProvider(organizationId, provider);
    expect(second?.duplicate).toBe(true);

    const audit = await prisma.auditLog.count({ where: { organizationId, action: 'SUBSCRIPTION_UPDATED' } });
    expect(audit).toBe(2);
  });

  it('has nothing to reconcile without a provider subscription', async () => {
    const { organizationId } = await setupWorkspace();
    expect(await reconcileWithProvider(organizationId, new MockBillingProvider())).toBeNull();
  });
});

describe('mock billing provider', () => {
  it('charges the catalog price and refuses a free plan', async () => {
    const provider = new MockBillingProvider();
    const { organizationId } = await setupWorkspace();

    const free = await provider.createCheckout(checkoutRequest(organizationId, { plan: 'MOORING' })).catch((error) => error);
    expect(free).toBeInstanceOf(Error);

    const session = await provider.createCheckout(checkoutRequest(organizationId, { plan: 'HARBOR' }));
    expect(session.url).toContain('checkout.mock.invalid');
    expect(provider.checkouts).toHaveLength(1);
  });

  it('refuses a second active subscription for the same workspace', async () => {
    const provider = new MockBillingProvider();
    const { organizationId } = await setupWorkspace();

    const session = await provider.createCheckout(checkoutRequest(organizationId));
    provider.completeCheckout(session.id);

    const second = await provider.createCheckout(checkoutRequest(organizationId, { plan: 'FAIRWAY' })).catch((error) => error);
    expect(second).toBeInstanceOf(Error);
  });

  it('reuses one customer per workspace', async () => {
    const provider = new MockBillingProvider();
    const { organizationId } = await setupWorkspace();
    const contact = { name: 'Owner', email: 'owner@example.com' };

    const first = await provider.ensureCustomer({ organizationId, contact });
    const second = await provider.ensureCustomer({ organizationId, contact });

    expect(first.providerCustomerId).toBe(second.providerCustomerId);
  });

  it('exposes both currencies at the catalog price', () => {
    expect(planCatalog.HARBOR.prices.USD.monthlyMinor).toBe(14900);
    expect(planCatalog.HARBOR.prices.INR.monthlyMinor).toBe(1249900);
  });
});
