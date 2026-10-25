import { createHmac } from 'node:crypto';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { saveStoredPlan } from '../src/billing/plans.js';
import { mockProvider } from '../src/billing/registry.js';
import { MockBillingProvider } from '../src/billing/mock-provider.js';
import { applyBillingEvent } from '../src/billing/subscription-state.js';
import { syncPerDomainQuantities } from '../src/billing/quantity.js';
import { billingStatus } from '../src/billing/checkout.service.js';
import { refundEligibility } from '../src/billing/refund.service.js';
import { handleRazorpayWebhook } from '../src/billing/webhook.service.js';
import type { BillingEvent } from '../src/billing/provider.js';
import { planCatalog } from '../src/services/entitlements/plan-catalog.js';
import {
  assertFeature,
  setOrganizationPlan,
  setOverride,
} from '../src/services/entitlements/entitlement.service.js';

vi.mock('../src/billing/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/billing/registry.js')>();
  return {
    ...actual,
    resolveProviderForCheckout: () => actual.mockProvider(),
    providerFor: () => actual.mockProvider(),
  };
});

vi.mock('../src/services/branding/logo-storage.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/branding/logo-storage.service.js')>();
  return { ...actual, deleteStoredLogo: vi.fn(async () => true) };
});

let fixtureId = 0;
let domainSequence = 0;
let eventSequence = 0;
const password = 'correct-horse-battery-staple';
const webhookSecret = 'whsec_fleet_integration';
const provider = mockProvider() as MockBillingProvider;

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "domain_switch", "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function seedPlans(): Promise<void> {
  for (const currency of ['USD', 'INR'] as const) {
    for (const tier of ['FAIRWAY', 'HARBOR', 'ADMIRALTY'] as const) {
      for (const interval of ['monthly', 'annual'] as const) {
        await saveStoredPlan({
          provider: 'RAZORPAY',
          tier,
          interval,
          currency,
          priceMinor:
            interval === 'monthly'
              ? planCatalog[tier].prices[currency].monthlyMinor
              : planCatalog[tier].prices[currency].annualMinor,
          providerPlanId: `plan_${tier}_${interval}_${currency}`,
        });
      }
    }
    await saveStoredPlan({
      provider: 'RAZORPAY',
      tier: 'FLEET',
      interval: 'monthly',
      currency,
      priceMinor: planCatalog.FLEET.prices[currency].monthlyMinor,
      providerPlanId: `plan_FLEET_monthly_${currency}`,
    });
  }
}

async function setupWorkspace() {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `fleet-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Fleet Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: `Fleet Agency ${fixtureId}`,
    slug: `fleet-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);

  const organizationId = workspace.body.id as string;
  const user = await prisma.user.findFirstOrThrow({
    where: { members: { some: { organizationId } } },
    select: { id: true },
  });

  return { agent, organizationId, userId: user.id, email };
}

async function createClientRow(organizationId: string) {
  fixtureId += 1;
  return prisma.client.create({
    data: {
      organizationId,
      name: `Fleet Client ${fixtureId}`,
      slug: `fleet-client-${fixtureId}`,
    },
    select: { id: true },
  });
}

async function addDomains(clientId: string, count: number): Promise<void> {
  await prisma.domain.createMany({
    data: Array.from({ length: count }, () => {
      domainSequence += 1;
      return {
        clientId,
        name: `fleet-${domainSequence}.test`,
        slug: `fleet-domain-${domainSequence}`,
      };
    }),
  });
}

async function createProviderSubscription(input: {
  organizationId: string;
  plan: 'HARBOR' | 'ADMIRALTY' | 'FLEET';
  quantity?: number;
  currentPeriodEnd?: Date;
}): Promise<string> {
  const session = await provider.createCheckout({
    organizationId: input.organizationId,
    plan: input.plan,
    interval: 'monthly',
    currency: 'INR',
    quantity: input.quantity ?? 1,
    contact: { name: 'Fleet Owner', email: 'owner@example.com' },
    successUrl: 'https://app.example.com/billing/complete',
    cancelUrl: 'https://app.example.com/billing',
    reference: input.organizationId,
  });
  const remote = provider.completeCheckout(session.id);
  const quantity = input.quantity ?? 1;

  await applyBillingEvent({
    providerEventId: `fleet-activate-${Date.now()}-${++eventSequence}`,
    type: 'subscription.activated',
    provider: 'RAZORPAY',
    providerSubscriptionId: remote.providerSubscriptionId,
    providerCustomerId: remote.providerCustomerId,
    organizationId: input.organizationId,
    plan: input.plan,
    status: 'active',
    currentPeriodEnd: input.currentPeriodEnd ?? new Date(Date.now() + 30 * 86_400_000),
    cancelAtPeriodEnd: false,
    quantity,
    nextAttemptAt: null,
    occurredAt: new Date(),
    raw: { fixture: true },
  });

  return remote.providerSubscriptionId;
}

async function renewalEvent(input: {
  organizationId: string;
  providerSubscriptionId: string;
  plan: 'HARBOR' | 'ADMIRALTY' | 'FLEET';
  quantity?: number;
  currentPeriodEnd?: Date;
  occurredAt?: Date;
  type?: BillingEvent['type'];
}): Promise<void> {
  await applyBillingEvent({
    providerEventId: `fleet-renewal-${Date.now()}-${++eventSequence}`,
    type: input.type ?? 'subscription.updated',
    provider: 'RAZORPAY',
    providerSubscriptionId: input.providerSubscriptionId,
    providerCustomerId: null,
    organizationId: input.organizationId,
    plan: input.plan,
    status: 'active',
    currentPeriodEnd: input.currentPeriodEnd ?? new Date(Date.now() + 30 * 86_400_000),
    cancelAtPeriodEnd: false,
    quantity: input.quantity ?? 1,
    nextAttemptAt: null,
    occurredAt: input.occurredAt ?? new Date(),
    raw: { fixture: 'renewal' },
  });
}

async function workspaceWithBilling(input: {
  plan: 'HARBOR' | 'ADMIRALTY' | 'FLEET';
  quantity?: number;
  domains?: number;
  currentPeriodEnd?: Date;
}) {
  const workspace = await setupWorkspace();
  const client = await createClientRow(workspace.organizationId);
  if (input.domains) {
    await addDomains(client.id, input.domains);
  }
  const providerSubscriptionId = await createProviderSubscription({
    organizationId: workspace.organizationId,
    plan: input.plan,
    quantity: input.quantity,
    currentPeriodEnd: input.currentPeriodEnd,
  });
  return { ...workspace, clientId: client.id, providerSubscriptionId };
}

function signedRazorpayEvent(input: {
  eventName: string;
  eventId: string;
  planId: string;
  quantity: number;
  organizationId: string;
  currentEnd: number;
}) {
  const body = JSON.stringify({
    event: input.eventName,
    payload: {
      entity: { id: input.eventId },
      created_at: Math.floor(Date.now() / 1000),
      subscription: {
        entity: {
          id: `sub_${input.eventId}`,
          plan_id: input.planId,
          customer_id: `cust_${input.eventId}`,
          status: 'active',
          current_end: input.currentEnd,
          cancel_at_cycle_end: false,
          quantity: input.quantity,
          notes: { organizationId: input.organizationId },
        },
      },
    },
  });

  return {
    rawBody: body,
    signature: createHmac('sha256', webhookSecret).update(body).digest('hex'),
    secret: webhookSecret,
    eventName: input.eventName,
  };
}

describe('Fleet checkout', () => {
  beforeAll(async () => {
    await resetDatabase();
    await seedPlans();
  });

  it('bills the 75 domain minimum for a ten domain workspace, ignoring a spoofed quantity', async () => {
    const { agent, organizationId } = await setupWorkspace();
    const client = await createClientRow(organizationId);
    await addDomains(client.id, 10);

    const response = await agent.post(`/api/workspaces/${organizationId}/billing/checkout`).send({
      plan: 'FLEET',
      interval: 'monthly',
      currency: 'INR',
      quantity: 500,
      contact: { name: 'Fleet Owner', email: 'owner@example.com' },
    });

    expect(response.status).toBe(201);
    expect(response.body.quantity).toBe(75);
    expect(response.body.unitPriceMinor).toBe(planCatalog.FLEET.prices.INR.monthlyMinor);
    expect(response.body.priceMinor).toBe(planCatalog.FLEET.prices.INR.monthlyMinor * 75);
    expect(response.body.priceLabel).toBe('\u20b912,675');
    expect(response.body.interval).toBe('monthly');

    const checkout = provider.checkouts.find((entry) => entry.organizationId === organizationId);
    expect(checkout?.quantity).toBe(75);
  });

  it('bills the measured count above the minimum', async () => {
    const { agent, organizationId } = await setupWorkspace();
    const client = await createClientRow(organizationId);
    await addDomains(client.id, 120);

    const response = await agent.post(`/api/workspaces/${organizationId}/billing/checkout`).send({
      plan: 'FLEET',
      interval: 'monthly',
      currency: 'INR',
      contact: { name: 'Fleet Owner', email: 'owner@example.com' },
    });

    expect(response.status).toBe(201);
    expect(response.body.quantity).toBe(120);
    expect(response.body.priceMinor).toBe(planCatalog.FLEET.prices.INR.monthlyMinor * 120);
  });

  it('refuses annual Fleet, which is not sold', async () => {
    const { agent, organizationId } = await setupWorkspace();

    const response = await agent.post(`/api/workspaces/${organizationId}/billing/checkout`).send({
      plan: 'FLEET',
      interval: 'annual',
      currency: 'INR',
      contact: { name: 'Fleet Owner', email: 'owner@example.com' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INTERVAL_NOT_OFFERED');
  });
});

describe('moving between Fleet and the ladder', () => {
  beforeAll(resetDatabase);
  beforeAll(seedPlans);

  it('sends the billable quantity when moving Harbor to Fleet', async () => {
    const workspace = await workspaceWithBilling({ plan: 'HARBOR', domains: 120 });

    const response = await workspace.agent
      .patch(`/api/workspaces/${workspace.organizationId}/billing/plan`)
      .send({ plan: 'FLEET', interval: 'monthly' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('scheduled');

    const change = provider.planChanges.filter(
      (entry) => entry.providerSubscriptionId === workspace.providerSubscriptionId,
    ).at(-1);
    expect(change).toEqual({
      providerSubscriptionId: workspace.providerSubscriptionId,
      plan: 'FLEET',
      interval: 'monthly',
      quantity: 120,
    });

    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { organizationId: workspace.organizationId },
    });
    expect(subscription.pendingPlan).toBe('FLEET');
  });

  it('refuses Fleet to Harbor while 85 active domains exceed Harbor', async () => {
    const workspace = await workspaceWithBilling({ plan: 'FLEET', quantity: 85, domains: 85 });

    const response = await workspace.agent
      .patch(`/api/workspaces/${workspace.organizationId}/billing/plan`)
      .send({ plan: 'HARBOR', interval: 'monthly' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PLAN_CHANGE_OVER_QUOTA');
    const overage = response.body.error.overage as Array<{ quota: string; used: number; limit: number }>;
    const domains = overage.find((entry) => entry.quota === 'activeDomain');
    expect(domains).toMatchObject({ used: 85, limit: 80 });
  });

  it('refuses Fleet to Admiralty over 300 domains and allows it under', async () => {
    const tooMany = await workspaceWithBilling({ plan: 'FLEET', quantity: 75, domains: 301 });
    const refused = await tooMany.agent
      .patch(`/api/workspaces/${tooMany.organizationId}/billing/plan`)
      .send({ plan: 'ADMIRALTY', interval: 'monthly' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PLAN_CHANGE_OVER_QUOTA');

    const fits = await workspaceWithBilling({ plan: 'FLEET', quantity: 75, domains: 250 });
    const allowed = await fits.agent
      .patch(`/api/workspaces/${fits.organizationId}/billing/plan`)
      .send({ plan: 'ADMIRALTY', interval: 'monthly' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.status).toBe('scheduled');
  });

  it('removes a stored logo when Admiralty moves to Fleet', async () => {
    const workspace = await workspaceWithBilling({ plan: 'ADMIRALTY', domains: 5 });
    await prisma.organization.update({
      where: { id: workspace.organizationId },
      data: { brandLogoUrl: 'https://cdn.harbor.test/logo.svg' },
    });

    await renewalEvent({
      organizationId: workspace.organizationId,
      providerSubscriptionId: workspace.providerSubscriptionId,
      plan: 'FLEET',
      quantity: 75,
      occurredAt: new Date(Date.now() + 1_000),
    });

    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: workspace.organizationId },
    });
    expect(organization.brandLogoUrl).toBeNull();
  });
});

describe('logo removal respects live entitlement overrides', () => {
  beforeAll(resetDatabase);
  beforeAll(seedPlans);

  it('keeps the logo on Fleet while a logoUpload override is live', async () => {
    const workspace = await workspaceWithBilling({ plan: 'FLEET', quantity: 75, domains: 10 });
    await prisma.organization.update({
      where: { id: workspace.organizationId },
      data: { brandLogoUrl: 'https://cdn.harbor.test/logo.svg' },
    });
    await setOverride(workspace.organizationId, {
      entitlement: 'branding.logoUpload',
      enabled: true,
      reason: 'Pilot customer with a negotiated exception.',
    });

    await renewalEvent({
      organizationId: workspace.organizationId,
      providerSubscriptionId: workspace.providerSubscriptionId,
      plan: 'FLEET',
      quantity: 75,
      occurredAt: new Date(Date.now() + 1_000),
    });

    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: workspace.organizationId },
    });
    expect(organization.brandLogoUrl).toBe('https://cdn.harbor.test/logo.svg');
  });

  it('removes it on the next billing event once the override has expired', async () => {
    const workspace = await workspaceWithBilling({ plan: 'FLEET', quantity: 75, domains: 10 });
    await prisma.organization.update({
      where: { id: workspace.organizationId },
      data: { brandLogoUrl: 'https://cdn.harbor.test/logo.svg' },
    });
    await setOverride(workspace.organizationId, {
      entitlement: 'branding.logoUpload',
      enabled: true,
      reason: 'Temporary exception.',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await prisma.entitlementOverride.update({
      where: {
        organizationId_entitlement: {
          organizationId: workspace.organizationId,
          entitlement: 'branding.logoUpload',
        },
      },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await renewalEvent({
      organizationId: workspace.organizationId,
      providerSubscriptionId: workspace.providerSubscriptionId,
      plan: 'FLEET',
      quantity: 75,
      occurredAt: new Date(Date.now() + 1_000),
    });

    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: workspace.organizationId },
    });
    expect(organization.brandLogoUrl).toBeNull();
  });

  it('keeps the existing Admiralty to Harbor downgrade behaviour', async () => {
    const workspace = await workspaceWithBilling({ plan: 'ADMIRALTY', domains: 5 });
    await prisma.organization.update({
      where: { id: workspace.organizationId },
      data: { brandLogoUrl: 'https://cdn.harbor.test/logo.svg' },
    });

    await renewalEvent({
      organizationId: workspace.organizationId,
      providerSubscriptionId: workspace.providerSubscriptionId,
      plan: 'HARBOR',
      occurredAt: new Date(Date.now() + 1_000),
    });

    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: workspace.organizationId },
    });
    expect(organization.brandLogoUrl).toBeNull();
  });
});

describe('per-domain quantity sync', () => {
  beforeAll(resetDatabase);
  beforeAll(seedPlans);

  beforeEach(async () => {
    await prisma.subscription.deleteMany({});
    provider.failQuantityUpdates = false;
  });

  async function dueWorkspace(input: {
    quantity?: number;
    domains?: number;
    periodEndInHours?: number;
  }) {
    const workspace = await setupWorkspace();
    const client = await createClientRow(workspace.organizationId);
    if (input.domains) {
      await addDomains(client.id, input.domains);
    }
    const providerSubscriptionId = await createProviderSubscription({
      organizationId: workspace.organizationId,
      plan: 'FLEET',
      quantity: input.quantity ?? 75,
      currentPeriodEnd: new Date(Date.now() + (input.periodEndInHours ?? 24) * 60 * 60 * 1000),
    });
    return { ...workspace, providerSubscriptionId };
  }

  it('updates inside the 48 hour window and records one audit event', async () => {
    const workspace = await dueWorkspace({ domains: 90, quantity: 75 });

    const outcome = await syncPerDomainQuantities();

    expect(outcome).toEqual({ checked: 1, updated: 1, unchanged: 0, failed: 0 });
    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { organizationId: workspace.organizationId },
    });
    expect(subscription.quantity).toBe(90);
    expect(subscription.quantitySyncedPeriodEnd?.getTime()).toBe(subscription.currentPeriodEnd?.getTime());

    expect(
      await prisma.auditLog.count({
        where: { organizationId: workspace.organizationId, action: 'BILLING_QUANTITY_UPDATED' },
      }),
    ).toBe(1);
    expect(
      provider.quantityUpdates.filter(
        (entry) => entry.providerSubscriptionId === workspace.providerSubscriptionId,
      ),
    ).toEqual([{ providerSubscriptionId: workspace.providerSubscriptionId, quantity: 90 }]);
  });

  it('leaves a subscription alone outside the window', async () => {
    await dueWorkspace({ domains: 90, periodEndInHours: 72 });

    expect(await syncPerDomainQuantities()).toEqual({ checked: 0, updated: 0, unchanged: 0, failed: 0 });
  });

  it('skips a cancellation and a pending plan', async () => {
    const cancelling = await dueWorkspace({ domains: 90 });
    await prisma.subscription.update({
      where: { organizationId: cancelling.organizationId },
      data: { cancelAtPeriodEnd: true },
    });

    const pending = await dueWorkspace({ domains: 90 });
    await prisma.subscription.update({
      where: { organizationId: pending.organizationId },
      data: { pendingPlan: 'HARBOR', pendingPlanInterval: 'MONTHLY' },
    });

    expect(await syncPerDomainQuantities()).toEqual({ checked: 0, updated: 0, unchanged: 0, failed: 0 });
  });

  it('does not sync the same period twice', async () => {
    const workspace = await dueWorkspace({ domains: 90 });
    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { organizationId: workspace.organizationId },
    });
    await prisma.subscription.update({
      where: { organizationId: workspace.organizationId },
      data: { quantitySyncedPeriodEnd: subscription.currentPeriodEnd },
    });

    expect(await syncPerDomainQuantities()).toEqual({ checked: 0, updated: 0, unchanged: 0, failed: 0 });
  });

  it('marks an unchanged quantity as synced without an audit', async () => {
    const workspace = await dueWorkspace({ domains: 90, quantity: 90 });

    const outcome = await syncPerDomainQuantities();

    expect(outcome).toEqual({ checked: 1, updated: 0, unchanged: 1, failed: 0 });
    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { organizationId: workspace.organizationId },
    });
    expect(subscription.quantitySyncedPeriodEnd?.getTime()).toBe(subscription.currentPeriodEnd?.getTime());
    expect(
      await prisma.auditLog.count({
        where: { organizationId: workspace.organizationId, action: 'BILLING_QUANTITY_UPDATED' },
      }),
    ).toBe(0);
  });

  it('releases the claim on failure and retries on the next run', async () => {
    const workspace = await dueWorkspace({ domains: 90, quantity: 75 });
    provider.failQuantityUpdates = true;

    const failed = await syncPerDomainQuantities();
    expect(failed).toEqual({ checked: 1, updated: 0, unchanged: 0, failed: 1 });

    let subscription = await prisma.subscription.findUniqueOrThrow({
      where: { organizationId: workspace.organizationId },
    });
    expect(subscription.quantity).toBe(75);
    expect(subscription.quantitySyncedPeriodEnd).toBeNull();

    const failureAudit = await prisma.auditLog.findMany({
      where: { organizationId: workspace.organizationId, action: 'SUBSCRIPTION_UPDATED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(failureAudit.some((entry) => JSON.stringify(entry.detail).includes('quantity_sync_failed'))).toBe(true);

    provider.failQuantityUpdates = false;
    const retried = await syncPerDomainQuantities();
    expect(retried).toEqual({ checked: 1, updated: 1, unchanged: 0, failed: 0 });

    subscription = await prisma.subscription.findUniqueOrThrow({
      where: { organizationId: workspace.organizationId },
    });
    expect(subscription.quantity).toBe(90);
  });

  it('lets one failure continue to the next subscription', async () => {
    const broken = await dueWorkspace({ domains: 90, quantity: 75 });
    await prisma.subscription.update({
      where: { organizationId: broken.organizationId },
      data: { providerSubscriptionId: 'sub_that_the_provider_never_issued' },
    });
    const healthy = await dueWorkspace({ domains: 90, quantity: 75 });

    const outcome = await syncPerDomainQuantities();

    expect(outcome.updated).toBe(1);
    expect(outcome.failed).toBe(1);
    const healthySubscription = await prisma.subscription.findUniqueOrThrow({
      where: { organizationId: healthy.organizationId },
    });
    expect(healthySubscription.quantity).toBe(90);
    const brokenSubscription = await prisma.subscription.findUniqueOrThrow({
      where: { organizationId: broken.organizationId },
    });
    expect(brokenSubscription.quantitySyncedPeriodEnd).toBeNull();
  });

  it('updates once when two runs race', async () => {
    const workspace = await dueWorkspace({ domains: 90, quantity: 75 });

    const [first, second] = await Promise.all([syncPerDomainQuantities(), syncPerDomainQuantities()]);

    expect((first?.updated ?? 0) + (second?.updated ?? 0)).toBe(1);
    expect(
      provider.quantityUpdates.filter(
        (entry) => entry.providerSubscriptionId === workspace.providerSubscriptionId,
      ),
    ).toHaveLength(1);
    expect(
      await prisma.auditLog.count({
        where: { organizationId: workspace.organizationId, action: 'BILLING_QUANTITY_UPDATED' },
      }),
    ).toBe(1);
  });
});

describe('Fleet webhooks, status, refunds and gating', () => {
  beforeAll(resetDatabase);
  beforeAll(seedPlans);

  it('stores the quantity a webhook carries', async () => {
    const workspace = await setupWorkspace();

    const outcome = await handleRazorpayWebhook(
      signedRazorpayEvent({
        eventName: 'subscription.activated',
        eventId: `evt_fleet_quantity_${Date.now()}`,
        planId: 'plan_FLEET_monthly_INR',
        quantity: 140,
        organizationId: workspace.organizationId,
        currentEnd: Math.floor(Date.now() / 1000) + 30 * 86_400,
      }),
    );

    expect(outcome.accepted).toBe(true);
    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { organizationId: workspace.organizationId },
    });
    expect(subscription.plan).toBe('FLEET');
    expect(subscription.quantity).toBe(140);
  });

  it('quotes the stored quantity in both currencies', async () => {
    const workspace = await setupWorkspace();
    await createProviderSubscription({
      organizationId: workspace.organizationId,
      plan: 'FLEET',
      quantity: 140,
    });
    await addDomains((await createClientRow(workspace.organizationId)).id, 3);

    const inr = await billingStatus(workspace.organizationId);
    expect(inr.plan).toBe('FLEET');
    expect(inr.pricing).toBe('per_domain');
    expect(inr.quantity).toBe(140);
    expect(inr.minimumQuantity).toBe(75);
    expect(inr.unitPriceLabel).toBe('\u20b9169');
    expect(inr.priceLabel).toBe('\u20b923,660');
    expect(inr.nextPeriodQuantity).toBe(75);
    expect(inr.perDomainQuote).toMatchObject({
      plan: 'FLEET',
      quantity: 75,
      unitMinor: planCatalog.FLEET.prices.INR.monthlyMinor,
      totalMinor: planCatalog.FLEET.prices.INR.monthlyMinor * 75,
      currency: 'INR',
    });

    await prisma.organization.update({
      where: { id: workspace.organizationId },
      data: { preferredCurrency: 'USD' },
    });
    const usd = await billingStatus(workspace.organizationId);
    expect(usd.priceLabel).toBe('$280');
    expect(usd.unitPriceLabel).toBe('$2');
  });

  it('offers a Fleet quote on a Harbor workspace too', async () => {
    const workspace = await setupWorkspace();
    await setOrganizationPlan(workspace.organizationId, 'HARBOR', {
      status: 'ACTIVE',
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    });
    await addDomains((await createClientRow(workspace.organizationId)).id, 9);

    const status = await billingStatus(workspace.organizationId);
    expect(status.plan).toBe('HARBOR');
    expect(status.perDomainQuote).toMatchObject({
      plan: 'FLEET',
      activeDomains: 9,
      quantity: 75,
      unitMinor: planCatalog.FLEET.prices.INR.monthlyMinor,
      totalMinor: planCatalog.FLEET.prices.INR.monthlyMinor * 75,
    });
  });

  it('refunds unit times stored quantity on Fleet', async () => {
    const workspace = await setupWorkspace();
    await createProviderSubscription({
      organizationId: workspace.organizationId,
      plan: 'FLEET',
      quantity: 100,
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
    });

    const eligibility = await refundEligibility(workspace.organizationId);
    expect(eligibility.plan).toBe('FLEET');
    expect(eligibility.interval).toBe('monthly');
    expect(eligibility.amountMinor).toBe(planCatalog.FLEET.prices.INR.monthlyMinor * 100);
    expect(eligibility.amountLabel).toContain('100 active domains');
  });

  it('never quotes or refunds a Fleet charge below the minimum when no quantity was stored', async () => {
    // The column defaults to 1 and stays there when a provider event carries
    // no quantity. A Fleet charge is never below the minimum, so neither is
    // the bill shown nor the refund offered.
    const workspace = await setupWorkspace();
    await createProviderSubscription({
      organizationId: workspace.organizationId,
      plan: 'FLEET',
      quantity: 1,
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
    });

    const status = await billingStatus(workspace.organizationId);
    expect(status.quantity).toBe(75);
    expect(status.priceLabel).toBe('\u20b912,675');

    const eligibility = await refundEligibility(workspace.organizationId);
    expect(eligibility.amountMinor).toBe(planCatalog.FLEET.prices.INR.monthlyMinor * 75);
  });

  it('refuses what Harbor refuses and allows what Harbor allows', async () => {
    const fleet = await setupWorkspace();
    const harbor = await setupWorkspace();
    for (const workspace of [fleet, harbor]) {
      await setOrganizationPlan(workspace.organizationId, workspace === fleet ? 'FLEET' : 'HARBOR', {
        status: 'ACTIVE',
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      });
    }

    for (const feature of ['branding.whitelabel', 'branding.logoUpload', 'auth.sso'] as const) {
      const fleetError = await assertFeature(fleet.organizationId, feature).catch((error) => error);
      const harborError = await assertFeature(harbor.organizationId, feature).catch((error) => error);

      expect(fleetError).toMatchObject({
        code: 'FEATURE_NOT_IN_PLAN',
        details: { feature, requiredIn: 'ADMIRALTY' },
      });
      expect(harborError).toMatchObject({
        code: 'FEATURE_NOT_IN_PLAN',
        details: { feature, requiredIn: 'ADMIRALTY' },
      });
      expect(fleetError.message).toContain('Upgrade to Admiralty to use it.');
      expect(harborError.message).toContain('Upgrade to Admiralty to use it.');
    }

    for (const feature of ['portal.client', 'api.access', 'trust.center'] as const) {
      await expect(assertFeature(fleet.organizationId, feature)).resolves.toBeUndefined();
    }
  });
});
