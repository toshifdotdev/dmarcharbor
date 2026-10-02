import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { mockProvider } from '../src/billing/registry.js';
import { applyDuePendingPlans } from '../src/billing/subscription-state.js';
import { planCatalog } from '../src/services/entitlements/plan-catalog.js';

let fixtureId = 0;

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspaceWithPendingPlan(input: {
  from: 'MOORING' | 'FAIRWAY' | 'HARBOR' | 'ADMIRALTY';
  to: 'MOORING' | 'FAIRWAY' | 'HARBOR' | 'ADMIRALTY';
  /** When the paid period ends. Relative to now. */
  periodEndInDays: number;
}): Promise<string> {
  fixtureId += 1;
  const id = `pending-${Date.now()}-${fixtureId}`;

  await prisma.organization.create({
    data: { id, name: 'Pending Workspace', slug: id, plan: input.from, createdAt: new Date() },
  });

  await prisma.subscription.create({
    data: {
      organizationId: id,
      plan: input.from,
      status: 'ACTIVE',
      provider: 'NONE',
      providerSubscriptionId: null,
      currentPeriodEnd: new Date(Date.now() + input.periodEndInDays * 86_400_000),
      pendingPlan: input.to,
      pendingPlanInterval: 'MONTHLY',
    },
  });

  return id;
}

/**
 * Paddle cannot schedule a plan change - ScheduledChangeAction is cancel, pause
 * or resume and nothing else - so the schedule is ours. These tests are the only
 * thing standing between a customer and a downgrade that never happens, or one
 * that happens three weeks late.
 */
describe('applying a pending plan change', () => {
  beforeAll(resetDatabase);

  it('leaves a change alone while the paid period is still running', async () => {
    const organizationId = await workspaceWithPendingPlan({
      from: 'HARBOR',
      to: 'FAIRWAY',
      periodEndInDays: 20,
    });

    const result = await applyDuePendingPlans();

    expect(result.applied).toBe(0);
    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    // The customer keeps what they paid for.
    expect(organization.plan).toBe('HARBOR');
  });

  it('applies the change once the period has ended', async () => {
    const organizationId = await workspaceWithPendingPlan({
      from: 'HARBOR',
      to: 'FAIRWAY',
      periodEndInDays: -1,
    });

    const result = await applyDuePendingPlans();

    expect(result.applied).toBe(1);
    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(organization.plan).toBe('FAIRWAY');
  });

  it('clears the marker so it does not apply twice', async () => {
    const organizationId = await workspaceWithPendingPlan({
      from: 'HARBOR',
      to: 'FAIRWAY',
      periodEndInDays: -1,
    });

    await applyDuePendingPlans();
    const second = await applyDuePendingPlans();

    // Idempotent: the reconciler runs every six hours and would otherwise
    // re-apply a downgrade on every pass for ever.
    expect(second.applied).toBe(0);
    const subscription = await prisma.subscription.findFirstOrThrow({ where: { organizationId } });
    expect(subscription.pendingPlan).toBeNull();
  });

  it('applies an upgrade that came due too', async () => {
    const organizationId = await workspaceWithPendingPlan({
      from: 'FAIRWAY',
      to: 'ADMIRALTY',
      periodEndInDays: -2,
    });

    await applyDuePendingPlans();

    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(organization.plan).toBe('ADMIRALTY');
  });

  it('leaves a subscription with nothing pending untouched', async () => {
    fixtureId += 1;
    const id = `pending-none-${Date.now()}-${fixtureId}`;
    await prisma.organization.create({ data: { id, name: 'No Pending', slug: id, plan: 'HARBOR', createdAt: new Date() } });
    await prisma.subscription.create({
      data: {
        organizationId: id,
        plan: 'HARBOR',
        status: 'ACTIVE',
        currentPeriodEnd: new Date(Date.now() - 10 * 86_400_000),
      },
    });

    const result = await applyDuePendingPlans();

    expect(result.applied).toBe(0);
    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: id } });
    expect(organization.plan).toBe('HARBOR');
  });

  it('records why a change was applied', async () => {
    const organizationId = await workspaceWithPendingPlan({
      from: 'HARBOR',
      to: 'FAIRWAY',
      periodEndInDays: -1,
    });

    await applyDuePendingPlans();

    const entries = await prisma.auditLog.findMany({ where: { organizationId } });
    const applied = entries.find((entry) =>
      JSON.stringify(entry.detail).includes('pending_plan_applied'),
    );
    // A downgrade that lands three weeks after the customer asked is a question
    // they will ask, and it needs an answer in the trail.
    expect(applied).toBeDefined();
  });

  it('does not claim a downgrade the provider refused', async () => {
    fixtureId += 1;
    const id = `pending-refused-${Date.now()}-${fixtureId}`;
    await prisma.organization.create({ data: { id, name: 'Refused', slug: id, plan: 'HARBOR', createdAt: new Date() } });

    const provider = mockProvider();
    // A subscription id the provider never issued, so its changePlan throws.
    await prisma.subscription.create({
      data: {
        organizationId: id,
        plan: 'HARBOR',
        status: 'ACTIVE',
        provider: 'RAZORPAY',
        providerSubscriptionId: `sub_not_real_${fixtureId}`,
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
        pendingPlan: 'FAIRWAY',
        pendingPlanInterval: 'MONTHLY',
      },
    });
    void provider;

    const result = await applyDuePendingPlans();

    expect(result.applied).toBe(0);
    const organization = await prisma.organization.findUniqueOrThrow({ where: { id } });
    // Downgrading a customer to a plan nobody is paying for is worse than being
    // a few days late on it.
    expect(organization.plan).toBe('HARBOR');
    const subscription = await prisma.subscription.findFirstOrThrow({ where: { organizationId: id } });
    expect(subscription.pendingPlan).toBe('FAIRWAY');
  });

  it('has a plan catalog that prices every tier it applies', () => {
    for (const tier of ['MOORING', 'FAIRWAY', 'HARBOR', 'ADMIRALTY'] as const) {
      expect(planCatalog[tier].prices.INR).toBeDefined();
      expect(planCatalog[tier].prices.USD).toBeDefined();
    }
  });
});
