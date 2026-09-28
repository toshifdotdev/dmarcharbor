import { env } from '../config/env.js';
import Razorpay from 'razorpay';
import {
  BillingProviderError,
  SignatureVerificationError,
  type BillingContact,
  type BillingInterval,
  type BillingProvider,
  type CheckoutRequest,
  type CheckoutSession,
  type ProviderSubscription,
  type ProviderSubscriptionStatus,
} from './provider.js';
import { expectedPlans, findStoredPlan, findStoredPlanByProviderPlanId, requireStoredPlan, saveStoredPlan } from './plans.js';
import { prisma } from '../database/prisma.js';
import type { PlanTier } from '@prisma/client';

/**
 * Razorpay adapter.
 *
 * Razorpay is an Indian payment processor, not a merchant of record. It takes
 * the money and settles INR into an Indian bank account, which suits an India
 * based seller, but it means we are the seller of record for international
 * sales and carry the tax obligation ourselves.
 *
 * Every amount is the smallest currency unit, so 7900 is 79.00 USD and 659900
 * is 6599.00 INR. Nothing here handles a decimal amount, because a rounding
 * error is a real charge to a real customer.
 *
 * Written against the official SDK rather than raw HTTP so the request
 * serialisation, error shape and webhook signature check are the vendor's
 * responsibility rather than ours.
 */

let client: Razorpay | null = null;

function razorpay(): Razorpay {
  if (client) {
    return client;
  }

  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new BillingProviderError(
      'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
      'PROVIDER_NOT_CONFIGURED',
      503,
    );
  }

  client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  return client;
}

export function razorpayConfigured(): boolean {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

/** Razorpay's own vocabulary, mapped onto ours. The SDK's union is narrower than
 * the statuses the API can actually return, so this is a string lookup. */
const statusMap: Record<string, ProviderSubscriptionStatus> = {
  created: 'active',
  authenticated: 'active',
  active: 'active',
  pending: 'past_due',
  halted: 'past_due',
  cancelled: 'cancelled',
  completed: 'expired',
  expired: 'expired',
};

interface RazorpaySubscriptionLike {
  id: string;
  status?: string | null;
  plan_id?: string | null;
  customer_id?: string | null;
  current_end?: number | null;
  cancel_at_cycle_end?: boolean | null;
  short_url?: string | null;
}

export class RazorpayBillingProvider implements BillingProvider {
  readonly name = 'RAZORPAY' as const;

  private async findCustomer(organizationId: string): Promise<string | null> {
    const row = await prisma.subscription.findFirst({
      where: { organizationId, provider: 'RAZORPAY', providerCustomerId: { not: null } },
      select: { providerCustomerId: true },
    });
    return row?.providerCustomerId ?? null;
  }

  /** Idempotent by organisation, so a retried checkout never creates a second customer. */
  async ensureCustomer(input: { organizationId: string; contact: BillingContact }): Promise<{ providerCustomerId: string }> {
    const existing = await this.findCustomer(input.organizationId);
    if (existing) {
      return { providerCustomerId: existing };
    }

    const created = await this.call(() =>
      razorpay().customers.create({
        name: input.contact.name,
        email: input.contact.email,
        // The organisation id travels with the customer so a webhook can be
        // attributed without trusting anything in the request path.
        notes: { organizationId: input.organizationId, taxId: input.contact.taxId ?? '' },
      }),
    );

    return { providerCustomerId: created.id };
  }

  /**
   * Razorpay authorises the first payment through a hosted page, so the
   * subscription exists before any money has moved. Nothing is treated as paid
   * until an `subscription.activated` webhook arrives, because a customer
   * closing the tab mid redirect is entirely normal.
   */
  async createCheckout(input: CheckoutRequest): Promise<CheckoutSession> {
    const plan = await requireStoredPlan({
      provider: this.name,
      tier: input.plan,
      interval: input.interval,
      currency: input.currency,
    });

    const { providerCustomerId } = await this.ensureCustomer({
      organizationId: input.organizationId,
      contact: input.contact,
    });

    const body = {
      plan_id: plan.providerPlanId,
      customer_id: providerCustomerId,
      // The subscription is bounded by a date rather than a cycle count, so it
      // keeps charging every cycle until the customer cancels. A cycle count
      // would quietly end the subscription when it ran out, which is a customer
      // who paid and silently lost access.
      end_at: subscriptionEndAt(),
      customer_notify: 1 as const,
      notes: {
        organizationId: input.organizationId,
        reference: input.reference,
        planTier: input.plan,
        interval: input.interval,
        currency: input.currency,
      },
    };

    const subscription = await this.call(() => razorpay().subscriptions.create(withCustomerId(body) as never));

    if (!subscription.short_url) {
      throw new BillingProviderError('Razorpay did not return a checkout URL.', 'RAZORPAY_NO_URL', 502);
    }

    return {
      id: subscription.id,
      url: subscription.short_url,
      expiresAt: subscription.current_end ? new Date(subscription.current_end * 1000) : null,
    };
  }

  /**
   * A plan change is scheduled for the end of the current cycle rather than
   * applied immediately, so nobody is charged a prorated amount they did not
   * expect. Razorpay supports this directly, and `cancelScheduledChanges`
   * reverses it.
   *
   * The currency is recovered from the plan the live subscription actually
   * points at, rather than assumed, because a workspace can hold a subscription
   * created in either currency.
   */
  async changePlan(input: { providerSubscriptionId: string; plan: PlanTier; interval: BillingInterval }): Promise<ProviderSubscription> {
    const live = await this.fetchSubscription(input.providerSubscriptionId);
    if (!live) {
      throw new BillingProviderError('That subscription no longer exists at Razorpay.', 'SUBSCRIPTION_NOT_FOUND', 404);
    }

    const raw = (await this.call(() => razorpay().subscriptions.fetch(input.providerSubscriptionId))) as unknown as RazorpaySubscriptionLike;
    const livePlan = raw.plan_id ? await findStoredPlanByProviderPlanId(this.name, raw.plan_id) : null;
    const currency = livePlan?.currency ?? 'INR';

    const target = await requireStoredPlan({
      provider: this.name,
      tier: input.plan,
      interval: input.interval,
      currency,
    });

    const updated = (await this.call(() =>
      razorpay().subscriptions.update(input.providerSubscriptionId, {
        plan_id: target.providerPlanId,
        schedule_change_at: 'cycle_end',
      }),
    )) as unknown as RazorpaySubscriptionLike;

    return {
      providerSubscriptionId: updated.id,
      providerCustomerId: updated.customer_id ?? live.providerCustomerId,
      plan: input.plan,
      status: statusMap[updated.status ?? 'active'] ?? 'active',
      currentPeriodEnd: updated.current_end ? new Date(updated.current_end * 1000) : null,
      cancelAtPeriodEnd: Boolean(updated.cancel_at_cycle_end),
      nextAttemptAt: null,
    };
  }

  async cancelAtPeriodEnd(providerSubscriptionId: string): Promise<void> {
    await this.call(() => razorpay().subscriptions.cancel(providerSubscriptionId, 1));
  }

  /** Reverses a pending plan change or a pending cancellation. */
  async resume(providerSubscriptionId: string): Promise<void> {
    await this.call(() => razorpay().subscriptions.cancelScheduledChanges(providerSubscriptionId));
  }

  async cancelImmediately(providerSubscriptionId: string): Promise<void> {
    await this.call(() => razorpay().subscriptions.cancel(providerSubscriptionId, 0));
  }

  async fetchSubscription(providerSubscriptionId: string): Promise<ProviderSubscription | null> {
    try {
      const subscription = (await this.call(() => razorpay().subscriptions.fetch(providerSubscriptionId))) as RazorpaySubscriptionLike;
      const stored = subscription.plan_id ? await findStoredPlanByProviderPlanId(this.name, subscription.plan_id) : null;
      return toProviderSubscription(subscription, stored?.tier ?? null);
    } catch (error) {
      if (error instanceof BillingProviderError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Razorpay has no self service billing portal. A customer updates their card
   * by authorising a new subscription, so this reports that rather than
   * pretending a portal exists.
   */
  async createBillingPortalSession(input: { providerCustomerId: string; returnUrl: string }): Promise<{ url: string }> {
    void input;
    throw new BillingProviderError(
      'Razorpay does not offer a self service billing portal. A card is updated by starting a new subscription.',
      'PORTAL_UNSUPPORTED',
      501,
    );
  }

  /**
   * Creates the plan objects on Razorpay and records the mapping.
   *
   * Safe to re-run: an existing stored mapping is reused rather than recreated,
   * because replacing a plan id would orphan any live subscription pointing at
   * the old one.
   */
  async syncPlans(currency: 'INR' | 'USD'): Promise<{ created: number; reused: number }> {
    let created = 0;
    let reused = 0;

    for (const entry of expectedPlans(currency)) {
      const existing = await findStoredPlan({
        provider: this.name,
        tier: entry.tier,
        interval: entry.interval,
        currency,
      });
      if (existing) {
        reused += 1;
        continue;
      }

      const plan = await this.call(() =>
        razorpay().plans.create({
          period: entry.interval === 'annual' ? 'yearly' : 'monthly',
          interval: 1,
          item: {
            name: `DMARC Harbor ${entry.tier}`,
            amount: entry.priceMinor,
            currency,
            description: `${entry.tier} plan, billed ${entry.interval}`,
          },
          notes: { tier: entry.tier, interval: entry.interval },
        }),
      );

      await saveStoredPlan({
        provider: this.name,
        tier: entry.tier,
        interval: entry.interval,
        currency,
        priceMinor: entry.priceMinor,
        providerPlanId: plan.id,
      });
      created += 1;
    }

    return { created, reused };
  }

  /**
   * Wraps an SDK call so a vendor error becomes our own shape.
   *
   * A not found is passed through as 404 because the caller distinguishes
   * "gone" from "broken" when reconciling, and everything else becomes a 502,
   * since a provider failure is not the caller's fault and should not look
   * like a bad request.
   */
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BillingProviderError) {
        throw error;
      }

      const statusCode = readStatusCode(error);
      if (statusCode === 404) {
        throw new BillingProviderError('Razorpay has no such record.', 'NOT_FOUND', 404);
      }

      throw new BillingProviderError(
        `Razorpay rejected the request: ${readDescription(error)}`,
        'RAZORPAY_ERROR',
        502,
      );
    }
  }
}

/**
 * Razorpay's create subscription endpoint documents a `customer_id`, and
 * without it a subscription cannot be attributed to a workspace, but the SDK's
 * request type omits the field. The cast is therefore deliberate and narrow
 * rather than a way of smuggling anything past the type checker.
 */
type CreateSubscriptionBody = Omit<
  Parameters<InstanceType<typeof Razorpay>['subscriptions']['create']>[0],
  'total_count'
> & {
  customer_id: string;
  end_at: number;
};

export function withCustomerId(body: {
  plan_id: string;
  customer_id: string;
  end_at: number;
  customer_notify: 0 | 1;
  notes: Record<string, string>;
}): CreateSubscriptionBody {
  return body as CreateSubscriptionBody;
}

/**
 * How long a subscription runs before Razorpay stops charging it.
 *
 * Razorpay caps subscriptions at 100 years and rejects `total_count: 0`, so
 * there is no truly unlimited setting. The bound is set just inside the cap
 * because sitting exactly on the limit risks rejection, and a date is used
 * rather than a cycle count so the same value works for monthly and annual
 * plans without per-interval arithmetic.
 *
 * In practice no customer reaches this. It exists so the subscription ends only
 * because the customer cancelled, and never because a counter ran out.
 */
export const subscriptionMaxYears = 99;

export function subscriptionEndAt(now = new Date()): number {
  return Math.floor(new Date(now.getFullYear() + subscriptionMaxYears, now.getMonth(), now.getDate()).getTime() / 1000);
}

function toProviderSubscription(subscription: RazorpaySubscriptionLike, storedTier: PlanTier | null): ProviderSubscription {
  return {
    providerSubscriptionId: subscription.id,
    providerCustomerId: subscription.customer_id ?? null,
    // A subscription whose plan is not in our catalog cannot be priced, so it
    // is reported as the free tier rather than guessed at.
    plan: storedTier ?? 'MOORING',
    status: statusMap[subscription.status ?? 'active'] ?? 'active',
    currentPeriodEnd: subscription.current_end ? new Date(subscription.current_end * 1000) : null,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_cycle_end),
    nextAttemptAt: null,
  };
}

function readStatusCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const candidate = (error as { statusCode?: unknown }).statusCode;
  return typeof candidate === 'number' ? candidate : null;
}

function readDescription(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown Razorpay error.';
}

/**
 * Verifies a Razorpay webhook signature using the SDK's own check.
 *
 * The signature covers the raw request body, so the body must be read before
 * any JSON parsing. Re-serialising it changes the bytes and the signature stops
 * matching, which is the usual cause of a webhook that "fails verification"
 * intermittently.
 *
 * A replayed webhook is not a separate risk because every event is
 * deduplicated on the provider's event id before it can change anything.
 */
export function verifyRazorpaySignature(rawBody: string, signature: string | undefined, secret: string): void {
  if (!signature) {
    throw new SignatureVerificationError('The Razorpay webhook had no signature header.');
  }

  if (!Razorpay.validateWebhookSignature(rawBody, signature, secret)) {
    throw new SignatureVerificationError('The Razorpay webhook signature did not match.');
  }
}

export function razorpayWebhookSecret(): string | null {
  return env.RAZORPAY_WEBHOOK_SECRET ?? null;
}
