import { env } from '../config/env.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError, Environment, Paddle as PaddleSdk } from '@paddle/paddle-node-sdk';
import { planOrder, type BillingCurrency } from '../services/entitlements/plan-catalog.js';
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
import { PROVIDER_TIMEOUT_MS, withTimeout } from './provider-timeout.js';
import type { PlanTier } from '@prisma/client';
import { prisma } from '../database/prisma.js';

/**
 * Paddle adapter.
 *
 * Paddle is a merchant of record, not a payment processor. Paddle is the legal
 * seller, it issues the invoice, and it collects and remits sales tax in the
 * markets it operates in. That removes international tax compliance from us,
 * which is the main reason to use it for customers outside India.
 *
 * The trade off is settlement. Paddle pays in its supported currencies, and
 * receiving USD into an Indian bank account needs an FCRA or Wise arrangement.
 * That is a finance question rather than a code question, and it is why
 * Razorpay is the default for INR checkouts.
 *
 * Built on the official SDK so authentication, error shapes and API version
 * tracking are the vendor's responsibility, matching how the Razorpay adapter
 * is built. Webhook verification is also delegated to the SDK rather than
 * hand-rolled, because the signature is computed over the raw request bytes and
 * getting that subtly wrong is the classic intermittent webhook failure.
 *
 * NOTE: written against Paddle's documented behaviour, not verified against a
 * live sandbox, because an account cannot be created until the site is public.
 * The one operation the SDK does not expose is marked below.
 */

let client: PaddleSdk | null = null;

function paddle(): PaddleSdk {
  if (client) {
    return client;
  }

  const apiKey = env.PADDLE_API_KEY;
  if (!apiKey) {
    throw new BillingProviderError('Paddle is not configured. Set PADDLE_API_KEY.', 'PROVIDER_NOT_CONFIGURED', 503);
  }

  client = new PaddleSdk(apiKey, {
    environment: env.NODE_ENV === 'production' ? Environment.production : Environment.sandbox,
  });
  return client;
}

export function paddleConfigured(): boolean {
  return Boolean(env.PADDLE_API_KEY && env.PADDLE_WEBHOOK_SECRET);
}

/**
 * Paddle subscription statuses.
 *
 * `paused` means Paddle has run out of retries, which is a terminal state
 * rather than a temporary one, so it maps to past due and lets dunning decide
 * what happens instead of being treated as a cancellation.
 */
const statusMap: Record<string, ProviderSubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  paused: 'past_due',
  cancelled: 'cancelled',
  expired: 'expired',
};

/**
 * Narrows a Paddle currency code to one we sell.
 *
 * Paddle can be left set to any currency it supports, including ones absent from
 * our catalog. Treating an unknown currency as free rather than guessing is
 * deliberate: a paid plan we cannot price is a support problem, not a silent
 * overcharge.
 */
function toBillingCurrency(code: string | null | undefined): BillingCurrency | null {
  if (code === 'USD' || code === 'INR') {
    return code;
  }
  return null;
}

export class PaddleBillingProvider implements BillingProvider {
  readonly name = 'PADDLE' as const;

  /** Paddle cannot schedule a price change, so the change lands now and prorates. */
  readonly appliesPlanChangeImmediately = true;

  /** Idempotent by organisation, so a retried checkout never creates a second customer. */
  private async findCustomer(organizationId: string): Promise<string | null> {
    const row = await prisma.subscription.findFirst({
      where: { organizationId, provider: 'PADDLE', providerCustomerId: { not: null } },
      select: { providerCustomerId: true },
    });
    return row?.providerCustomerId ?? null;
  }

  /**
   * Paddle requires a real customer to exist before a transaction can be
   * created, so one is created here rather than implied by checkout.
   */
  async ensureCustomer(input: { organizationId: string; contact: BillingContact }): Promise<{ providerCustomerId: string }> {
    const existing = await this.findCustomer(input.organizationId);
    if (existing) {
      return { providerCustomerId: existing };
    }

    const customer = await this.call(() =>
      paddle().customers.create({ email: input.contact.email, name: input.contact.name }),
    );

    return { providerCustomerId: customer.id };
  }

  /**
   * Paddle checkout is a single hosted transaction.
   *
   * Line items must name Paddle's own price ids, which is why the amount is
   * never sent from here: Paddle is the merchant of record and the price shown
   * at checkout has to be the one stored against its product. The catalog is
   * still checked for drift, so a mismatch fails loudly rather than quietly
   * billing a different figure.
   */
  async createCheckout(input: CheckoutRequest): Promise<CheckoutSession> {
    // Paddle renders its own confirmation page from the transaction, so the
    // success URL is not sent through the API. The customer is not required to
    // return to our app at all: the webhook is what marks them paid.
    void input.successUrl;
    void input.cancelUrl;

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

    const transaction = await this.call(() =>
      paddle().transactions.create({
        items: [{ priceId: plan.providerPlanId, quantity: 1 }],
        customerId: providerCustomerId,
        // Carries our own reference so the resulting webhook can be attributed
        // to a workspace without trusting the payload path.
        customData: {
          organizationId: input.organizationId,
          planTier: input.plan,
          interval: input.interval,
          currency: input.currency,
          reference: input.reference,
        },
        collectionMode: 'automatic',
      }),
    );

    const url = transaction.checkout?.url;
    if (!url) {
      throw new BillingProviderError('Paddle did not return a checkout URL.', 'PADDLE_NO_URL', 502);
    }

    return { id: transaction.id, url, expiresAt: null };
  }

  /**
   * A plan change is scheduled for the end of the current cycle rather than
   * applied immediately, so nobody is charged a prorated amount they did not
   * expect.
   *
   * Paddle takes the change through `subscriptions.update` with the new price
   * and no proration, so the customer is never charged a mid cycle figure.
   */
  async changePlan(input: { providerSubscriptionId: string; plan: PlanTier; interval: BillingInterval }): Promise<ProviderSubscription> {
    const live = await this.fetchSubscription(input.providerSubscriptionId);
    if (!live) {
      throw new BillingProviderError('That subscription no longer exists at Paddle.', 'SUBSCRIPTION_NOT_FOUND', 404);
    }

    const remote = await this.call(() => paddle().subscriptions.get(input.providerSubscriptionId));
    const remotePriceId = remote.items?.[0]?.price?.id ?? null;
    const price = remotePriceId ? await this.priceRecord(remotePriceId) : null;
    const currency = toBillingCurrency(price?.unitPrice?.currencyCode);

    if (!currency) {
      throw new BillingProviderError(
        'That subscription is denominated in a currency we do not sell, so its plan cannot be changed automatically.',
        'CURRENCY_UNSUPPORTED',
        409,
      );
    }

    const target = await requireStoredPlan({
      provider: this.name,
      tier: input.plan,
      interval: input.interval,
      currency,
    });

    // Direction is decided by tier order rather than by arithmetic on a decimal
    // string, which avoids a rounding mistake deciding who gets charged more.
    //
    // The two directions are different operations and cannot share a branch.
    //
    // Paddle cannot schedule a plan change. Its ScheduledChangeAction is only
    // cancel, pause or resume - there is no change_plan - so a downgrade cannot be
    // delegated and pretending otherwise would typecheck only with a cast.
    //
    // An upgrade is applied immediately and the difference is billed now, because
    // the customer asked for the new plan and expects to be on it now. The
    // previous code passed 'do_not_bill' for both directions, which handed an
    // upgrade away free until renewal while our row and Paddle's disagreed about
    // which plan was live.
    //
    // A downgrade is left to us. Nothing is sent to Paddle; the caller records a
    // pendingPlan and applyDuePendingPlans moves it once the paid period ends.
    // Same rule as a cancellation: the customer keeps what they paid for.
    // An upgrade and a downgrade are the same API call in Paddle, differing only
    // in which direction the ladder is moving.
    const currentRank = live.plan ? planOrder.indexOf(live.plan) : -1;
    const targetRank = planOrder.indexOf(input.plan);

    // Same plan: nothing to send.
    if (currentRank !== -1 && currentRank === targetRank) {
      return { ...live, cancelAtPeriodEnd: false };
    }

    /**
     * A downgrade is sent to Paddle rather than deferred.
     *
     * This used to return the live subscription unchanged, and
     * `subscription-state` treated that return as acceptance, cleared nothing and
     * moved our own plan down. So a customer who asked to downgrade kept being
     * billed the higher price for ever while holding the cheaper plan, and our
     * row disagreed with Paddle's by design. At Harbor to Fairway that is
     * 10,000 rupees a month of revenue we had granted away and still owed
     * collection on, and it is the worst possible position to be in when the
     * customer opens a chargeback.
     *
     * Paddle cannot schedule a price change, so the honest options were to send
     * it now and let Paddle prorate the credit, or to keep lying. Prorating now
     * means the customer is refunded the unused difference immediately, which is
     * more generous than waiting for the period to end, and it is the only option
     * where Paddle and our row agree.
     */
    await this.call(() =>
      paddle().subscriptions.update(input.providerSubscriptionId, {
        items: [{ priceId: target.providerPlanId, quantity: 1 }],
        prorationBillingMode: 'prorated_immediately',
      }),
    );

    return { ...live, plan: input.plan, cancelAtPeriodEnd: false };
  }

  /**
   * Cancels at the end of the paid period, so the customer keeps what they
   * already paid for.
   */
  async cancelAtPeriodEnd(providerSubscriptionId: string): Promise<void> {
    const remote = await this.call(() => paddle().subscriptions.get(providerSubscriptionId));
    const endsAt = remote.currentBillingPeriod?.endsAt ?? new Date().toISOString();

    await this.call(() =>
      paddle().subscriptions.update(providerSubscriptionId, {
        scheduledChange: { action: 'cancel', effectiveAt: endsAt },
      }),
    );
  }

  async resume(providerSubscriptionId: string): Promise<void> {
    await this.call(() =>
      paddle().subscriptions.update(providerSubscriptionId, {
        scheduledChange: { action: 'resume', effectiveAt: new Date().toISOString() },
      }),
    );
  }

  async cancelImmediately(providerSubscriptionId: string): Promise<void> {
    await this.call(() =>
      paddle().subscriptions.update(providerSubscriptionId, {
        scheduledChange: { action: 'cancel', effectiveAt: new Date().toISOString() },
      }),
    );
  }

/**
 * Paddle is merchant of record, so a refund is an adjustment created against a
 * transaction rather than anything on the subscription.
 *
 * The transaction is found by listing for the subscription and taking the most
 * recent completed one, because `Subscription` carries no transaction id in this
 * SDK version.
 *
 * A full adjustment is always issued. A partial one needs the exact line item id
 * from the original transaction, and reconstructing it here would be guesswork on
 * a money path. Eligibility is decided before this is called, so a partial refund
 * is something an operator arranges deliberately rather than something this
 * silently gets wrong.
 */
async refund(input: {
    providerSubscriptionId: string;
    amountMinor: number;
    reason: string;
  }): Promise<{ providerRefundId: string | null }> {
    // `transactions.list` is synchronous in this SDK version, unlike the other
    // resources, so it is wrapped to keep `this.call` uniform across the adapter.
    const collection = (await this.call(async () =>
      paddle().transactions.list({
        subscriptionId: [input.providerSubscriptionId],
        status: ['completed'],
        perPage: 1,
        orderBy: 'created_at DESC',
      }),
    )) as unknown as { data: Array<{ id?: string }> };

    const transactionId = collection.data?.[0]?.id;
    if (!transactionId) {
      throw new BillingProviderError('No completed transaction for that subscription.', 'PAYMENT_NOT_FOUND', 404);
    }

    const adjustment = (await this.call(() =>
      paddle().adjustments.create({
        action: 'refund',
        type: 'full',
        transactionId,
        reason: input.reason.slice(0, 250),
      }),
    )) as { id?: string };

    return { providerRefundId: adjustment?.id ?? null };
  }

  async fetchSubscription(providerSubscriptionId: string): Promise<ProviderSubscription | null> {
    try {
      const subscription = await this.call(() => paddle().subscriptions.get(providerSubscriptionId));
      const priceId = subscription.items?.[0]?.price?.id ?? null;
      const price = priceId ? await this.priceRecord(priceId) : null;
      const stored = price ? await findStoredPlanByProviderPlanId(this.name, price.id) : null;
      return toProviderSubscription(subscription, stored?.tier ?? null, price?.unitPrice?.currencyCode ?? null);
    } catch (error) {
      if (error instanceof BillingProviderError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Paddle does have a billing portal, so a customer can update their card,
   * download invoices and change plan without contacting support.
   */
  async createBillingPortalSession(input: { providerCustomerId: string; returnUrl: string }): Promise<{ url: string }> {
    // Paddle's billing portal is a page it hosts, and it does not take a return
    // url. Opening it hands the customer over to Paddle's own site to change their
    // card, and Paddle sends them back to whatever it has on file rather than
    // anywhere we choose. Recorded here so the next person does not read the void
    // as an oversight and assume the parameter is honoured.
    void input.returnUrl;

    if (input.providerCustomerId.startsWith('pending:')) {
      throw new BillingProviderError(
        'This workspace has no Paddle customer yet, so there is no billing portal to open.',
        'CUSTOMER_NOT_CREATED',
        409,
      );
    }

    // Paddle's portal is scoped to a subscription rather than a customer, so
    // the most recent active one is the one a customer expects to see.
    let active: { id: string } | undefined;
    for await (const subscription of paddle().subscriptions.list({
      customerId: [input.providerCustomerId],
      status: ['active'],
    })) {
      active = subscription;
      break;
    }

    if (!active) {
      throw new BillingProviderError('There is no active subscription to manage.', 'NO_SUBSCRIPTION', 404);
    }

    const session = await this.call(() => paddle().customerPortalSessions.create(input.providerCustomerId, [active.id]));
    return { url: session.urls.general.overview };
  }

  /**
   * Creates a product and price per catalog plan, and records the mapping.
   *
   * Safe to re-run. An existing mapping is reused, because replacing a price id
   * would orphan any live subscription pointing at the old one.
   */
  async syncPlans(currency: BillingCurrency): Promise<{ created: number; reused: number }> {
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

      // Resolved before the call rather than inside it, because the SDK call
      // itself is the thing being wrapped.
      const productId = await this.ensureProduct(entry.tier);

      const price = await this.call(() =>
        paddle().prices.create({
          productId,
          description: `DMARC Harbor ${entry.tier}, billed ${entry.interval}`,
          type: 'standard',
          // Paddle is the merchant of record and collects tax itself. Which way
          // the price is presented is the business account's own setting, so
          // 'account_setting' defers to that rather than overriding it.
          taxMode: 'account_setting',
          unitPrice: { amount: String(entry.priceMinor), currencyCode: currency },
          ...(entry.interval === 'annual'
            ? { billingCycle: { interval: 'year', frequency: 1 } }
            : { billingCycle: { interval: 'month', frequency: 1 } }),
        }),
      );

      await saveStoredPlan({
        provider: this.name,
        tier: entry.tier,
        interval: entry.interval,
        currency,
        priceMinor: entry.priceMinor,
        providerPlanId: price.id,
      });
      created += 1;
    }

    return { created, reused };
  }

  private readonly productIds = new Map<PlanTier, string>();

  private async ensureProduct(tier: PlanTier): Promise<string> {
    const cached = this.productIds.get(tier);
    if (cached) {
      return cached;
    }

    // A product is created once per tier and then reused, so changing a price
    // never orphans a customer's product.
    const product = await this.call(() =>
      paddle().products.create({
        name: `DMARC Harbor ${tier}`,
        description: `DMARC Harbor ${tier} plan`,
        type: 'standard',
        taxCategory: 'saas',
      }),
    );

    this.productIds.set(tier, product.id);
    return product.id;
  }

  private async priceRecord(priceId: string) {
    return this.call(() => paddle().prices.get(priceId));
  }

  /**
   * Wraps an SDK call so a vendor error becomes our own shape.
   *
   * A not found passes through as 404 because reconciliation distinguishes
   * "gone" from "broken". Everything else becomes a 502, since a provider
   * failure is not the caller's fault and should not look like a bad request.
   */
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      /**
       * Bounded, like Razorpay, and for the same reason: the SDK is constructed
       * with an environment and nothing else, so its fetch has no timeout and
       * accepts a connection that never answers for as long as it stays open.
       * Checkout, plan change and refund all sit inside `call`.
       */
      return await withTimeout(operation, PROVIDER_TIMEOUT_MS, 'Paddle');
    } catch (error) {
      throw toProviderError(error);
    }
  }

}

function toProviderError(error: unknown): BillingProviderError {
  if (error instanceof BillingProviderError) {
    return error;
  }

  if (error instanceof ApiError) {
    const status = (error as unknown as { statusCode?: number }).statusCode;
    const description = error.detail || error.message || 'Unknown Paddle error.';
    return new BillingProviderError(
      `Paddle rejected the request: ${description}`,
      'PADDLE_ERROR',
      status === 404 ? 404 : 502,
    );
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new BillingProviderError('Paddle did not respond in time.', 'PADDLE_TIMEOUT', 504);
  }

  return new BillingProviderError('Paddle could not be reached.', 'PADDLE_UNREACHABLE', 502);
}

function toProviderSubscription(
  subscription: { id: string; status: string; customerId?: string | null; items?: { price?: { id?: string } }[]; currentBillingPeriod?: { endsAt?: string } | null; scheduledChange?: { action?: string } | null; nextBilledAt?: string | null; canceledAt?: string | null },
  storedTier: PlanTier | null,
  currency: string | null,
): ProviderSubscription {
  const periodEnd = subscription.currentBillingPeriod?.endsAt ?? subscription.canceledAt ?? null;
  const recognisedCurrency = toBillingCurrency(currency);

  return {
    providerSubscriptionId: subscription.id,
    providerCustomerId: subscription.customerId ?? null,
    /**
     * Null rather than MOORING, for the same reason as the Razorpay adapter: an
     * unresolvable price id is evidence that our catalog and Paddle have
     * diverged, not evidence that the customer is free. Reporting MOORING made
     * the unattended reconciler hand the free tier to a paying subscriber.
     */
    plan: storedTier && recognisedCurrency ? storedTier : null,
    status: statusMap[subscription.status] ?? 'active',
    currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
    cancelAtPeriodEnd: subscription.scheduledChange?.action === 'cancel' || subscription.status === 'cancelled',
    nextAttemptAt: subscription.nextBilledAt ? new Date(subscription.nextBilledAt) : null,
  };
}

/**
 * Verifies a Paddle webhook signature.
 *
 * Hand written rather than delegated to the SDK, for two concrete reasons
 * found by reading the SDK's implementation. Its validator depends on a global
 * runtime provider that is not initialised unless something else has constructed
 * a client first, so it can silently return false; and its tolerance window is
 * five seconds, which will reject legitimate deliveries on a slow link. Paddle
 * signs with a timestamped HMAC over the raw body, so the check is verify the
 * HMAC, then verify the timestamp is recent, then compare in constant time.
 *
 * The raw body must be read before any JSON parsing, because re-serialising it
 * changes the bytes the signature covers. That is the usual cause of a webhook
 * that intermittently fails verification.
 *
 * A replayed event is not a separate risk because every event is deduplicated
 * on the provider's event id before it can change anything.
 */
export async function verifyPaddleSignature(rawBody: string, header: string | undefined, secret: string, now = new Date()): Promise<void> {
  if (!header) {
    throw new SignatureVerificationError('The Paddle webhook had no signature header.');
  }

  let timestamp: string | undefined;
  let provided: string | undefined;
  for (const piece of header.split(';')) {
    const [key, value] = piece.split('=');
    if (key?.trim() === 'ts') {
      timestamp = value?.trim();
    }
    if (key?.trim() === 'h1') {
      provided = value?.trim();
    }
  }

  if (!timestamp || !provided) {
    throw new SignatureVerificationError('The Paddle signature header was malformed.');
  }

  const signedAt = Number(timestamp);
  if (!Number.isFinite(signedAt)) {
    throw new SignatureVerificationError('The Paddle signature timestamp was not a number.');
  }

  // Five minutes. Wide enough for a slow delivery, narrow enough that a captured
  // signature is not usable later.
  const ageSeconds = Math.abs(now.getTime() / 1000 - signedAt);
  if (ageSeconds > 300) {
    throw new SignatureVerificationError('The Paddle webhook signature is too old to trust.');
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}:${rawBody}`).digest('hex');
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');

  if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes)) {
    throw new SignatureVerificationError('The Paddle webhook signature did not match.');
  }
}

export function paddleWebhookSecret(): string | null {
  return env.PADDLE_WEBHOOK_SECRET ?? null;
}
