import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { providerFor } from './registry.js';
import { reconcileWithProvider } from './subscription-state.js';
import { effectivePlan } from '../services/entitlements/plan-catalog.js';

/**
 * Recovers failed payments and repairs drift against the provider.
 *
 * Two separate jobs share this file because they answer the same question from
 * opposite directions. Dunning looks at what we know is unpaid. The reconciler
 * asks the provider what it thinks, which is the only way to notice a webhook
 * that never arrived.
 *
 * The rule that matters in both: a customer whose card fails keeps what they
 * have paid for, and losing a payment never destroys their data. Worst case a
 * workspace drops to the free plan with everything intact, and upgrading brings
 * all of it back.
 */

/** How long a past due subscription is given before the plan is withdrawn. */
export const dunningGraceDays = 7;

export interface DunningOutcome {
  examined: number;
  warned: number;
  downgraded: number;
}

export interface ReconcileOutcome {
  examined: number;
  repaired: number;
  unreachable: number;
}

/**
 * Examines past due subscriptions and acts on the ones that have exhausted
 * their grace.
 *
 * Both providers retry a failed card on their own schedule, so this does not
 * charge anything. It records a warning and, once the grace is gone, withdraws
 * the plan. Anything that would touch a payment method is deliberately left to
 * the provider, which is the only party that can safely retry it.
 */
export async function runDunning(now = new Date()): Promise<DunningOutcome> {
  const pastDue = await prisma.subscription.findMany({
    where: { status: 'PAST_DUE' },
    select: {
      organizationId: true,
      plan: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      organization: { select: { plan: true, name: true } },
    },
  });

  const outcome: DunningOutcome = { examined: pastDue.length, warned: 0, downgraded: 0 };

  for (const subscription of pastDue) {
    const periodEndMs = subscription.currentPeriodEnd ? subscription.currentPeriodEnd.getTime() : 0;
    const paidThrough = periodEndMs > now.getTime();
    const pastDueMs = now.getTime() - periodEndMs;

    // They have paid for the period they are in, so access is untouched and
    // the provider may simply be retrying.
    if (paidThrough) {
      continue;
    }

    // The period has ended and the payment has not recovered. A short grace
    // follows, because most failed cards succeed on the next retry and
    // withdrawing a plan over a transient decline is how you lose a customer.
    if (pastDueMs < dunningGraceDays * 24 * 60 * 60 * 1000) {
      outcome.warned += 1;
      await recordAuditEvent({
        organizationId: subscription.organizationId,
        action: 'PAYMENT_FAILED',
        targetType: 'subscription',
        targetId: subscription.organizationId,
        detail: {
          stage: 'grace',
          plan: subscription.plan,
          periodEnded: subscription.currentPeriodEnd?.toISOString() ?? null,
          graceEnds: new Date(now.getTime() + (dunningGraceDays * 24 * 60 * 60 * 1000 - pastDueMs)).toISOString(),
          note: 'Access retained while the payment is retried.',
        },
      });
      continue;
    }

    await withdrawPlan(subscription.organizationId, subscription.plan, 'dunning');
    outcome.downgraded += 1;
  }

  return outcome;
}

/**
 * Drops a workspace to the free plan without touching any of its data.
 *
 * The subscription row is kept rather than deleted, deliberately: it is the
 * evidence of what was paid for, it is what the provider's identifiers hang
 * off, and deleting it would break reconciliation for a customer who upgrades
 * again. Data is never removed here. That is a separate, explicitly requested
 * action.
 */
async function withdrawPlan(organizationId: string, previousPlan: string, reason: 'dunning' | 'expired' | 'reconciled'): Promise<void> {
  await prisma.$transaction([
    prisma.organization.update({ where: { id: organizationId }, data: { plan: 'MOORING' } }),
    prisma.subscription.update({
      where: { organizationId },
      data: { status: reason === 'expired' ? 'EXPIRED' : 'PAST_DUE', plan: 'MOORING' },
    }),
  ]);

  await recordAuditEvent({
    organizationId,
    action: 'SUBSCRIPTION_UPDATED',
    targetType: 'subscription',
    targetId: organizationId,
    detail: {
      previousPlan,
      newPlan: 'MOORING',
      reason,
      dataRetained: true,
      note: 'The workspace keeps all of its clients, domains and reports. Upgrading restores the previous plan.',
    },
  });
}

/**
 * Compares every active subscription against the provider.
 *
 * This is the safety net for webhooks that never arrive. A provider retries
 * several times and then gives up, so a lost event is permanent unless something
 * asks. Without this, a customer who upgraded and whose webhook was dropped
 * would have paid and stayed on the free plan, and a customer whose recurring
 * payment stopped would keep paid features indefinitely without anyone noticing.
 */
export async function runReconciliation(): Promise<ReconcileOutcome> {
  const subscriptions = await prisma.subscription.findMany({
    where: { provider: { not: 'NONE' }, providerSubscriptionId: { not: null } },
    select: { organizationId: true, provider: true, plan: true, currentPeriodEnd: true },
  });

  const outcome: ReconcileOutcome = { examined: subscriptions.length, repaired: 0, unreachable: 0 };

  for (const subscription of subscriptions) {
    let provider;
    try {
      provider = providerFor(subscription.provider as 'RAZORPAY' | 'PADDLE');
    } catch {
      outcome.unreachable += 1;
      continue;
    }

    try {
      const result = await reconcileWithProvider(subscription.organizationId, provider);

      if (!result) {
        // The provider has no record of a subscription we think is live. The
        // workspace keeps the plan until its paid period actually ends, then
        // falls back, which is the same rule a cancellation follows.
        const stillPaid = effectivePlan(
          { plan: subscription.plan, status: 'CANCELLED', currentPeriodEnd: subscription.currentPeriodEnd },
          new Date(),
        );

        if (stillPaid === 'MOORING' && subscription.plan !== 'MOORING') {
          await withdrawPlan(subscription.organizationId, subscription.plan, 'reconciled');
        }
        outcome.repaired += 1;
        continue;
      }

      if (result.applied && result.plan !== subscription.plan) {
        outcome.repaired += 1;
      }
    } catch {
      // A provider outage must not stop reconciliation for every other
      // workspace, so one failure is counted and the loop continues.
      outcome.unreachable += 1;
    }
  }

  return outcome;
}
