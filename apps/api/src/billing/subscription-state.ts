import type { PlanTier, SubscriptionStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { providerFor } from './registry.js';
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
 *
 * Now takes the caller's transaction. It used to run in its own autocommit
 * transaction and `applyBillingEvent` opened a second one for the state change,
 * while this module's own docstring and docs/BILLING.md both claimed the claim
 * and the transition shared a transaction. They did not, and the gap is the
 * expensive one: if the state change threw or the process died after the claim
 * committed, the event was recorded as consumed, the provider's retry hit the
 * unique constraint, the caller answered 200, and the paid upgrade was silently
 * lost until reconciliation noticed hours later.
 */
export async function claimBillingEvent(tx: Prisma.TransactionClient, event: BillingEvent): Promise<boolean> {
  try {
    await tx.billingEvent.create({
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
    // A redelivery, concurrent or sequential. That is a duplicate, not a failure.
    if (isUniqueViolation(error)) {
      return false;
    }
    throw error;
  }

  return true;
}

/**
 * The single place a workspace's plan is written.
 *
 * There are two records that hold a plan and they must never disagree:
 * `Organization.plan`, which is what entitlement resolution, the compliance
 * pack, the erasure inventory and the Trust Center all read, and
 * `Subscription.plan`, which is the mirror of what the provider says.
 *
 * They previously drifted because each writer touched a different one.
 * `applyDuePendingPlans` wrote only the organisation, so a scheduled downgrade
 * updated the billing page and left every quota on the old tier, while
 * `resolveEntitlements` read the subscription and therefore contradicted the
 * compliance pack reading the organisation. Reconciliation then read the stale
 * mirror and wrote the old tier back over the new one.
 *
 * Both now move together or not at all.
 */
async function writePlan(tx: Prisma.TransactionClient, organizationId: string, plan: PlanTier): Promise<void> {
  await tx.organization.update({ where: { id: organizationId }, data: { plan } });
  await tx.subscription.updateMany({ where: { organizationId }, data: { plan } });
}

export async function applyBillingEvent(event: BillingEvent): Promise<ApplyEventResult> {
  if (!event.organizationId) {
    throw new BillingStateError('The billing event did not identify a workspace.', 'MISSING_WORKSPACE', 422);
  }

  /**
   * An event that names a plan we cannot resolve is quarantined, never guessed.
   *
   * This used to be `event.plan ?? 'MOORING'`, so a missing plan id silently
   * delivered the free tier to a customer the provider was still charging for.
   * The ways to reach a null plan are all real: the `billing_plan` row was
   * deleted, a plan sync replaced a provider plan id and orphaned every live
   * subscription pointing at the old one, or two rows shared an id and
   * `findFirst` picked one arbitrarily. None of those are the customer's fault
   * and none of them justify revoking access.
   */
  if (!event.plan) {
    throw new BillingStateError(
      'The billing event did not resolve to a plan, so no change was applied. Reconcile this subscription.',
      'UNRESOLVED_PLAN',
      422,
    );
  }

  const targetPlan = event.plan;
  const status = statusMap[event.status ?? 'active'];

  const result = await prisma.$transaction(async (tx) => {
    const organizationId = event.organizationId as string;

    if (!(await claimBillingEvent(tx, event))) {
      return null;
    }

    const existing = await tx.subscription.findUnique({
      where: { organizationId },
      select: {
        plan: true,
        status: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        pendingPlan: true,
        pendingPlanInterval: true,
        lastEventAt: true,
        firstChargeAt: true,
      },
    });

    /**
     * Stale events are dropped rather than applied.
     *
     * Both providers redeliver out of order and say so in their own docs. The
     * concrete failure was a `subscription.activated` arriving after a
     * `subscription.canceled`: it rewrote the status to ACTIVE and cleared
     * `cancelAtPeriodEnd`, so the billing page told a customer who had cancelled
     * that they were renewing, and if the provider's own cancellation was also
     * lost they were billed again. An event that happened before the last one we
     * accepted carries no new information.
     */
    if (existing?.lastEventAt && event.occurredAt.getTime() < existing.lastEventAt.getTime()) {
      await tx.auditLog.create({
        data: {
          organizationId,
          action: 'SUBSCRIPTION_UPDATED',
          targetType: 'subscription',
          targetId: event.providerSubscriptionId ?? organizationId,
          detail: {
            event: 'stale_event_ignored',
            providerEventId: event.providerEventId,
            eventOccurredAt: event.occurredAt.toISOString(),
            lastEventAt: existing.lastEventAt.toISOString(),
            requestedPlan: targetPlan,
          },
        },
      });
      return { plan: existing.plan, status: existing.status, stale: true };
    }

    /**
     * The paid period comes from our record when the event omits it.
     *
     * Feeding the payload's `currentPeriodEnd` straight in meant a cancellation
     * webhook that left `current_end` out produced `null`, and `null` reads as
     * "not paid through", so `effectivePlan` returned MOORING and a customer who
     * had paid thirty days was moved to the free tier the moment they cancelled.
     * That contradicts the refund policy's promise that cancelling keeps the paid
     * period, and the very next line below deliberately preserved the stored
     * future date, so the row said "paid until March" while the workspace had
     * already lost the plan.
     */
    const currentPeriodEnd = event.currentPeriodEnd ?? existing?.currentPeriodEnd ?? null;

    // A cancellation or expiry only reduces the plan once the period the
    // customer actually paid for has run out. Until then they keep it, because
    // taking back something already paid for is what generates chargebacks.
    const resolvedPlan = effectivePlan({ plan: targetPlan, status, currentPeriodEnd }, new Date());

    /**
     * `cancelAtPeriodEnd` is only ever turned on, never silently cleared.
     *
     * An ordinary renewal or update payload carries `cancel_at_cycle_end:
     * false`, so overwriting unconditionally undid a real cancellation. Only an
     * event that is genuinely about cancellation is allowed to clear it.
     */
    const cancelAtPeriodEnd =
      event.cancelAtPeriodEnd || (event.type === 'subscription.cancelled' ? false : existing?.cancelAtPeriodEnd ?? false);

    const pendingPlan = existing?.pendingPlan ?? null;
    const pendingPlanInterval = existing?.pendingPlanInterval ?? null;

    /**
     * A pending change is cleared when the plan that arrives IS the one pending.
     *
     * This condition was previously inverted with respect to its own comment:
     * it cleared the marker whenever the arriving plan differed, which is the
     * opposite of the stated intent. For Paddle, where nothing is scheduled at
     * the provider and `pendingPlan` is the only mechanism, a routine renewal
     * reporting the still-current price erased the request. The customer was
     * told "scheduled for cycle end" and kept paying the higher price for ever.
     */
    const arrivingMatchesPending = pendingPlan !== null && resolvedPlan === pendingPlan;
    const keepPending =
      pendingPlan !== null &&
      !arrivingMatchesPending &&
      resolvedPlan !== 'MOORING';

    await tx.subscription.upsert({
      where: { organizationId },
      create: {
        organizationId,
        plan: targetPlan,
        status,
        provider: event.provider,
        providerSubscriptionId: event.providerSubscriptionId,
        currentPeriodEnd,
        cancelAtPeriodEnd,
        lastEventAt: event.occurredAt,
      },
      update: {
        status,
        provider: event.provider,
        ...(event.providerSubscriptionId ? { providerSubscriptionId: event.providerSubscriptionId } : {}),
        ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
        cancelAtPeriodEnd,
        lastEventAt: event.occurredAt,
        ...(keepPending
          ? {}
          : { pendingPlan: null, pendingPlanInterval: null }),
      },
    });

    await writePlan(tx, organizationId, resolvedPlan);

    /**
     * The purchase date, stamped once.
     *
     * The refund policy promises 30 days from the purchase and there was nowhere
     * that recorded when a purchase happened. `BillingEvent` is the wrong place to
     * read it from on demand: those rows are deduplicated and eventually purged, so
     * an eligibility check reading them would quietly start answering differently
     * as the table emptied.
     *
     * Only set when the subscription is actually paid, and never moved afterwards.
     * A renewal is not a new purchase, and a customer who has been subscribed for a
     * year should not gain a fresh 30 day window every month.
     */
    if (existing?.firstChargeAt === null && ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(status)) {
      await tx.subscription.updateMany({
        where: { organizationId, firstChargeAt: null },
        data: { firstChargeAt: event.occurredAt },
      });
    }

    // Dropping a stored asset is the mirror image of never destroying data on a
    // failed payment: a customer must not have their brand left sitting in a
    // bucket after the tier that justified storing it has gone. Only the
    // reference is cleared, never anything the customer owns. Uses the caller's
    // transaction: called on the global client before, so the logo was deleted
    // even when the plan change rolled back.
    if (resolvedPlan !== 'ADMIRALTY') {
      await removeLogoOnDowngrade(organizationId, tx);
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
          providerEventId: event.providerEventId,
          requestedPlan: targetPlan,
          effectivePlan: resolvedPlan,
          status,
          currentPeriodEnd: currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd,
          pendingPlanKept: keepPending ? pendingPlan : null,
          pendingPlanInterval,
        },
      },
    });

    return { plan: resolvedPlan, status, stale: false };
  });

  if (!result) {
    const duplicate = await prisma.subscription.findUnique({
      where: { organizationId: event.organizationId },
      select: { plan: true, status: true },
    });
    return {
      applied: false,
      duplicate: true,
      plan: duplicate?.plan ?? 'MOORING',
      // A workspace whose event was a duplicate but which has no subscription
      // row at all is not in a status the enum models. ACTIVE with MOORING is
      // the honest pairing: nothing is paid, nothing is owed.
      status: duplicate?.status ?? 'ACTIVE',
    };
  }

  return {
    applied: !result.stale,
    duplicate: false,
    plan: result.plan,
    status: result.status,
  };
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

    await writePlan(tx, input.organizationId, input.plan);
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

  /**
   * A subscription the provider no longer recognises is not reconciled to a
   * default.
   *
   * `remote.plan` used to fall back to MOORING, which meant any provider response
   * missing a plan id revoked a paying customer's access. Reconciliation runs
   * unattended on a schedule, so this is the one path that can take a paying
   * workspace to the free tier without a human or a webhook asking for it.
   */
  if (!remote.plan) {
    throw new BillingStateError(
      `The provider reported no plan for subscription ${subscription.providerSubscriptionId}, so no change was applied.`,
      'UNRESOLVED_PLAN',
      422,
    );
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
    // Dated now rather than at the provider's event time: this is a fresh
    // observation of current state, so it must not be rejected as stale by the
    // ordering guard in applyBillingEvent.
    occurredAt: new Date(),
    raw: remote,
  };

  const applied = await applyBillingEvent(event);

  if (applied.duplicate) {
    return { applied: false, duplicate: true, plan: remote.plan, status: statusMap[remote.status] };
  }

  return applied;
}

/**
 * Applies plan changes whose paid period has now ended.
 *
 * Paddle cannot schedule a plan change at all - its ScheduledChangeAction is
 * only cancel, pause or resume - so a downgrade there has no provider-side
 * schedule to wait on. We keep one instead, and this is what applies it.
 *
 * It runs for Razorpay subscriptions too, and that is deliberate rather than
 * redundant: the marker is only cleared when the plan that arrives is the plan
 * that was pending, so a provider that scheduled the change itself converges on
 * the same state instead of fighting it.
 *
 * Once past the period the change is due whatever the provider believes. Holding
 * a customer on a plan they cancelled weeks ago because a webhook was lost is
 * the failure mode the reconciliation job exists to prevent.
 */
export async function applyDuePendingPlans(now = new Date()): Promise<{ applied: number }> {
  const due = await prisma.subscription.findMany({
    where: {
      pendingPlan: { not: null },
      currentPeriodEnd: { not: null, lte: now },
    },
    select: {
      organizationId: true,
      plan: true,
      pendingPlan: true,
      pendingPlanInterval: true,
      provider: true,
      providerSubscriptionId: true,
    },
  });

  let applied = 0;

  for (const subscription of due) {
    const targetPlan = subscription.pendingPlan;
    if (!targetPlan) {
      continue;
    }

    const interval = (subscription.pendingPlanInterval ?? 'MONTHLY').toLowerCase() as 'monthly' | 'annual';

    // The provider is told first. If Paddle refuses, our row must not claim the
    // downgrade happened, because the customer would then be downgraded with
    // nobody paying for it.
    let providerAccepted = true;
    if (subscription.provider !== 'NONE' && subscription.providerSubscriptionId) {
      try {
        const provider = providerFor(subscription.provider as 'RAZORPAY' | 'PADDLE');
        await provider.changePlan({
          providerSubscriptionId: subscription.providerSubscriptionId,
          plan: targetPlan,
          interval,
        });
      } catch {
        providerAccepted = false;
      }
    }

    if (!providerAccepted) {
      await prisma.auditLog.create({
        data: {
          organizationId: subscription.organizationId,
          action: 'SUBSCRIPTION_UPDATED',
          targetType: 'subscription',
          targetId: subscription.providerSubscriptionId ?? subscription.organizationId,
          detail: { event: 'pending_plan_change_failed', from: subscription.plan, to: targetPlan },
        },
      });
      continue;
    }

    /**
     * The claim, both plan records and the audit row move together.
     *
     * The marker was cleared by one statement and the plan written by another,
     * so a crash between them left the request gone and the plan unmoved, and
     * the downgrade silently never happened. The `updateMany` still does the
     * compare-and-set on `pendingPlan`, so two instances racing produce one
     * winner and the loser skips.
     */
    const claimed = await prisma.$transaction(async (tx) => {
      const claim = await tx.subscription.updateMany({
        where: { organizationId: subscription.organizationId, pendingPlan: targetPlan },
        data: { pendingPlan: null, pendingPlanInterval: null },
      });

      // Zero means another instance applied it first, or the request was replaced.
      if (claim.count === 0) {
        return false;
      }

      await writePlan(tx, subscription.organizationId, targetPlan);

      await tx.auditLog.create({
        data: {
          organizationId: subscription.organizationId,
          action: 'SUBSCRIPTION_UPDATED',
          targetType: 'subscription',
          targetId: subscription.providerSubscriptionId ?? subscription.organizationId,
          detail: {
            event: 'pending_plan_applied',
            from: subscription.plan,
            to: targetPlan,
            interval,
            providerAccepted,
          },
        },
      });

      return true;
    });

    if (!claimed) {
      continue;
    }

    applied += 1;
  }

  return { applied };
}
