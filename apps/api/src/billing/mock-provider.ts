import type { PlanTier } from '@prisma/client';
import {
  assertValidQuantity,
  BillingProviderError,
  type BillingContact,
  type BillingInterval,
  type BillingProvider,
  type CheckoutRequest,
  type CheckoutSession,
  type ProviderSubscription,
} from './provider.js';
import { perDomainBill, planCatalog } from '../services/entitlements/plan-catalog.js';

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
  readonly checkouts: (CheckoutRequest & { session: CheckoutSession; priceMinor: number })[] = [];

  /** Every plan change the provider was asked for, so tests can assert quantity. */
  readonly planChanges: Array<{
    providerSubscriptionId: string;
    plan: PlanTier;
    interval: BillingInterval;
    quantity: number;
  }> = [];

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
    assertValidQuantity(input.quantity);

    // A per-domain plan is priced at the unit of the band the quantity bills in.
    const unit =
      planCatalog[input.plan].pricing === 'per_domain'
        ? perDomainBill(input.plan, input.quantity, input.currency).unitMinor
        : planCatalog[input.plan].prices[input.currency][intervalKey(input.interval)];
    const price = unit * input.quantity;

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

    this.checkouts.push({ ...input, session, priceMinor: price });

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
      quantity: checkout.quantity,
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
    quantity: number;
  }): Promise<ProviderSubscription> {
    assertValidQuantity(input.quantity);
    const subscription = this.require(input.providerSubscriptionId);
    const current = subscription.currentPeriodEnd ?? new Date();

    this.planChanges.push({ ...input });

    // The change is scheduled rather than applied, mirroring both providers.
    return {
      ...subscription,
      plan: input.plan,
      quantity: input.quantity,
      currentPeriodEnd: intervalKey(input.interval) === 'annualMinor' ? addYears(current, 1) : addInterval(current, 'monthly'),
    };
  }

  /** Quantity-only changes, recorded so tests can assert the exact count. */
  readonly quantityUpdates: Array<{ providerSubscriptionId: string; quantity: number }> = [];

  /** Test seam: makes the next quantity sync fail at the provider. */
  failQuantityUpdates = false;

  async updateQuantity(input: {
    providerSubscriptionId: string;
    plan: PlanTier;
    quantity: number;
    band?: number;
  }): Promise<void> {
    assertValidQuantity(input.quantity);
    void input.plan;

    if (this.failQuantityUpdates) {
      throw new BillingProviderError('The mock provider refused the quantity change.', 'MOCK_QUANTITY_FAILED', 502);
    }

    const subscription = this.require(input.providerSubscriptionId);
    subscription.quantity = input.quantity;
    this.quantityUpdates.push({
      providerSubscriptionId: input.providerSubscriptionId,
      quantity: input.quantity,
    });
    this.quantityBands.push(input.band ?? null);
  }

  /** The band each quantity update named, in the same order as `quantityUpdates`. */
  readonly quantityBands: Array<number | null> = [];

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

  /**
   * Refunds are recorded rather than ignored, so a test can assert that a refund
   * was actually attempted and with what amount, which is the property that matters
   * on a money path.
   */
  readonly refunds: Array<{ providerSubscriptionId: string; amountMinor: number; reason: string }> = [];

  async refund(input: {
    providerSubscriptionId: string;
    amountMinor: number;
    reason: string;
  }): Promise<{ providerRefundId: string | null }> {
    this.refunds.push({ ...input });
    const subscription = this.require(input.providerSubscriptionId);
    subscription.status = 'cancelled';
    return { providerRefundId: `mock_refund_${this.refunds.length}` };
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
