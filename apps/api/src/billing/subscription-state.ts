import type { PlanTier, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { effectivePlan } from '../services/entitlements/plan-catalog.js';
import { removeLogoOnDowngrade } from '../services/branding.service.js';
import type { BillingEvent, BillingProvider, ProviderSubscriptionStatus } from './provider.js';

/**
 * Applies a verified billing event to a workspace subscription.
 *
 * Two properties are non negotiable here, because both fail silently in
 * production and neither shows up as an error.
 *
 * The first is idempotency. Razorpay and Paddle both redeliver a webhook until
 * they receive a success, often many times and occasionally out of order. The
 * provider's event id is written inside the same transaction as the state
 * change, so a redelivery hits a unique constraint and returns early rather
 * than applying a transition twice.
 *
 * The second is atomicity. A subscription row and an organisation's plan are
 * two records that must never disagree. Entitlement resolution reads the
 * organisation's plan, so a crash between the two writes would leave a
 * customer either paying for a plan they cannot use or using a plan they
 * stopped paying for.
 */

export class BillingStateError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'BILLING_STATE_ERROR', status = 400) {
    super(message);
    this.name = 'BillingStateError';
    this.code = code;
    this.status = status;
  }
}

const statusMap: Record<ProviderSubscriptionStatus, SubscriptionStatus> = {
  active: 'ACTIVE',
  trialing: 'TRIALING',
  past_due: 'PAST_DUE',
  cancelled: 'CANCELLED',
  expired: 'EXPIRED',
  paused: 'PAST_DUE',
};

export interface ApplyEventResult {
  applied: boolean;
  /** True when this exact event had already been processed. */
  duplicate: boolean;
  plan: PlanTier;
  status: SubscriptionStatus;
}

/**
 * Records a provider event, deduplicating on its id.
 *
 * Returns false when the event is a redelivery, so the caller can acknowledge
 * it immediately without touching any state.
 */
export async function claimBillingEvent(event: BillingEvent): Promise<boolean> {
  const existing = await prisma.billingEvent.findUnique({ where: { providerEventId: event.providerEventId } });
  if (existing) {
    return false;
  }

  try {
    await prisma.billingEvent.create({
      data: {
        providerEventId: event.providerEventId,
        provider: event.provider,
        type: event.type,
        organizationId: event.organizationId,
        providerSubscriptionId: event.providerSubscriptionId,
        payload: event.raw as never,
        occurredAt: event.occurredAt,
      },
    });
  } catch (error) {
    // A concurrent redelivery won the race. That is a duplicate, not a failure.
    if (isUniqueViolation(error)) {
      return false;
    }
    throw error;
  }

  return true;
}

export async function applyBillingEvent(event: BillingEvent): Promise<ApplyEventResult> {
  if (!event.organizationId) {
    throw new BillingStateError('The billing event did not identify a workspace.', 'MISSING_WORKSPACE', 422);
  }

  const status = statusMap[event.status ?? 'active'];
  const targetPlan = event.plan ?? 'MOORING';

  const result = await prisma.$transaction(async (tx) => {
    const organizationId = event.organizationId as string;

    // A cancellation or expiry only reduces the plan once the period the
    // customer actually paid for has run out. Until then they keep it, because
    // taking back something already paid for is what generates chargebacks.
    const resolvedPlan = effectivePlan(
      {
        plan: targetPlan,
        status,
        currentPeriodEnd: event.currentPeriodEnd,
      },
      new Date(),
    );

    await tx.subscription.upsert({
      where: { organizationId },
      create: {
        organizationId,
        plan: targetPlan,
        status,
        provider: event.provider,
        providerSubscriptionId: event.providerSubscriptionId,
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
      },
      update: {
        plan: targetPlan,
        status,
        provider: event.provider,
        ...(event.providerSubscriptionId ? { providerSubscriptionId: event.providerSubscriptionId } : {}),
        ...(event.currentPeriodEnd ? { currentPeriodEnd: event.currentPeriodEnd } : {}),
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
      },
    });

    // The organisation's plan is what entitlement resolution actually reads, so
    // it is written in the same transaction as the subscription above.
    await tx.organization.update({ where: { id: organizationId }, data: { plan: resolvedPlan } });

    // Dropping a stored asset is the mirror image of never destroying data on a
    // failed payment: a customer must not have their brand left sitting in a
    // bucket after the tier that justified storing it has gone. Only the
    // reference is cleared, never anything the customer owns.
    if (resolvedPlan !== 'ADMIRALTY') {
      await removeLogoOnDowngrade(organizationId);
    }

    await tx.auditLog.create({
      data: {
        organizationId,
        action: 'SUBSCRIPTION_UPDATED',
        targetType: 'subscription',
        targetId: event.providerSubscriptionId ?? organizationId,
        detail: {
          provider: event.provider,
          event: event.type,
          requestedPlan: targetPlan,
          effectivePlan: resolvedPlan,
          status,
          currentPeriodEnd: event.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: event.cancelAtPeriodEnd,
        },
      },
    });

    return { plan: resolvedPlan, status };
  });

  return { applied: true, duplicate: false, plan: result.plan, status: result.status };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * A deliberate, audited plan change made by us rather than by a provider.
 *
 * Used by a support action, a pilot override or a migration. Provider driven
 * changes always go through `applyBillingEvent` so there is exactly one path
 * that can move a plan.
 */
export async function setPlanByStaff(input: {
  organizationId: string;
  plan: PlanTier;
  actorUserId?: string | null;
  reason: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.subscription.upsert({
      where: { organizationId: input.organizationId },
      create: {
        organizationId: input.organizationId,
        plan: input.plan,
        status: 'ACTIVE',
        provider: 'NONE',
        currentPeriodEnd: null,
      },
      update: { plan: input.plan, status: 'ACTIVE', cancelAtPeriodEnd: false },
    });

    await tx.organization.update({ where: { id: input.organizationId }, data: { plan: input.plan } });
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'SUBSCRIPTION_UPDATED',
    targetType: 'subscription',
    targetId: input.organizationId,
    detail: { plan: input.plan, reason: input.reason, source: 'staff' },
  });
}

/**
 * Reconciles our record against the provider.
 *
 * Webhook delivery is not guaranteed, so a scheduled comparison is the only way
 * to notice that a card was updated, a subscription paused, or an invoice
 * settled without a webhook ever arriving.
 */
export async function reconcileWithProvider(
  organizationId: string,
  provider: BillingProvider,
): Promise<ApplyEventResult | null> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId },
    select: { providerSubscriptionId: true },
  });

  if (!subscription?.providerSubscriptionId) {
    return null;
  }

  const remote = await provider.fetchSubscription(subscription.providerSubscriptionId);
  if (!remote) {
    return null;
  }

  const event: BillingEvent = {
    providerEventId: `reconcile:${organizationId}:${remote.currentPeriodEnd?.toISOString() ?? 'none'}:${remote.status}`,
    type: 'subscription.updated',
    provider: provider.name,
    providerSubscriptionId: remote.providerSubscriptionId,
    providerCustomerId: remote.providerCustomerId,
    organizationId,
    plan: remote.plan,
    status: remote.status,
    currentPeriodEnd: remote.currentPeriodEnd,
    cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
    nextAttemptAt: remote.nextAttemptAt ?? null,
    occurredAt: new Date(),
    raw: remote,
  };

  if (!(await claimBillingEvent(event))) {
    return { applied: false, duplicate: true, plan: remote.plan, status: statusMap[remote.status] };
  }

  return applyBillingEvent(event);
}
