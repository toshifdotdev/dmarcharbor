import type { PlanTier } from '@prisma/client';
import {
  BillingProviderError,
  type BillingContact,
  type BillingInterval,
  type BillingProvider,
  type CheckoutRequest,
  type CheckoutSession,
  type ProviderSubscription,
} from './provider.js';
import { planCatalog } from '../services/entitlements/plan-catalog.js';

/**
 * An in-memory stand-in for a real payment provider.
 *
 * It exists so the subscription state machine, dunning and the billing portal
 * can be built and tested before any merchant account exists. Razorpay sandbox
 * keys arrive immediately, but Paddle requires an approved account, and
 * neither should be a prerequisite for writing correct billing logic.
 *
 * The mock is deliberately strict about the two mistakes that cost real money:
 * charging a plan at the wrong price, and starting a second subscription for a
 * workspace that already has one.
 */
export class MockBillingProvider implements BillingProvider {
  /**
   * The mock names itself after Razorpay so a workspace cannot be recorded as
   * being served by a provider that does not exist. It is selected explicitly
   * in tests, never by a customer request, so no real workspace can end up
   * pointing at it.
   */
  readonly name = 'RAZORPAY' as const;

  /** Matches Razorpay, which is what it stands in for. */
  readonly appliesPlanChangeImmediately = false;

  private readonly customers = new Map<string, string>();
  private readonly subscriptions = new Map<string, ProviderSubscription & { organizationId: string }>();
  // Module level rather than per instance, because a real provider issues
  // globally unique ids. Two mock instances sharing an id would collide on the
  // providerSubscriptionId unique constraint and hide real behaviour.
  private static sequence = 0;
  /** Every checkout the provider was asked for, so tests can assert on it. */
  readonly checkouts: (CheckoutRequest & { session: CheckoutSession })[] = [];

  async ensureCustomer(input: { organizationId: string; contact: BillingContact }): Promise<{ providerCustomerId: string }> {
    const existing = this.customers.get(input.organizationId);
    if (existing) {
      return { providerCustomerId: existing };
    }

    const providerCustomerId = `mock_cust_${++MockBillingProvider.sequence}`;
    this.customers.set(input.organizationId, providerCustomerId);
    return { providerCustomerId };
  }

  async createCheckout(input: CheckoutRequest): Promise<CheckoutSession> {
    const price = planCatalog[input.plan].prices[input.currency][intervalKey(input.interval)];

    if (price <= 0) {
      throw new BillingProviderError(
        'A free plan cannot be sent to checkout.',
        'FREE_PLAN_CHECKOUT',
        400,
      );
    }

    const existing = this.findByOrganization(input.organizationId);
    if (existing && existing.status === 'active') {
      throw new BillingProviderError(
        'This workspace already has an active subscription.',
        'ALREADY_SUBSCRIBED',
        409,
      );
    }

    const id = `mock_checkout_${++MockBillingProvider.sequence}`;

    const session: CheckoutSession = {
      id,
      url: `https://checkout.mock.invalid/session/${id}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };

    this.checkouts.push({ ...input, session });

    return session;
  }

  /**
   * Simulates the customer paying, which is what a real `checkout.completed`
   * webhook would report. Tests drive the state machine through this rather
   * than writing subscription rows by hand.
   */
  completeCheckout(sessionId: string, overrides: Partial<{ plan: PlanTier; interval: BillingInterval }> = {}): ProviderSubscription {
    const checkout = this.checkouts.find((entry) => entry.session.id === sessionId);
    if (!checkout) {
      throw new BillingProviderError('No such checkout session.', 'UNKNOWN_SESSION', 404);
    }

    const providerSubscriptionId = `mock_sub_${++MockBillingProvider.sequence}`;
    const interval = overrides.interval ?? checkout.interval;
    const subscription: ProviderSubscription & { organizationId: string } = {
      providerSubscriptionId,
      providerCustomerId: this.customers.get(checkout.organizationId) ?? null,
      plan: overrides.plan ?? checkout.plan,
      status: 'active',
      currentPeriodEnd: addInterval(new Date(), interval),
      cancelAtPeriodEnd: false,
      nextAttemptAt: null,
      organizationId: checkout.organizationId,
    };

    this.subscriptions.set(providerSubscriptionId, subscription);
    return subscription;
  }

  /** Test seam: changes the provider's copy without sending a webhook. */
  forceRemoteState(providerSubscriptionId: string, patch: Partial<ProviderSubscription>): ProviderSubscription {
    const subscription = this.require(providerSubscriptionId);
    Object.assign(subscription, patch);
    return subscription;
  }

  async changePlan(input: {
    providerSubscriptionId: string;
    plan: PlanTier;
    interval: BillingInterval;
  }): Promise<ProviderSubscription> {
    const subscription = this.require(input.providerSubscriptionId);
    const current = subscription.currentPeriodEnd ?? new Date();

    // The change is scheduled rather than applied, mirroring both providers.
    return {
      ...subscription,
      plan: input.plan,
      currentPeriodEnd: intervalKey(input.interval) === 'annualMinor' ? addYears(current, 1) : addInterval(current, 'monthly'),
    };
  }

  async cancelAtPeriodEnd(providerSubscriptionId: string): Promise<void> {
    const subscription = this.require(providerSubscriptionId);
    subscription.cancelAtPeriodEnd = true;
  }

  async resume(providerSubscriptionId: string): Promise<void> {
    const subscription = this.require(providerSubscriptionId);
    subscription.cancelAtPeriodEnd = false;
  }

  async cancelImmediately(providerSubscriptionId: string): Promise<void> {
    const subscription = this.require(providerSubscriptionId);
    subscription.status = 'cancelled';
    subscription.currentPeriodEnd = new Date();
  }

  async fetchSubscription(providerSubscriptionId: string): Promise<ProviderSubscription | null> {
    return this.subscriptions.get(providerSubscriptionId) ?? null;
  }

  async createBillingPortalSession(input: { providerCustomerId: string; returnUrl: string }): Promise<{ url: string }> {
    return { url: `https://billing.mock.invalid/portal/${encodeURIComponent(input.providerCustomerId)}` };
  }

  findByOrganization(organizationId: string): (ProviderSubscription & { organizationId: string }) | null {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.organizationId === organizationId) {
        return subscription;
      }
    }
    return null;
  }

  private require(providerSubscriptionId: string): ProviderSubscription & { organizationId: string } {
    const subscription = this.subscriptions.get(providerSubscriptionId);
    if (!subscription) {
      throw new BillingProviderError('No such subscription.', 'UNKNOWN_SUBSCRIPTION', 404);
    }
    return subscription;
  }
}

function intervalKey(interval: BillingInterval): 'monthlyMinor' | 'annualMinor' {
  return interval === 'monthly' ? 'monthlyMinor' : 'annualMinor';
}

function addInterval(from: Date, interval: BillingInterval): Date {
  if (interval === 'annual') {
    return addYears(from, 1);
  }
  const next = new Date(from);
  next.setMonth(next.getMonth() + 1);
  return next;
}

function addYears(from: Date, years: number): Date {
  const next = new Date(from);
  next.setFullYear(next.getFullYear() + years);
  return next;
}
