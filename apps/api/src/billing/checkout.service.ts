import type { BillingInterval as StoredBillingInterval, PlanTier } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { env } from '../config/env.js';
import {
  planCatalog,
  planOrder,
  type BillingCurrency,
  type QuotaKey,
} from '../services/entitlements/plan-catalog.js';
import { quotaUsage } from '../services/entitlements/entitlement.service.js';
import type { BillingInterval, ProviderName } from './provider.js';
import { resolveProviderForCheckout } from './registry.js';
import { planSyncReport, requireStoredPlan } from './plans.js';
import { resolveBillingInterval } from './interval.js';
import { sendPlanChangedEmail, sendSubscriptionCancelledEmail } from '../email/mailer.js';

/**
 * Checkout orchestration.
 *
 * The one rule this file exists to enforce: nothing marks a workspace as paid
 * because a request arrived. A checkout only produces a URL. The plan changes
 * when a signature verified webhook says the money moved, because a customer
 * closing the tab, a failed bank transfer and a bot replaying a request are all
 * indistinguishable from success if you trust the redirect.
 */

export class CheckoutError extends Error {
  readonly code: string;
  readonly status: number;
  /**
   * Structured version of the message, for screens that need to render the
   * failure rather than print it. A refusal that only exists as prose forces the
   * UI to either show a paragraph or regex the sentence apart to recover the
   * numbers the customer needs in order to fix anything.
   */
  readonly detail?: Record<string, unknown>;

  constructor(message: string, code = 'CHECKOUT_ERROR', status = 400, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'CheckoutError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Position in the ladder, for "is this a move to a smaller plan".
 *
 * Compares by position rather than by price. Price arithmetic on two tiers is a
 * rounding mistake waiting to decide who gets charged more, and the ladder order
 * is the thing the customer actually chose between.
 */
/**
 * Provider modules spell billing intervals lowercase; the database spells them
 * uppercase. Casting between them compiles and silently writes the wrong value,
 * so the conversion is explicit and one-directional.
 */
export function toStoredInterval(interval: BillingInterval): StoredBillingInterval {
  return interval === 'annual' ? 'ANNUAL' : 'MONTHLY';
}

export function quotaRank(plan: PlanTier): number {
  const index = planOrder.indexOf(plan);
  return index === -1 ? 0 : index;
}

export interface StartCheckoutInput {
  organizationId: string;
  actorUserId?: string | null;
  plan: PlanTier;
  interval: BillingInterval;
  /**
   * Optional. When omitted the workspace's stored preference decides, so a
   * currency toggle that forgets to send it on one form cannot silently quote the
   * wrong one.
   */
  currency?: BillingCurrency;
  contact: { name: string; email: string; taxId?: string | null };
  provider?: Exclude<ProviderName, 'NONE'>;
}

export interface CheckoutSummary {
  checkoutId: string;
  url: string;
  provider: string;
  plan: PlanTier;
  interval: BillingInterval;
  currency: BillingCurrency;
  priceMinor: number;
  priceLabel: string;
}

export async function startCheckout(input: StartCheckoutInput): Promise<CheckoutSummary> {
  if (input.plan === 'MOORING') {
    throw new CheckoutError('The free plan does not need a checkout.', 'FREE_PLAN', 400);
  }

  const existing = await prisma.subscription.findUnique({
    where: { organizationId: input.organizationId },
    select: { provider: true, status: true, currentPeriodEnd: true },
  });

  if (existing && (existing.status === 'ACTIVE' || existing.status === 'TRIALING' || existing.status === 'PAST_DUE')) {
    const stillPaid = existing.currentPeriodEnd ? existing.currentPeriodEnd.getTime() > Date.now() : true;
    if (stillPaid) {
      throw new CheckoutError(
        'This workspace already has an active subscription. Change plan instead of buying again.',
        'ALREADY_SUBSCRIBED',
        409,
      );
    }
  }

  // The stored preference decides when the request does not carry one, so a form
  // that omits the field cannot quote a different currency from the one the
  // workspace chose and then be charged in the other.
  const preference = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { preferredCurrency: true },
  });
  const currency = input.currency ?? preference?.preferredCurrency ?? 'INR';

  const provider = resolveProviderForCheckout({
    currency,
    existingProvider: existing?.provider ?? null,
  });

  // Fails loudly if the provider has no plan for this tier, so a price
  // mismatch cannot reach a customer as a surprise charge.
  const plan = await requireStoredPlan({
    provider: provider.name,
    tier: input.plan,
    interval: input.interval,
    currency,
  });

  const session = await provider.createCheckout({
    organizationId: input.organizationId,
    plan: input.plan,
    interval: input.interval,
    currency,
    contact: input.contact,
    // The web app's host, and its real billing route. These pointed at this API's
    // own origin and at a path that does not exist, so a customer who finished
    // paying landed on a 404 and had no way to tell the payment had worked.
    successUrl: `${env.APP_URL}/billing?checkout=complete`,
    cancelUrl: `${env.APP_URL}/billing?checkout=cancelled`,
    // Carried through to the webhook so the event can be attributed to a
    // workspace without trusting the payload body.
    reference: input.organizationId,
  });

  /**
 * Only rewrite the stored preference when the request actually chose a currency.
 *
 * This ran unconditionally with the resolved currency, which meant a request that
 * omitted the field fell back to the stored preference and then wrote that same
 * value back - harmless - but a request that *did* carry a currency, from a form
 * that had not yet been saved, silently changed the workspace's saved preference
 * as a side effect of starting a checkout. Now only an explicit choice persists.
 */
if (input.currency) {
    await prisma.organization.update({
      where: { id: input.organizationId },
      data: { preferredCurrency: input.currency },
    });
  }

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'BILLING_CHECKOUT_STARTED',
    targetType: 'subscription',
    targetId: session.id,
    detail: {
      provider: provider.name,
      plan: input.plan,
      interval: input.interval,
      currency,
      priceMinor: plan.priceMinor,
    },
  });

  return {
    checkoutId: session.id,
    url: session.url,
    provider: provider.name,
    plan: input.plan,
    interval: input.interval,
    // The currency actually charged, which is not necessarily the one requested -
    // the workspace's stored preference wins when the request omits one.
    currency,
    priceMinor: plan.priceMinor,
    priceLabel: formatLabel(plan.priceMinor, currency),
  };
}

/**
 * What a workspace currently uses against a plan it does not hold.
 *
 * Returned as a list rather than a single worst offender so the customer can see
 * everything they have to remove, instead of fixing one limit, being refused
 * again, and discovering the next one.
 */
export interface PlanOverage {
  quota: QuotaKey;
  label: string;
  used: number;
  limit: number;
  by: number;
}

/**
 * Counts what the workspace is using right now, measured against the plan being
 * moved to.
 *
 * Three counts, issued together. Sequential would be three round trips inside a
 * request that is already asking the payment provider to do something, and this
 * is on the path of every downgrade.
 */
async function planOverageFor(
  organizationId: string,
  targetPlan: PlanTier,
): Promise<PlanOverage[]> {
  const [clients, domains, members] = await Promise.all([
    quotaUsage(organizationId, 'client', targetPlan),
    quotaUsage(organizationId, 'activeDomain', targetPlan),
    quotaUsage(organizationId, 'member', targetPlan),
  ]);

  const counted: { quota: QuotaKey; label: string; used: number; limit: number }[] = [
    { quota: 'client', label: 'clients', ...clients },
    { quota: 'activeDomain', label: 'active domains', ...domains },
    { quota: 'member', label: 'members', ...members },
  ];

  return counted
    .filter((entry) => entry.used > entry.limit)
    .map((entry): PlanOverage => ({ ...entry, by: entry.used - entry.limit }));
}

/**
 * Moves a workspace to a different plan, effective at the end of the period
 * already paid for. Deliberately not immediate, and deliberately without
 * proration, because a mid cycle charge nobody asked for is the fastest way to
 * earn a chargeback.
 *
 * A downgrade is refused when the workspace is already larger than the plan it is
 * moving to. Twelve clients on Harbor moving to Fairway, which allows five,
 * cannot happen by accident: it would leave every one of the twelve running on a
 * plan that does not include them, and the mismatch would stay invisible because
 * nothing else reports it. The refusal names the overage so the customer can act
 * on it, which is the only reason refusing is better than allowing it.
 */
export async function changePlan(input: {
  organizationId: string;
  actorUserId?: string | null;
  plan: PlanTier;
  interval: BillingInterval;
}): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: input.organizationId },
    select: { provider: true, providerSubscriptionId: true, plan: true, status: true, currentPeriodEnd: true },
  });

  if (!subscription?.providerSubscriptionId || subscription.provider === 'NONE') {
    throw new CheckoutError('This workspace has no subscription to change.', 'NO_SUBSCRIPTION', 409);
  }

  const paidThrough = subscription.currentPeriodEnd ? subscription.currentPeriodEnd.getTime() > Date.now() : false;
  if (!paidThrough && subscription.status !== 'ACTIVE') {
    throw new CheckoutError(
      'This subscription has lapsed. Start a new checkout rather than changing plan.',
      'SUBSCRIPTION_LAPSED',
      409,
    );
  }

  // Only a move to a smaller plan can be over quota. Counting usage for an
  // upgrade would refuse a purchase, which is the opposite of what we want.
  if (quotaRank(input.plan) < quotaRank(subscription.plan)) {
    const overage = await planOverageFor(input.organizationId, input.plan);

    if (overage.length > 0) {
      const detail = overage
        .map((entry) => `${entry.label}: ${entry.used} of ${entry.limit} (${entry.by} over)`)
        .join('; ');

      // Recorded before anything is refused, because "why did my downgrade fail"
      // is a question about an event that otherwise leaves no trace at all.
      await recordAuditEvent({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId ?? undefined,
        action: 'BILLING_PLAN_CHANGE_REFUSED',
        targetType: 'subscription',
        targetId: subscription.providerSubscriptionId,
        detail: { from: subscription.plan, to: input.plan, overage },
      });

      throw new CheckoutError(
        `${planCatalog[input.plan].label} allows ${overage
          .map((entry) => `${entry.limit} ${entry.label}`)
          .join(' and ')}, and this workspace has ${detail}. Remove the excess, or keep the current plan.`,
        'PLAN_CHANGE_OVER_QUOTA',
        409,
        { overage, from: subscription.plan, to: input.plan },
      );
    }
  }

  // Resolved after the quota guard on purpose. The guard needs no provider and
  // answers the question the customer actually asked, so resolving first meant an
  // over-quota downgrade with no provider configured returned "payments are not
  // available yet" instead of naming the clients they have too many of.
  const provider = resolveProviderForCheckout({
    currency: 'INR',
    existingProvider: subscription.provider,
  });

  await provider.changePlan({
    providerSubscriptionId: subscription.providerSubscriptionId,
    plan: input.plan,
    interval: input.interval,
  });

  /**
   * The marker is left only when the provider will not apply the change yet.
   *
   * It used to be written unconditionally after `changePlan` returned without
   * throwing. For Paddle that was actively harmful: the provider had already
   * applied the change immediately, and a marker saying "pending until cycle end"
   * survived, so a later `applyDuePendingPlans` run re-applied a downgrade the
   * customer may have upgraded away from since. The marker describes a future
   * the provider is not going to act on.
   *
   * When the change is already live, the plan is written here rather than waiting
   * for the confirmation webhook. That webhook still arrives and re-applies the
   * same value, so this is idempotent, and it means a customer who downgrades on
   * Paddle sees the plan change immediately instead of waiting for a delivery we
   * do not control.
   */
  if (provider.appliesPlanChangeImmediately) {
    await prisma.$transaction(async (tx) => {
      await tx.organization.update({ where: { id: input.organizationId }, data: { plan: input.plan } });
      await tx.subscription.updateMany({ where: { organizationId: input.organizationId }, data: { plan: input.plan } });
      await tx.subscription.update({
        where: { organizationId: input.organizationId },
        data: { pendingPlan: null, pendingPlanInterval: null },
      });
    });
  } else {
    // Recorded only after the provider accepted the change, so our row can never
    // claim a scheduled change the provider refused. Cleared by applyBillingEvent
    // when the plan actually moves.
    await prisma.subscription.update({
      where: { organizationId: input.organizationId },
      data: {
        pendingPlan: input.plan,
        pendingPlanInterval: toStoredInterval(input.interval),
      },
    });
  }

  // Told at the moment of the request, not when it takes effect, so nobody
  // discovers a plan change by losing a feature.
  if (subscription.currentPeriodEnd) {
    void sendPlanChangedEmail({
      organizationId: input.organizationId,
      fromPlan: subscription.plan,
      toPlan: input.plan,
      effectiveAt: provider.appliesPlanChangeImmediately ? new Date() : subscription.currentPeriodEnd,
    });
  }

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'BILLING_PLAN_CHANGE_REQUESTED',
    targetType: 'subscription',
    targetId: subscription.providerSubscriptionId,
    // The requested plan is recorded either way. Whether the workspace's own plan
    // moves now or at period end is `appliesPlanChangeImmediately`.
    detail: {
      from: subscription.plan,
      to: input.plan,
      interval: input.interval,
      provider: provider.name,
      effectiveAt: provider.appliesPlanChangeImmediately ? 'immediate' : 'cycle_end',
    },
  });
}

export async function cancelSubscription(input: { organizationId: string; actorUserId?: string | null }): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: input.organizationId },
    select: { provider: true, providerSubscriptionId: true, plan: true, currentPeriodEnd: true },
  });

  if (!subscription?.providerSubscriptionId || subscription.provider === 'NONE') {
    throw new CheckoutError('This workspace has no subscription to cancel.', 'NO_SUBSCRIPTION', 409);
  }

  const provider = resolveProviderForCheckout({ currency: 'INR', existingProvider: subscription.provider });
  await provider.cancelAtPeriodEnd(subscription.providerSubscriptionId);

  // The plan is deliberately left alone. It survives until currentPeriodEnd,
  // then the provider's expiry webhook drops the workspace to free.
  await prisma.subscription.update({
    where: { organizationId: input.organizationId },
    data: { cancelAtPeriodEnd: true },
  });

  if (subscription.currentPeriodEnd) {
    void sendSubscriptionCancelledEmail({
      organizationId: input.organizationId,
      plan: subscription.plan,
      accessUntil: subscription.currentPeriodEnd,
    });
  }

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'BILLING_CANCELLED',
    targetType: 'subscription',
    targetId: subscription.providerSubscriptionId,
    detail: { plan: subscription.plan, accessUntil: subscription.currentPeriodEnd?.toISOString() ?? null, effectiveAt: 'cycle_end' },
  });
}

export async function resumeSubscription(input: { organizationId: string; actorUserId?: string | null }): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: input.organizationId },
    select: { provider: true, providerSubscriptionId: true, plan: true },
  });

  if (!subscription?.providerSubscriptionId || subscription.provider === 'NONE') {
    throw new CheckoutError('This workspace has no subscription to resume.', 'NO_SUBSCRIPTION', 409);
  }

  const provider = resolveProviderForCheckout({ currency: 'INR', existingProvider: subscription.provider });
  await provider.resume(subscription.providerSubscriptionId);

  await prisma.subscription.update({
    where: { organizationId: input.organizationId },
    data: { cancelAtPeriodEnd: false },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'BILLING_RESUMED',
    targetType: 'subscription',
    targetId: subscription.providerSubscriptionId,
    detail: { plan: subscription.plan },
  });
}

export async function billingPortalUrl(input: { organizationId: string; returnUrl: string }): Promise<string> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: input.organizationId },
    select: { provider: true, providerCustomerId: true },
  });

  if (!subscription?.providerCustomerId || subscription.provider === 'NONE') {
    throw new CheckoutError('This workspace has no billing account yet.', 'NO_BILLING_ACCOUNT', 409);
  }

  const provider = resolveProviderForCheckout({ currency: 'INR', existingProvider: subscription.provider });
  const session = await provider.createBillingPortalSession({
    providerCustomerId: subscription.providerCustomerId,
    returnUrl: input.returnUrl,
  });

  return session.url;
}

/** What the workspace is actually on right now, for the billing screen. */
export async function billingStatus(organizationId: string): Promise<{
  plan: PlanTier;
  status: string;
  provider: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  priceLabel: string;
  currency: BillingCurrency;
  /**
   * The plan that applies when the paid period ends, or null when nothing is
   * scheduled. Distinct from `plan`: a workspace can be on Fairway with
   * Admiralty pending, and a screen showing only one of the two is either
   * hiding a downgrade or hiding an upgrade.
   */
  pendingPlan: { plan: PlanTier; interval: StoredBillingInterval; effectiveAt: string | null } | null;
  dunningStage: 'NONE' | 'WARNED' | 'WITHDRAWN';
  /** When a failed payment stops being forgiven. Null when nothing is failing. */
  graceEnds: string | null;
  /** The interval actually being billed, so the price below matches it. */
  interval: StoredBillingInterval;
}> {
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: {
      plan: true,
      preferredCurrency: true,
      subscription: {
        select: {
          status: true,
          provider: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          pendingPlan: true,
          pendingPlanInterval: true,
          firstChargeAt: true,
          dunningStage: true,
          graceEndsAt: true,
        },
      },
    },
  });

  /**
   * The currency comes from the stored preference, not from the provider.
   *
   * Deriving it from the provider meant the billing screen could quote a
   * different currency from the one the customer actually pays in, which is the
   * one number on that screen they will compare against their bank statement.
   */
  const currency: BillingCurrency =
    organization.preferredCurrency ?? (organization.subscription?.provider === 'PADDLE' ? 'USD' : 'INR');

  const periodEnd = organization.subscription?.currentPeriodEnd ?? null;
  /**
   * The price for the interval being billed.
   *
   * This reported `monthlyMinor` unconditionally, so an annual Harbor customer
   * who paid 1,24,990 was shown "12,499" on their own billing page: the
   * screen understated the charge by ten times, in the one number they use to
   * check whether they have been overcharged. The interval now comes from that
   * shared resolver rather than a local guess, and `refundEligibility` reads the
   * same one, because quoting an annual refund from a monthly price is the same
   * defect on a screen that moves money.
   */
  const resolved = resolveBillingInterval(
    periodEnd,
    organization.subscription?.firstChargeAt ?? null,
    new Date(),
  );
  const interval = toStoredInterval(resolved.interval);

  const prices = planCatalog[organization.plan].prices[currency];

  return {
    plan: organization.plan,
    status: organization.subscription?.status ?? 'ACTIVE',
    provider: organization.subscription?.provider ?? 'NONE',
    currentPeriodEnd: periodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: organization.subscription?.cancelAtPeriodEnd ?? false,
    /**
     * The price for the interval being billed.
     *
     * This reported `monthlyMinor` unconditionally, so an annual Harbor customer
     * who paid 1,24,990 was shown "12,499" on their own billing page: the
     * screen understated the charge by ten times, in the one number they use to
     * check whether they have been overcharged.
     */
    priceLabel: formatLabel(interval === 'ANNUAL' ? prices.annualMinor : prices.monthlyMinor, currency),
    currency,
    interval,
    pendingPlan: organization.subscription?.pendingPlan
      ? {
          plan: organization.subscription.pendingPlan,
          interval: organization.subscription.pendingPlanInterval ?? 'MONTHLY',
          effectiveAt: periodEnd?.toISOString() ?? null,
        }
      : null,
    dunningStage: organization.subscription?.dunningStage ?? 'NONE',
    graceEnds: organization.subscription?.graceEndsAt?.toISOString() ?? null,
  };
}

/** Tells an operator which provider plans still need creating. */
export async function syncStatus(provider: string, currency: BillingCurrency) {
  return planSyncReport(provider, currency);
}

/**
 * Formats a minor-unit amount for display.
 *
 * Integer arithmetic throughout. Dividing by 100 produces a float, and a display
 * string that depends on float rounding is a string that can be wrong by a cent at
 * some price. Money is stored in minor units precisely so that this never has to
 * happen.
 */
function formatLabel(minor: number, currency: BillingCurrency): string {
  if (minor === 0) {
    return 'Free';
  }

  const negative = minor < 0;
  const absolute = Math.abs(Math.trunc(minor));
  const units = Math.trunc(absolute / 100);
  const cents = absolute % 100;

  const formatter = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    minimumFractionDigits: cents === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });

  const grouped = formatter.format(units);
  const body = cents === 0 ? grouped : `${grouped}.${String(cents).padStart(2, '0')}`;

  const signed = negative ? `-${body}` : body;
  return currency === 'INR' ? `\u20b9${signed}` : `$${signed}`;
}

/**
 * Reads the currency a workspace is quoted in, and whether it can still change.
 *
 * `locked` is reported rather than enforced only on write, so the settings screen
 * can disable the control and say why instead of accepting a value and failing.
 */
export async function billingCurrencyPreference(organizationId: string): Promise<{
  preferredCurrency: BillingCurrency;
  locked: boolean;
  reason: string | null;
}> {
  const [organization, subscription] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: { preferredCurrency: true },
    }),
    prisma.subscription.findUnique({
      where: { organizationId },
      select: { provider: true, providerSubscriptionId: true, status: true, currentPeriodEnd: true },
    }),
  ]);

  /**
   * Locked unless the subscription is definitively over.
   *
   * The old test was `status !== 'CANCELLED'`, which unlocked a workspace that
   * had cancelled but still had paid time left: flipping currency then meant a
   * live subscription being charged in one currency by one processor while the
   * workspace quoted another. Today that is only inert because
   * `resolveProviderForCheckout` happens to prefer the existing provider, which
   * is an accident rather than a decision.
   *
   * What is being protected is the remaining paid period, so that is the test. A
   * cancelled subscription with no recorded period end is treated as finished,
   * which is what "cancelled" means to the person who cancelled it, and an
   * unknown end date on a live subscription is treated as paid, because guessing
   * "free" in favour of a migration is how a customer gets moved mid period.
   */
  const periodStillRunning =
    subscription?.currentPeriodEnd != null && subscription.currentPeriodEnd.getTime() > Date.now();

  const hasLiveSubscription = Boolean(subscription?.providerSubscriptionId) && subscription?.provider !== 'NONE';

  const definitivelyOver =
    (subscription?.status === 'CANCELLED' || subscription?.status === 'EXPIRED') && !periodStillRunning;

  const paid = hasLiveSubscription && !definitivelyOver;

  return {
    preferredCurrency: organization?.preferredCurrency ?? 'INR',
    locked: paid,
    reason: paid
      ? 'Changing currency means moving this subscription to a different payment processor, so it is fixed once a payment exists.'
      : null,
  };
}

/**
 * Sets the currency a future checkout will use.
 *
 * Refused once a payment exists. The currency is not a display preference: INR
 * routes to Razorpay and USD to Paddle, so changing it means migrating a live
 * subscription between two processors. That is a customer-facing migration with
 * its own failure modes, and offering it as a settings toggle would imply it is
 * as reversible as changing a spelling.
 */
export async function setBillingCurrencyPreference(input: {
  organizationId: string;
  currency: BillingCurrency;
}): Promise<{ preferredCurrency: BillingCurrency; locked: boolean; reason: string | null }> {
  const current = await billingCurrencyPreference(input.organizationId);

  if (current.locked) {
    throw new CheckoutError(
      current.reason ?? 'The currency cannot be changed once a payment exists.',
      'CURRENCY_LOCKED',
      409,
    );
  }

  await prisma.organization.update({
    where: { id: input.organizationId },
    data: { preferredCurrency: input.currency },
  });

  return { ...current, preferredCurrency: input.currency };
}
