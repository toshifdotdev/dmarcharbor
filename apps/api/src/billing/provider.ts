import type { PlanTier } from '@prisma/client';
import type { BillingCurrency } from '../services/entitlements/plan-catalog.js';

/**
 * The one boundary between DMARC Harbor and a payment provider.
 *
 * Everything above this interface is provider agnostic, and everything below
 * it is a vendor detail. That matters because the two providers disagree about
 * almost everything: Razorpay is a payment processor with Indian rails, UPI and
 * INR settlement, while Paddle is a merchant of record that is the legal
 * seller, handles global tax and issues its own invoices. Neither shape leaks
 * past this file, so adding a third provider is a new adapter rather than a
 * change to checkout, webhooks or the subscription state machine.
 */

export type BillingInterval = 'monthly' | 'annual';

/** Which provider a workspace is served by. `NONE` is the free plan. */
export type ProviderName = 'NONE' | 'RAZORPAY' | 'PADDLE';

export interface BillingContact {
  name: string;
  email: string;
  /**
   * Indian businesses buying above the registration threshold need a GSTIN on
   * the invoice. Optional because many agencies bill from a sole proprietorship
   * or from outside India entirely.
   */
  taxId?: string | null;
  country?: string | null;
}

export interface CheckoutRequest {
  organizationId: string;
  plan: PlanTier;
  interval: BillingInterval;
  currency: BillingCurrency;
  contact: BillingContact;
  /**
   * Where the provider sends the customer once payment succeeds. Paddle hosts
   * its own confirmation page, so this is ignored by providers that render
   * everything themselves.
   */
  successUrl: string;
  cancelUrl: string;
  /**
   * Opaque value echoed back on the webhook, used to attribute a subscription
   * to a workspace without trusting anything in the request body.
   */
  reference: string;
}

export interface CheckoutSession {
  /** Provider's identifier for this checkout attempt, used to look it up later. */
  id: string;
  /** Hosted page the customer is sent to. Never contains card data handling on our side. */
  url: string;
  expiresAt?: Date | null;
}

export interface ProviderSubscription {
  providerSubscriptionId: string;
  providerCustomerId: string | null;
  /**
   * Null when the provider's plan id cannot be resolved in our catalog.
   *
   * Deliberately not defaulted to the free tier. A null here means our catalog
   * and the provider have diverged, and the only safe response is to change
   * nothing; defaulting it silently revoked paying customers' access from the
   * unattended reconciliation job.
   */
  plan: PlanTier | null;
  status: ProviderSubscriptionStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Present when the provider has already taken a payment that failed to settle. */
  nextAttemptAt?: Date | null;
}

/**
 * A provider's own vocabulary for subscription state, deliberately kept
 * separate from our own. Mapping happens in the adapter, because a raw provider
 * string must never be written straight into our database.
 */
export type ProviderSubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'cancelled' | 'expired' | 'paused';

export interface BillingProvider {
  readonly name: Exclude<ProviderName, 'NONE'>;

  /**
   * Whether `changePlan` takes effect at the provider now, or only at the end of
   * the paid period.
   *
   * Razorpay schedules a price change for the next cycle and keeps billing the
   * old price until then. Paddle cannot schedule a price change at all, so the
   * only honest implementation is to apply it immediately and let Paddle prorate
   * the credit.
   *
   * This distinction was previously carried implicitly, and wrongly: Paddle's
   * `changePlan` used to return the live subscription untouched for a downgrade,
   * which the caller read as acceptance. So we granted the cheaper plan while
   * Paddle kept billing the dearer one. The caller needs this flag to know
   * whether a marker should be left for `applyDuePendingPlans` to apply later.
   */
  readonly appliesPlanChangeImmediately: boolean;

  /**
   * Creates or reuses a customer record. Idempotent by organisation, so calling
   * it on every checkout attempt is safe and does not create duplicates.
   */
  ensureCustomer(input: { organizationId: string; contact: BillingContact }): Promise<{ providerCustomerId: string }>;

  /**
   * Starts a subscription and returns a hosted checkout URL.
   *
   * The subscription is not treated as paid by this call. Nothing in our
   * database changes until a verified webhook says the money arrived, because
   * a customer closing the tab mid-redirect is normal and must not leave a
   * half active subscription behind.
   */
  createCheckout(input: CheckoutRequest): Promise<CheckoutSession>;

  /**
   * Moves an existing subscription to a different plan.
   *
   * Whether that is now or at period end is `appliesPlanChangeImmediately`.
   */
  changePlan(input: {
    providerSubscriptionId: string;
    plan: PlanTier;
    interval: BillingInterval;
  }): Promise<ProviderSubscription>;

  /**
   * Cancels at the end of the paid period. The customer keeps what they paid
   * for, so this is never a downgrade to zero before the period ends.
   */
  cancelAtPeriodEnd(providerSubscriptionId: string): Promise<void>;

  /** Undoes a pending cancellation before the period ends. */
  resume(providerSubscriptionId: string): Promise<void>;

  /** Cancels immediately, used only when a payment has failed past recovery. */
  cancelImmediately(providerSubscriptionId: string): Promise<void>;

  /**
   * Refunds money back through the provider.
   *
   * Exists because the refund policy promises a 30 day money back guarantee on every
   * purchase and there was no code path that could honour it. Doing it from a
   * provider dashboard by hand also left no record here, so a second request for the
   * same purchase had nothing to detect.
   *
   * Takes an amount rather than refunding the whole charge, because an annual
   * purchase part way through its term is a partial refund unless we decide
   * otherwise, and that decision belongs to the caller rather than to a provider
   * default. Returns the provider's own refund identifier so a repeat call can be
   * recognised rather than paid twice.
   */
  refund(input: {
    providerSubscriptionId: string;
    amountMinor: number;
    reason: string;
  }): Promise<{ providerRefundId: string | null }>;

  /** Current state as the provider sees it, used to reconcile drift. */
  fetchSubscription(providerSubscriptionId: string): Promise<ProviderSubscription | null>;

  /** Hosted page where a customer can update their card, invoice or plan. */
  createBillingPortalSession(input: { providerCustomerId: string; returnUrl: string }): Promise<{ url: string }>;
}

/**
 * A provider event after its signature has been verified and its payload
 * mapped onto our own vocabulary. Adapters produce this, the state machine
 * consumes it, and nothing provider shaped reaches the database.
 */
export type BillingEventType =
  | 'checkout.completed'
  | 'subscription.activated'
  | 'subscription.updated'
  | 'subscription.past_due'
  | 'subscription.cancelled'
  | 'subscription.expired'
  | 'payment.failed';

export interface BillingEvent {
  /** Provider's unique event id. Retried deliveries reuse it, so this is the deduplication key. */
  providerEventId: string;
  type: BillingEventType;
  /** Which provider sent this, so the stored event keeps its origin. */
  provider: Exclude<ProviderName, 'NONE'>;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  /** Our organisation, resolved from the reference we supplied at checkout. */
  organizationId: string | null;
  plan: PlanTier | null;
  status: ProviderSubscriptionStatus | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  nextAttemptAt: Date | null;
  occurredAt: Date;
  /** Raw provider payload, retained for support and audit, never trusted. */
  raw: unknown;
}

export class BillingProviderError extends Error {
  readonly code: string;
  readonly status: number;
  /** Structured companion to the message, for screens that render the failure. */
  readonly detail?: Record<string, unknown>;

  constructor(message: string, code = 'PROVIDER_ERROR', status = 502, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'BillingProviderError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export class SignatureVerificationError extends Error {
  constructor(message = 'The billing webhook signature could not be verified.') {
    super(message);
    this.name = 'SignatureVerificationError';
  }
}
