import type { PlanTier } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { providerFor } from './registry.js';
import { planCatalog, type BillingCurrency } from '../services/entitlements/plan-catalog.js';
import { BillingProviderError } from './provider.js';
import { intervalLabel, resolveBillingInterval } from './interval.js';

/**
 * Refunds against the published 30 day money back guarantee.
 *
 * docs/REFUND-POLICY.md and docs/FAQ.md both promise a 30 day guarantee on every
 * purchase, monthly and annual, no reason required. There was no code path that
 * could honour it, no purchase date to evaluate it against, and no record of a
 * refund having been given, so support answered by opening a provider dashboard
 * and reading an invoice date. A guess is wrong in one of two directions and both
 * are expensive: a customer inside the window refused, or money returned that
 * should not have been.
 *
 * This makes the answer computable. The guarantee window is derived from
 * `Subscription.firstChargeAt`, which is stamped when a subscription is first seen
 * paid and is not derived from a table that is eventually purged.
 *
 * Two deliberate limits. Refunds are staff credentialed rather than a workspace
 * permission, because paying money out is not something a role in the permission
 * table should carry. And the provider call is the authority on whether money
 * actually moved; this records what we promised and what we did, and never reports
 * a refund that the provider did not confirm.
 */

/** The guarantee, in days, as published. */
export const refundGuaranteeDays = 30;

export class RefundError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'RefundError';
    this.code = code;
    this.status = status;
  }
}

export interface RefundEligibility {
  organizationId: string;
  eligible: boolean;
  /** Why not, when it is not. Phrased for a person, not a rule engine. */
  reason: string;
  plan: string;
  currency: BillingCurrency;
  amountMinor: number;
  amountLabel: string;
  /** The purchase this is measured from, or null when we have none on record. */
  firstChargeAt: string | null;
  /** The last moment the guarantee applies, or null when it never did. */
  eligibleUntil: string | null;
  daysSincePurchase: number | null;
  interval: 'monthly' | 'annual';
  /** A refund already issued against this workspace, if any. */
  alreadyRefunded: boolean;
}

/**
 * Answers whether this workspace can be refunded, without moving any money.
 *
 * Safe to call for a support conversation. It is the read half of the feature and
 * the reason support stops guessing.
 */
export async function refundEligibility(
  organizationId: string,
  now = new Date(),
): Promise<RefundEligibility> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      plan: true,
      preferredCurrency: true,
      refunds: {
        where: { eligible: true },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  const subscription = await prisma.subscription.findUnique({
    where: { organizationId },
    select: {
      provider: true,
      providerSubscriptionId: true,
      plan: true,
      firstChargeAt: true,
      // Needed to decide the billing cycle, which is what the refund amount for
      // an annual plan depends on. Not on the row before, which is why annual
      // refunds quoted a month.
      currentPeriodEnd: true,
    },
  });

  const plan = organization?.plan ?? subscription?.plan ?? 'MOORING';
  const currency: BillingCurrency = organization?.preferredCurrency ?? (subscription?.provider === 'PADDLE' ? 'USD' : 'INR');

  // No plan to refund is not an error, it is a workspace that never paid.
  if (plan === 'MOORING' || !subscription?.providerSubscriptionId || subscription.provider === 'NONE') {
    return {
      organizationId,
      eligible: false,
      reason: 'This workspace has never had a paid subscription, so there is nothing to refund.',
      plan,
      currency,
      amountMinor: 0,
      amountLabel: '',
      firstChargeAt: null,
      eligibleUntil: null,
      daysSincePurchase: null,
      interval: 'monthly',
      alreadyRefunded: false,
    };
  }

  /**
   * The purchase date is required, not inferred.
   *
   * Falling back to the subscription's creation would silently start counting from
   * the day the record was created rather than the day the money arrived, which for
   * an annual plan could grant thirty days of guarantee on a charge that happened a
   * year ago.
   */
  const firstChargeAt = subscription.firstChargeAt;
  const eligibleUntil = firstChargeAt ? new Date(firstChargeAt.getTime() + refundGuaranteeDays * 24 * 60 * 60 * 1000) : null;
  const daysSincePurchase = firstChargeAt
    ? Math.floor((now.getTime() - firstChargeAt.getTime()) / (24 * 60 * 60 * 1000))
    : null;

  const alreadyRefunded = organization?.refunds.length !== 0;

  /**
   * The interval is read from the shape of the billing cycle, not assumed.
   *
   * `prices.monthlyMinor` was used unconditionally and `interval` was the
   * literal 'monthly', so an annual Harbor customer who paid 1,24,990 was quoted
   * a refund of 12,499 and shown an amount label of "". Both numbers are the
   * ones a customer compares against their bank statement, and both were wrong
   * for every annual workspace on the platform. See billing/interval.ts for how
   * the interval is derived.
   */
  const { interval } = resolveBillingInterval(subscription.currentPeriodEnd, firstChargeAt, now);
  const prices = planCatalog[subscription.plan as PlanTier].prices[currency];
  const amountMinor = interval === 'annual' ? prices.annualMinor : prices.monthlyMinor;
  const amountLabel = `1 ${intervalLabel(interval)} charge`;

  const base = {
    organizationId,
    plan,
    currency,
    amountMinor,
    amountLabel,
    firstChargeAt: firstChargeAt?.toISOString() ?? null,
    eligibleUntil: eligibleUntil?.toISOString() ?? null,
    daysSincePurchase,
    interval,
    alreadyRefunded,
  };

  if (!firstChargeAt) {
    return {
      ...base,
      eligible: false,
      reason:
        'No completed purchase is on record for this workspace, so the guarantee cannot be evaluated. Check the provider dashboard before deciding.',
    };
  }

  if (alreadyRefunded) {
    return {
      ...base,
      eligible: false,
      reason: 'A refund has already been issued for this workspace.',
    };
  }

  if (now.getTime() > eligibleUntil!.getTime()) {
    return {
      ...base,
      eligible: false,
      reason: `The 30 day guarantee ended on ${eligibleUntil!.toISOString().slice(0, 10)}. Handle this as a goodwill request rather than a guarantee.`,
    };
  }

  return {
    ...base,
    eligible: true,
    reason: `Inside the ${refundGuaranteeDays} day guarantee, which ends on ${eligibleUntil!.toISOString().slice(0, 10)}.`,
  };
}

export interface RefundOutcome {
  refunded: boolean;
  amountMinor: number;
  currency: BillingCurrency;
  providerRefundId: string | null;
  eligibility: RefundEligibility;
}

/**
 * Issues a refund, or refuses with a recorded reason.
 *
 * Idempotent in the way that matters: a workspace that has already been refunded
 * is refused rather than paid twice. The provider's own response is the authority
 * on whether money moved, and a refusal is written down so there is a record of the
 * decision rather than only of the successes.
 */
export async function issueRefund(input: {
  organizationId: string;
  reason: string;
  /** Overrides the published window. Only for an explicit goodwill decision. */
  overrideWindow?: boolean;
  actorUserId?: string | null;
  now?: Date;
}): Promise<RefundOutcome> {
  const now = input.now ?? new Date();
  const eligibility = await refundEligibility(input.organizationId, now);

  const subscription = await prisma.subscription.findUniqueOrThrow({
    where: { organizationId: input.organizationId },
    select: { provider: true, providerSubscriptionId: true, plan: true },
  });

  const record = async (granted: boolean, amountMinor: number, providerRefundId: string | null, refusalReason: string | null) => {
    await prisma.refundRecord.create({
      data: {
        organizationId: input.organizationId,
        providerRefundId,
        provider: subscription.provider,
        amountMinor,
        currency: eligibility.currency,
        plan: subscription.plan,
        firstChargeAt: eligibility.firstChargeAt ? new Date(eligibility.firstChargeAt) : null,
        eligible: granted,
        refusalReason,
        eligibleUntil: eligibility.eligibleUntil ? new Date(eligibility.eligibleUntil) : null,
        reason: input.reason.slice(0, 500),
        actorUserId: input.actorUserId ?? null,
      },
    });

    await recordAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId ?? undefined,
      action: granted ? 'REFUND_ISSUED' : 'REFUND_REFUSED',
      targetType: 'organization',
      targetId: input.organizationId,
      detail: {
        amountMinor,
        currency: eligibility.currency,
        providerRefundId,
        withinGuarantee: eligibility.eligible,
        overriddenWindow: input.overrideWindow ?? false,
        refusalReason,
      },
    });
  };

  if (!eligibility.eligible && !input.overrideWindow) {
    await record(false, 0, null, eligibility.reason);
    throw new RefundError(eligibility.reason, 'REFUND_NOT_ELIGIBLE', 409);
  }

  if (!subscription.providerSubscriptionId || subscription.provider === 'NONE') {
    await record(false, 0, null, 'This workspace has no provider subscription to refund against.');
    throw new RefundError('This workspace has no provider subscription to refund against.', 'NO_SUBSCRIPTION', 409);
  }

  let providerRefundId: string | null;
  try {
    const provider = providerFor(subscription.provider as 'RAZORPAY' | 'PADDLE');
    const result = await provider.refund({
      providerSubscriptionId: subscription.providerSubscriptionId,
      amountMinor: eligibility.amountMinor,
      reason: input.reason,
    });
    providerRefundId = result.providerRefundId;
  } catch (error) {
    const detail = error instanceof BillingProviderError ? error.message : 'The payment provider refused the refund.';
    // Recorded as a refusal. Nothing is claimed about money having moved, because
    // nothing is known about money having moved.
    await record(false, eligibility.amountMinor, null, detail);
    throw new RefundError(detail, 'REFUND_PROVIDER_FAILED', error instanceof BillingProviderError ? error.status : 502);
  }

  await record(true, eligibility.amountMinor, providerRefundId, null);

  return {
    refunded: true,
    amountMinor: eligibility.amountMinor,
    currency: eligibility.currency,
    providerRefundId,
    eligibility,
  };
}