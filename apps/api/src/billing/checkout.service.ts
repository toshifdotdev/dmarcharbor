import type { PlanTier } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { env } from '../config/env.js';
import { planCatalog, type BillingCurrency } from '../services/entitlements/plan-catalog.js';
import type { BillingInterval, ProviderName } from './provider.js';
import { resolveProviderForCheckout } from './registry.js';
import { planSyncReport, requireStoredPlan } from './plans.js';

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

  constructor(message: string, code = 'CHECKOUT_ERROR', status = 400) {
    super(message);
    this.name = 'CheckoutError';
    this.code = code;
    this.status = status;
  }
}

export interface StartCheckoutInput {
  organizationId: string;
  actorUserId?: string | null;
  plan: PlanTier;
  interval: BillingInterval;
  currency: BillingCurrency;
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

  const provider = resolveProviderForCheckout({
    currency: input.currency,
    existingProvider: existing?.provider ?? null,
  });

  // Fails loudly if the provider has no plan for this tier, so a price
  // mismatch cannot reach a customer as a surprise charge.
  const plan = await requireStoredPlan({
    provider: provider.name,
    tier: input.plan,
    interval: input.interval,
    currency: input.currency,
  });

  const session = await provider.createCheckout({
    organizationId: input.organizationId,
    plan: input.plan,
    interval: input.interval,
    currency: input.currency,
    contact: input.contact,
    successUrl: `${env.BETTER_AUTH_URL}/app/billing?checkout=complete`,
    cancelUrl: `${env.BETTER_AUTH_URL}/app/billing?checkout=cancelled`,
    // Carried through to the webhook so the event can be attributed to a
    // workspace without trusting the payload body.
    reference: input.organizationId,
  });

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
      currency: input.currency,
      priceMinor: plan.priceMinor,
    },
  });

  return {
    checkoutId: session.id,
    url: session.url,
    provider: provider.name,
    plan: input.plan,
    interval: input.interval,
    currency: input.currency,
    priceMinor: plan.priceMinor,
    priceLabel: formatLabel(plan.priceMinor, input.currency),
  };
}

/**
 * Moves a workspace to a different plan, effective at the end of the period
 * already paid for. Deliberately not immediate, and deliberately without
 * proration, because a mid cycle charge nobody asked for is the fastest way to
 * earn a chargeback.
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

  const provider = resolveProviderForCheckout({
    currency: 'INR',
    existingProvider: subscription.provider,
  });

  await provider.changePlan({
    providerSubscriptionId: subscription.providerSubscriptionId,
    plan: input.plan,
    interval: input.interval,
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'BILLING_PLAN_CHANGE_REQUESTED',
    targetType: 'subscription',
    targetId: subscription.providerSubscriptionId,
    // The requested plan is recorded, but the workspace's own plan is not
    // changed here. It moves when the provider confirms, at period end.
    detail: { from: subscription.plan, to: input.plan, interval: input.interval, effectiveAt: 'cycle_end' },
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
}> {
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { plan: true, subscription: { select: { status: true, provider: true, currentPeriodEnd: true, cancelAtPeriodEnd: true } } },
  });

  const currency: BillingCurrency = organization.subscription?.provider === 'PADDLE' ? 'USD' : 'INR';
  const prices = planCatalog[organization.plan].prices[currency];

  return {
    plan: organization.plan,
    status: organization.subscription?.status ?? 'ACTIVE',
    provider: organization.subscription?.provider ?? 'NONE',
    currentPeriodEnd: organization.subscription?.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: organization.subscription?.cancelAtPeriodEnd ?? false,
    priceLabel: formatLabel(prices.monthlyMinor, currency),
    currency,
  };
}

/** Tells an operator which provider plans still need creating. */
export async function syncStatus(provider: string, currency: BillingCurrency) {
  return planSyncReport(provider, currency);
}

function formatLabel(minor: number, currency: BillingCurrency): string {
  if (minor === 0) {
    return 'Free';
  }
  const major = minor / 100;
  return currency === 'INR'
    ? `\u20b9${new Intl.NumberFormat('en-IN').format(major)}`
    : `$${new Intl.NumberFormat('en-US').format(major)}`;
}
