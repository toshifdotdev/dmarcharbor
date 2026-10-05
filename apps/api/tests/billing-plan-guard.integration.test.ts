import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { saveStoredPlan } from '../src/billing/plans.js';
import { mockProvider } from '../src/billing/registry.js';
import { MockBillingProvider } from '../src/billing/mock-provider.js';
import { applyBillingEvent } from '../src/billing/subscription-state.js';
import type { BillingInterval } from '../src/billing/provider.js';
import type { BillingCurrency } from '../src/services/entitlements/plan-catalog.js';
import { app } from '../src/index.js';
import { planCatalog } from '../src/services/entitlements/plan-catalog.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

/**
 * A workspace with a real Razorpay subscription and, optionally, more clients
 * than the target plan allows.
 *
 * This is the shape of the bug that was live: twelve clients on Harbor moving to
 * Fairway, which allows five. Every one of the twelve kept running, nothing
 * reported the mismatch, and the customer found out when the next client
 * creation failed with a message about a limit they had already passed.
 */
async function workspaceWithClients(
  clientCount: number,
  options: { currentPlan?: 'MOORING' | 'FAIRWAY' | 'HARBOR' | 'ADMIRALTY' } = {},
): Promise<{ agent: ReturnType<typeof request.agent>; organizationId: string }> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `guard-${Date.now()}-${fixtureId}@example.com`;

  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Guard Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Guard Workspace',
    slug: `guard-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;

  const currentPlan = options.currentPlan ?? 'HARBOR';
  const providerPlanId = `plan_guard_${fixtureId}`;

  await saveStoredPlan({
    provider: 'RAZORPAY',
    tier: currentPlan,
    interval: 'monthly',
    currency: 'INR',
    priceMinor: planCatalog[currentPlan].prices.INR.monthlyMinor,
    providerPlanId,
  });

  // The subscription is created through the mock provider's own checkout rather
  // than written straight to the database, because changePlan asks the provider
  // and the mock answers 404 for a subscription it did not issue. A row invented
  // directly would let the success paths pass against a provider that never
  // agreed to the change.
  // completeCheckout is on the mock rather than the interface, so the
  // concrete type is named rather than widening the interface for a test.
  const provider = mockProvider() as MockBillingProvider;
  const session = await provider.createCheckout({
    organizationId,
    plan: currentPlan,
    interval: 'monthly' as BillingInterval,
    currency: 'INR' as BillingCurrency,
    contact: { name: 'Guard Owner', email },
    successUrl: 'https://app.example.com/billing/complete',
    cancelUrl: 'https://app.example.com/billing',
    reference: organizationId,
  });
  const remote = provider.completeCheckout(session.id);

  await applyBillingEvent({
    providerEventId: `evt_guard_${fixtureId}`,
    type: 'subscription.activated',
    provider: 'RAZORPAY',
    providerSubscriptionId: remote.providerSubscriptionId,
    providerCustomerId: null,
    organizationId,
    plan: currentPlan,
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    cancelAtPeriodEnd: false,
    nextAttemptAt: null,
    occurredAt: new Date(),
    raw: { note: 'fixture' },
  });

  for (let index = 0; index < clientCount; index += 1) {
    const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
      name: `Client ${index}`,
      slug: `client-${Date.now()}-${fixtureId}-${index}`,
    });
    expect(client.status).toBe(201);
  }

  return { agent, organizationId };
}

// The provider is reached only after the guard passes, and a real Razorpay call
// with no credentials answers 503. Swapped at the registry seam the codebase
// already provides for exactly this, so the refusal tests below still run against
// the real prisma, the real entitlements and the real controller.
vi.mock('../src/billing/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/billing/registry.js')>();
  return {
    ...actual,
    resolveProviderForCheckout: () => actual.mockProvider(),
  };
});

describe('downgrading a workspace that is over the target quota', () => {
  beforeAll(resetDatabase);

  it('refuses the downgrade and names the overage', async () => {
    const { agent, organizationId } = await workspaceWithClients(12);

    const response = await agent.patch(`/api/workspaces/${organizationId}/billing/plan`).send({
      plan: 'FAIRWAY',
      interval: 'monthly',
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PLAN_CHANGE_OVER_QUOTA');
  });

  it('hands the numbers over as data, not only as a sentence', async () => {
    const { agent, organizationId } = await workspaceWithClients(12);

    const response = await agent.patch(`/api/workspaces/${organizationId}/billing/plan`).send({
      plan: 'FAIRWAY',
      interval: 'monthly',
    });

    // Without this the UI has to regex the message apart to recover the numbers
    // the customer needs in order to do anything about it.
    const overage = response.body.error.overage as { quota: string; used: number; limit: number; by: number }[];
    expect(Array.isArray(overage)).toBe(true);
    const clients = overage.find((entry) => entry.quota === 'client');
    expect(clients).toBeDefined();
    expect(clients?.used).toBe(12);
    expect(clients?.limit).toBe(5);
    expect(clients?.by).toBe(7);
  });

  it('lists every exceeded limit, not just the first', async () => {
    const { agent, organizationId } = await workspaceWithClients(12);

    // Fairway allows twenty active domains, so twenty-one overruns that as well as
    // the five-client limit. Inserted directly rather than over HTTP, because
    // twenty-one round trips would be testing the router instead of the guard.
    const client = await prisma.client.findFirstOrThrow({ where: { organizationId } });
    await prisma.domain.createMany({
      data: Array.from({ length: 21 }, (_, index) => ({
        clientId: client.id,
        name: `guard-${index}.test`,
        slug: `guard-${index}-${fixtureId}`,
      })),
    });

    const response = await agent.patch(`/api/workspaces/${organizationId}/billing/plan`).send({
      plan: 'FAIRWAY',
      interval: 'monthly',
    });

    const overage = response.body.error.overage as { quota: string }[];
    // Fixing the client limit and then being refused again for the domains is a
    // worse experience than being handed the whole list once.
    expect(overage.map((entry) => entry.quota).sort()).toEqual(['activeDomain', 'client']);
  });

  it('leaves a single-owner workspace alone on members, because it is not over', async () => {
    const { agent, organizationId } = await workspaceWithClients(12);

    const response = await agent.patch(`/api/workspaces/${organizationId}/billing/plan`).send({
      plan: 'FAIRWAY',
      interval: 'monthly',
    });

    const overage = response.body.error.overage as { quota: string }[];
    // Mooring allows one member and this workspace has exactly one owner, so
    // reporting a member overage here would be inventing a problem.
    expect(overage.map((entry) => entry.quota)).not.toContain('member');
  });

  it('does not move the workspace or tell the provider anything', async () => {
    const { agent, organizationId } = await workspaceWithClients(12);

    await agent.patch(`/api/workspaces/${organizationId}/billing/plan`).send({
      plan: 'FAIRWAY',
      interval: 'monthly',
    });

    const subscription = await prisma.subscription.findFirst({ where: { organizationId } });
    expect(subscription?.plan).toBe('HARBOR');
    // Nothing may be recorded as pending, or the workspace looks mid-change.
    expect(subscription?.pendingPlan).toBeNull();

    const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
    expect(organization?.plan).toBe('HARBOR');
  });

  it('leaves an audit trail for a refusal', async () => {
    const { agent, organizationId } = await workspaceWithClients(12);

    await agent.patch(`/api/workspaces/${organizationId}/billing/plan`).send({
      plan: 'FAIRWAY',
      interval: 'monthly',
    });

    // A refusal is an event the customer will ask about later.
    const entries = await prisma.auditLog.findMany({ where: { organizationId } });
    expect(entries.some((entry) => entry.action === 'BILLING_PLAN_CHANGE_REFUSED')).toBe(true);
  });

  it('allows the downgrade once the workspace fits', async () => {
    const { agent, organizationId } = await workspaceWithClients(3);

    const response = await agent.patch(`/api/workspaces/${organizationId}/billing/plan`).send({
      plan: 'FAIRWAY',
      interval: 'monthly',
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('scheduled');
  });

  it('allows an upgrade regardless of usage', async () => {
    const { agent, organizationId } = await workspaceWithClients(12);

    const response = await agent.patch(`/api/workspaces/${organizationId}/billing/plan`).send({
      plan: 'ADMIRALTY',
      interval: 'monthly',
    });

    // Twelve clients is far over Fairway's five, but refusing here would refuse
    // the purchase rather than protect anything.
    expect(response.status).toBe(200);
  });
});

describe('a scheduled plan change is visible before it lands', () => {
  beforeAll(resetDatabase);

  it('reports the plan that will apply at the end of the period', async () => {
    const { agent, organizationId } = await workspaceWithClients(3);

    expect(
      (await agent.patch(`/api/workspaces/${organizationId}/billing/plan`).send({
        plan: 'FAIRWAY',
        interval: 'monthly',
      })).status,
    ).toBe(200);

    const response = await agent.get(`/api/workspaces/${organizationId}/billing`);

    // The customer used to discover a downgrade by losing a feature.
    expect(response.body.plan).toBe('HARBOR');
    expect(response.body.pendingPlan).not.toBeNull();
    expect(response.body.pendingPlan.plan).toBe('FAIRWAY');
    expect(response.body.pendingPlan.interval).toBe('MONTHLY');
    expect(response.body.pendingPlan.effectiveAt).toBeTruthy();
  });

  it('reports nothing pending when nothing is scheduled', async () => {
    const { agent, organizationId } = await workspaceWithClients(1);

    const response = await agent.get(`/api/workspaces/${organizationId}/billing`);

    expect(response.body.pendingPlan).toBeNull();
  });

  it('reports the dunning stage and grace end so the grace period can be stated', async () => {
    const { agent, organizationId } = await workspaceWithClients(1);

    const clean = await agent.get(`/api/workspaces/${organizationId}/billing`);
    expect(clean.body.dunningStage).toBe('NONE');
    expect(clean.body.graceEnds).toBeNull();

    const graceEnds = new Date(Date.now() + 7 * 86_400_000);
    await prisma.subscription.update({
      where: { organizationId },
      data: { status: 'PAST_DUE', dunningStage: 'WARNED', graceEndsAt: graceEnds },
    });

    const failing = await agent.get(`/api/workspaces/${organizationId}/billing`);

    // WARNED is inside the grace window and the workspace still works, which is
    // the state people email support about instead of fixing their card.
    expect(failing.body.status).toBe('PAST_DUE');
    expect(failing.body.dunningStage).toBe('WARNED');
    expect(failing.body.graceEnds).toBe(graceEnds.toISOString());
  });
});
