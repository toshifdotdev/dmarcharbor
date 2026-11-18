import { env } from '../config/env.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import DodoPayments, { APIError } from 'dodopayments';
import { bandIndexFor, bandSuffix, planCatalog, planOrder, type BillingCurrency } from '../services/entitlements/plan-catalog.js';
import {
  assertValidQuantity,
  BillingProviderError,
  SignatureVerificationError,
  type BillingContact,
  type BillingInterval,
  type BillingProvider,
  type CheckoutRequest,
  type CheckoutSession,
  type PlanChangePreview,
  type ProviderSubscription,
  type ProviderSubscriptionStatus,
} from './provider.js';
import { expectedPlans, findStoredPlan, findStoredPlanByProviderPlanId, requireStoredPlan, saveStoredPlan } from './plans.js';
import { PROVIDER_TIMEOUT_MS, withTimeout } from './provider-timeout.js';
import type { PlanTier } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { dodoAttribution } from './paddle-attribution.js';

/**
 * Dodo Payments adapter.
 *
 * Dodo Payments (https://dodopayments.com) is our merchant of record for USD
 * subscriptions. Like Paddle, Dodo is the legal seller on USD orders: it
 * calculates, collects and remits international sales tax / VAT / GST, issues
 * the tax invoice to the buyer, and settles net proceeds to our Indian bank
 * account while accepting Indian sole proprietors.
 *
 * Official references verified against `dodopayments@2.63.0`:
 * - API environments (`test_mode` -> https://test.dodopayments.com,
 *   `live_mode` -> https://live.dodopayments.com):
 *   https://docs.dodopayments.com/api-reference/introduction
 * - Checkout sessions (`POST /checkouts`):
 *   https://docs.dodopayments.com/api-reference/checkout-sessions/create
 * - Subscriptions (`GET /subscriptions/{id}`, `PATCH /subscriptions/{id}`):
 *   https://docs.dodopayments.com/api-reference/subscriptions/get-subscriptions-handler
 *   https://docs.dodopayments.com/api-reference/subscriptions/patch-subscription-handler
 * - Plan and quantity changes (`POST /subscriptions/{id}/change-plan`,
 *   `POST /subscriptions/{id}/change-plan/preview`):
 *   https://docs.dodopayments.com/api-reference/subscriptions/change-plan
 *   https://docs.dodopayments.com/features/subscription#changing-subscription-plans
 * - Customer portal (`POST /customers/{id}/customer-portal/session`):
 *   https://docs.dodopayments.com/api-reference/customers/create-customer-portal-session
 * - Refunds (`POST /refunds`):
 *   https://docs.dodopayments.com/api-reference/refunds/create-refund
 * - Products (`POST /products`):
 *   https://docs.dodopayments.com/api-reference/products/create-product
 * - Webhooks (Standard Webhooks specification):
 *   https://docs.dodopayments.com/developer-resources/webhooks
 */

let cachedClient: { key: string; client: DodoPayments } | null = null;

function dodo(): DodoPayments {
  const apiKey = env.DODO_API_KEY;
  const environment = env.DODO_ENVIRONMENT;
  if (!apiKey || !environment) {
    throw new BillingProviderError(
      'Dodo Payments is not configured. Set DODO_API_KEY, DODO_WEBHOOK_SECRET and DODO_ENVIRONMENT.',
      'PROVIDER_NOT_CONFIGURED',
      503,
    );
  }

  const cacheKey = `${apiKey}:${environment}`;
  if (cachedClient && cachedClient.key === cacheKey) {
    return cachedClient.client;
  }

  // Environment is chosen explicitly via DODO_ENVIRONMENT ('test_mode' | 'live_mode'),
  // never inferred from NODE_ENV, so a production deployment can be verified in
  // test_mode before switching to live_mode.
  const client = new DodoPayments({
    bearerToken: apiKey,
    environment,
  });
  cachedClient = { key: cacheKey, client };
  return client;
}

export function dodoConfigured(): boolean {
  return Boolean(env.DODO_API_KEY && env.DODO_WEBHOOK_SECRET && env.DODO_ENVIRONMENT);
}

/**
 * Parses the comma-separated workspace allowlist (`DODO_TEST_WORKSPACE_IDS`)
 * used when `DODO_ENVIRONMENT === 'test_mode'`.
 */
export function dodoTestWorkspaceIds(): Set<string> {
  const raw = env.DODO_TEST_WORKSPACE_IDS ?? '';
  return new Set(
    raw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/**
 * Whether Dodo Payments may offer USD checkout to a caller.
 *
 * When `DODO_ENVIRONMENT === 'live_mode'`, `DODO_TEST_WORKSPACE_IDS` is ignored
 * and USD is open to everyone (including anonymous visitors on `/pricing`).
 *
 * When `DODO_ENVIRONMENT === 'test_mode'`, Dodo accepts test cards, so on a
 * live deployment USD must be offered only to workspaces explicitly listed in
 * `DODO_TEST_WORKSPACE_IDS`. Any other workspace (or an anonymous caller of
 * `/api/capabilities`) is refused.
 */
export function dodoAllowedForWorkspace(organizationId?: string | null): boolean {
  if (!dodoConfigured()) {
    return false;
  }
  if (env.DODO_ENVIRONMENT === 'live_mode') {
    return true;
  }
  if (!organizationId) {
    return false;
  }
  return dodoTestWorkspaceIds().has(organizationId.trim());
}

/**
 * Dodo subscription statuses (`SubscriptionStatus` in `dodopayments/resources/subscriptions`).
 *
 * `on_hold` and `paused` mean a renewal charge failed or the subscription is
 * waiting on payment recovery. Mapping them to `past_due` keeps the customer's
 * paid period while it is still current and lets `dunning.ts` warn and withdraw
 * on the same schedule as every other provider. `pending` and `failed` are
 * never mapped to `active` so an unpaid checkout cannot grant a plan.
 */
const statusMap: Record<string, ProviderSubscriptionStatus> = {
  active: 'active',
  past_due: 'past_due',
  on_hold: 'past_due',
  paused: 'past_due',
  failed: 'past_due',
  pending: 'past_due',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  expired: 'expired',
};

function toBillingCurrency(code: string | null | undefined): BillingCurrency | null {
  if (code === 'USD' || code === 'INR') {
    return code;
  }
  return null;
}

export class DodoBillingProvider implements BillingProvider {
  readonly name = 'DODO' as const;

  /**
   * Plan changes take effect immediately with proration
   * (`proration_billing_mode: 'prorated_immediately'`), matching Paddle.
   */
  readonly appliesPlanChangeImmediately = true;

  /** Idempotent by organisation, so a retried checkout never creates a second customer. */
  private async findCustomer(organizationId: string): Promise<string | null> {
    const row = await prisma.subscription.findFirst({
      where: { organizationId, provider: 'DODO', providerCustomerId: { not: null } },
      select: { providerCustomerId: true },
    });
    return row?.providerCustomerId ?? null;
  }

  /**
   * Creates or reuses a Dodo customer record before opening a checkout session.
   *https://docs.dodopayments.com/api-reference/customers/create-customer
   */
  async ensureCustomer(input: { organizationId: string; contact: BillingContact }): Promise<{ providerCustomerId: string }> {
    const existing = await this.findCustomer(input.organizationId);
    if (existing) {
      await this.refreshCustomerName(existing, input.contact.name);
      return { providerCustomerId: existing };
    }

    const email = input.contact.email.trim().toLowerCase();
    const found = await this.call(async () => {
      for await (const customer of dodo().customers.list({ email })) {
        if (customer.customer_id) {
          return customer.customer_id;
        }
      }
      return null;
    });
    if (found) {
      await this.refreshCustomerName(found, input.contact.name);
      return { providerCustomerId: found };
    }

    const customer = await this.call(() =>
      dodo().customers.create({
        email,
        name: input.contact.name,
        metadata: { organizationId: input.organizationId },
      }),
    );

    return { providerCustomerId: customer.customer_id };
  }

  /**
   * The name on a reused Dodo customer is the billing name given for this checkout.
   *
   * Dodo's checkout locks the name and email of the customer it is opened for,
   * and the invoice carries that name. Reusing a customer without updating it
   * kept the name from the first checkout, so a second purchase showed (and
   * invoiced) whoever paid first. Best effort: a refused update leaves the old
   * name and the checkout still opens.
   */
  private async refreshCustomerName(customerId: string, name: string): Promise<void> {
    const wanted = name.trim();
    if (!wanted) return;
    await this.call(() => dodo().customers.update(customerId, { name: wanted })).catch((error: unknown) => {
      console.warn(`[billing] the Dodo customer name could not be updated: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
  }

  /**
   * Creates a hosted Dodo checkout session (`POST /checkouts`) and returns its URL.
   * https://docs.dodopayments.com/api-reference/checkout-sessions/create
   *
   * Unlike Paddle (which opens an overlay on `/pay` via Paddle.js), Dodo hosts
   * the checkout page directly and redirects the customer back to `return_url`
   * (`<APP_URL>/billing?checkout=complete`) when they finish. The workspace id
   * in `metadata` is accompanied by `dodoAttribution(organizationId)` so the
   * webhook only attributes a new subscription to a workspace our server signed.
   */
  async createCheckout(input: CheckoutRequest): Promise<CheckoutSession> {
    assertValidQuantity(input.quantity);
    void input.cancelUrl;

    if (!dodoAllowedForWorkspace(input.organizationId)) {
      throw new BillingProviderError(
        'Payments in USD are not available for this workspace while Dodo Payments is in test mode.',
        'PROVIDER_NOT_CONFIGURED',
        503,
      );
    }

    const plan = await requireStoredPlan({
      provider: this.name,
      tier: input.plan,
      interval: input.interval,
      currency: input.currency,
      band: bandIndexFor(input.plan, input.quantity),
    });

    const { providerCustomerId } = await this.ensureCustomer({
      organizationId: input.organizationId,
      contact: input.contact,
    });

    const session = await this.call(() =>
      dodo().checkoutSessions.create({
        product_cart: [{ product_id: plan.providerPlanId, quantity: input.quantity }],
        customer: { customer_id: providerCustomerId },
        billing_currency: input.currency,
        return_url: input.successUrl,
        feature_flags: {
          allow_currency_selection: false,
        },
        subscription_data: {
          trial_period_days: 0,
        },
        metadata: {
          organizationId: input.organizationId,
          attribution: dodoAttribution(input.organizationId),
          planTier: input.plan,
          interval: input.interval,
          currency: input.currency,
          reference: input.reference,
        },
      }),
    );

    const url = session.checkout_url;
    if (!url) {
      throw new BillingProviderError('Dodo Payments did not return a checkout URL.', 'DODO_NO_URL', 502);
    }

    return { id: session.session_id, url, expiresAt: null };
  }

  /**
   * Moves an existing Dodo subscription to a different product immediately with
   * proration (`POST /subscriptions/{id}/change-plan`).
   * https://docs.dodopayments.com/api-reference/subscriptions/change-plan
   *
   * `proration_billing_mode: 'prorated_immediately'` charges or credits the
   * unused portion of the current cycle at once, and `on_payment_failure:
   * 'prevent_change'` keeps the subscription on its current plan if the
   * upgrade payment fails.
   */
  async changePlan(input: {
    providerSubscriptionId: string;
    plan: PlanTier;
    interval: BillingInterval;
    quantity: number;
  }): Promise<ProviderSubscription> {
    assertValidQuantity(input.quantity);

    const live = await this.fetchSubscription(input.providerSubscriptionId);
    if (!live) {
      throw new BillingProviderError('That subscription no longer exists at Dodo Payments.', 'SUBSCRIPTION_NOT_FOUND', 404);
    }

    const remote = await this.call(() => dodo().subscriptions.retrieve(input.providerSubscriptionId));
    const remoteProductId = remote.product_id ?? null;
    const remoteQuantity = typeof remote.quantity === 'number' ? remote.quantity : null;
    const currency = toBillingCurrency(remote.currency);

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
      band: bandIndexFor(input.plan, input.quantity),
    });

    const currentRank = live.plan ? planOrder.indexOf(live.plan) : -1;
    const targetRank = planOrder.indexOf(input.plan);

    if (
      currentRank !== -1 &&
      currentRank === targetRank &&
      remoteQuantity === input.quantity &&
      remoteProductId === target.providerPlanId
    ) {
      return { ...live, cancelAtPeriodEnd: false };
    }

    await this.call(() =>
      dodo().subscriptions.changePlan(input.providerSubscriptionId, {
        product_id: target.providerPlanId,
        quantity: input.quantity,
        proration_billing_mode: 'prorated_immediately',
        on_payment_failure: 'prevent_change',
      }),
    );

    return { ...live, plan: input.plan, quantity: input.quantity, cancelAtPeriodEnd: false };
  }

  /**
   * Previews the immediate proration charge or credit for a plan change
   * (`POST /subscriptions/{id}/change-plan/preview`).
   * https://docs.dodopayments.com/api-reference/subscriptions/preview-change-plan
   */
  async previewPlanChange(input: {
    providerSubscriptionId: string;
    plan: PlanTier;
    interval: BillingInterval;
    quantity: number;
  }): Promise<PlanChangePreview> {
    assertValidQuantity(input.quantity);
    const target = await this.targetProduct(input);
    const preview = await this.call(() =>
      dodo().subscriptions.previewChangePlan(input.providerSubscriptionId, {
        product_id: target.providerPlanId,
        quantity: input.quantity,
        proration_billing_mode: 'prorated_immediately',
        on_payment_failure: 'prevent_change',
      }),
    );

    const summary = preview.immediate_charge?.summary;
    const chargeNowMinor =
      typeof summary?.total_amount === 'number' ? Math.max(0, Math.round(summary.total_amount)) : 0;
    // In Dodo's preview summary, a positive `customer_credits` means credits
    // are added to the customer's wallet (e.g. from a downgrade proration); a
    // negative value means existing wallet credits offset an upgrade charge.
    const creditMinor =
      typeof summary?.customer_credits === 'number' && summary.customer_credits > 0
        ? Math.round(summary.customer_credits)
        : 0;
    const nextAmountMinor =
      typeof preview.new_plan?.recurring_pre_tax_amount === 'number'
        ? Math.max(0, Math.round(preview.new_plan.recurring_pre_tax_amount))
        : null;

    return {
      currency: summary?.currency ?? target.currency,
      chargeNowMinor,
      creditMinor,
      nextAmountMinor,
      nextBilledAt: preview.new_plan?.next_billing_date ? new Date(preview.new_plan.next_billing_date) : null,
    };
  }

  private async targetProduct(input: {
    providerSubscriptionId: string;
    plan: PlanTier;
    interval: BillingInterval;
    quantity: number;
  }) {
    const remote = await this.call(() => dodo().subscriptions.retrieve(input.providerSubscriptionId));
    const currency = toBillingCurrency(remote.currency);
    if (!currency) {
      throw new BillingProviderError(
        'That subscription is denominated in a currency we do not sell, so its plan cannot be changed automatically.',
        'CURRENCY_UNSUPPORTED',
        409,
      );
    }
    return requireStoredPlan({
      provider: this.name,
      tier: input.plan,
      interval: input.interval,
      currency,
      band: bandIndexFor(input.plan, input.quantity),
    });
  }

  /**
   * Updates the billed quantity (and band product when crossing a Fleet tier
   * boundary) via `subscriptions.changePlan`.
   * https://docs.dodopayments.com/api-reference/subscriptions/change-plan
   *
   * Unlike Paddle (where quantity lives on `subscriptions.update`), Dodo puts
   * both `product_id` and `quantity` on `subscriptions.changePlan` with the
   * same `proration_billing_mode` values: `'do_not_bill'` for the pre-renewal
   * quantity sync (`syncPerDomainQuantities`) so the current paid period is not
   * repriced, and `'prorated_immediately'` when `prorateNow` is true
   * (`correctCheckoutQuantity`).
   */
  async updateQuantity(input: {
    providerSubscriptionId: string;
    plan: PlanTier;
    quantity: number;
    band?: number;
    prorateNow?: boolean;
  }): Promise<void> {
    assertValidQuantity(input.quantity);
    void input.plan;

    const live = await this.fetchSubscription(input.providerSubscriptionId);
    if (!live) {
      throw new BillingProviderError('That subscription no longer exists at Dodo Payments.', 'SUBSCRIPTION_NOT_FOUND', 404);
    }

    const remote = await this.call(() => dodo().subscriptions.retrieve(input.providerSubscriptionId));
    const currency = toBillingCurrency(remote.currency);

    if (!currency) {
      throw new BillingProviderError(
        'That subscription is denominated in a currency we do not sell, so its quantity cannot be changed automatically.',
        'CURRENCY_UNSUPPORTED',
        409,
      );
    }

    const target = await requireStoredPlan({
      provider: this.name,
      tier: 'FLEET',
      interval: 'monthly',
      currency,
      band: input.band ?? bandIndexFor('FLEET', input.quantity),
    });

    const body = input.prorateNow
      ? {
          product_id: target.providerPlanId,
          quantity: input.quantity,
          proration_billing_mode: 'prorated_immediately' as const,
          on_payment_failure: 'prevent_change' as const,
        }
      : dodoQuantityUpdateBody(target.providerPlanId, input.quantity);

    await this.call(() => dodo().subscriptions.changePlan(input.providerSubscriptionId, body));
  }

  /**
   * Schedules cancellation at the end of the current billing period
   * (`PATCH /subscriptions/{id}` with `cancel_at_next_billing_date: true`).
   * https://docs.dodopayments.com/api-reference/subscriptions/patch-subscription-handler
   */
  async cancelAtPeriodEnd(providerSubscriptionId: string): Promise<void> {
    await this.call(() =>
      dodo().subscriptions.update(providerSubscriptionId, { cancel_at_next_billing_date: true }),
    );
  }

  /**
   * Withdraws a pending period-end cancellation
   * (`PATCH /subscriptions/{id}` with `cancel_at_next_billing_date: false`).
   */
  async resume(providerSubscriptionId: string): Promise<void> {
    await this.call(() =>
      dodo().subscriptions.update(providerSubscriptionId, { cancel_at_next_billing_date: false }),
    );
  }

  /**
   * Cancels the subscription immediately (`PATCH /subscriptions/{id}` with
   * `status: 'cancelled'`), used when dunning exhausts the grace period or
   * after a full refund.
   */
  async cancelImmediately(providerSubscriptionId: string): Promise<void> {
    const remote = await this.call(() => dodo().subscriptions.retrieve(providerSubscriptionId));
    if (remote.status === 'cancelled' || remote.status === 'expired') {
      return;
    }
    await this.call(() => dodo().subscriptions.update(providerSubscriptionId, { status: 'cancelled' }));
  }

  /**
   * Issues a full refund against the subscription's initial payment
   * (`POST /refunds`).
   * https://docs.dodopayments.com/api-reference/refunds/create-refund
   *
   * As with Paddle, the 14-day guarantee refunds the first purchase payment
   * rather than a later proration charge. We iterate the subscription's
   * succeeded payments and pick the initial charge (`charge_type === 'new'` or
   * the earliest `created_at`). Omitting `items` on `refunds.create` instructs
   * Dodo to refund the entire payment.
   */
  async refund(input: {
    providerSubscriptionId: string;
    amountMinor: number;
    reason: string;
    refundUntil?: Date;
  }): Promise<{ providerRefundId: string | null; amountMinor?: number; failedPaymentIds?: string[] }> {
    if (input.refundUntil) {
      return this.refundWindow({ ...input, refundUntil: input.refundUntil });
    }
    const first = await this.call(async () => {
      let oldest: { payment_id: string; total_amount?: number | null; created_at?: string | null; charge_type?: string | null } | null = null;
      for await (const payment of dodo().payments.list({
        subscription_id: input.providerSubscriptionId,
        status: 'succeeded',
      })) {
        if (payment.charge_type === 'new') {
          return payment;
        }
        if (!oldest) {
          oldest = payment;
          continue;
        }
        const candidateTime = payment.created_at ? Date.parse(payment.created_at) : Number.NaN;
        const oldestTime = oldest.created_at ? Date.parse(oldest.created_at) : Number.NaN;
        if (Number.isFinite(candidateTime) && Number.isFinite(oldestTime) && candidateTime < oldestTime) {
          oldest = payment;
        }
      }
      return oldest;
    });

    const paymentId = first?.payment_id;
    if (!paymentId) {
      throw new BillingProviderError('No completed payment for that subscription.', 'PAYMENT_NOT_FOUND', 404);
    }

    const refund = await this.call(() =>
      dodo().refunds.create({
        payment_id: paymentId,
        reason: input.reason.slice(0, 250),
      }),
    );

    const refundedMinor =
      typeof refund?.amount === 'number'
        ? Math.round(refund.amount)
        : typeof first?.total_amount === 'number'
          ? Math.round(first.total_amount)
          : undefined;

    return {
      providerRefundId: refund?.refund_id ?? null,
      ...(refundedMinor !== undefined ? { amountMinor: refundedMinor } : {}),
    };
  }

  /**
   * The money-back guarantee: every succeeded payment on the subscription up to
   * the end of the window, each refunded in full (omitting `items` refunds the
   * whole payment). That is the first payment plus any upgrade proration or
   * Fleet quantity charge taken in the first 14 days.
   *
   * Oldest first, and the first payment is required: with none there is
   * nothing the guarantee covers. A later payment Dodo refuses does not undo
   * the ones already refunded; it is returned so support can finish it by hand,
   * and the refund is still recorded for what did move.
   */
  private async refundWindow(input: {
    providerSubscriptionId: string;
    reason: string;
    refundUntil: Date;
  }): Promise<{ providerRefundId: string | null; amountMinor?: number; failedPaymentIds?: string[] }> {
    const payments = await this.call(async () => {
      const rows: Array<{ payment_id: string; total_amount?: number | null; created_at?: string | null }> = [];
      for await (const payment of dodo().payments.list({
        subscription_id: input.providerSubscriptionId,
        status: 'succeeded',
        created_at_lte: input.refundUntil.toISOString(),
      })) {
        const at = payment.created_at ? Date.parse(payment.created_at) : Number.NaN;
        // The list filter is the provider's; the window is checked here as well.
        if (Number.isFinite(at) && at > input.refundUntil.getTime()) continue;
        rows.push(payment);
      }
      return rows.sort((a, b) => Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? ''));
    });

    if (payments.length === 0) {
      throw new BillingProviderError('No completed payment for that subscription.', 'PAYMENT_NOT_FOUND', 404);
    }

    let firstRefundId: string | null = null;
    let refundedMinor = 0;
    const failedPaymentIds: string[] = [];
    for (const [index, payment] of payments.entries()) {
      try {
        const refund = await this.call(() =>
          dodo().refunds.create({ payment_id: payment.payment_id, reason: input.reason.slice(0, 250) }),
        );
        firstRefundId ??= refund?.refund_id ?? null;
        refundedMinor += Math.round(
          typeof refund?.amount === 'number' ? refund.amount : typeof payment.total_amount === 'number' ? payment.total_amount : 0,
        );
      } catch (error) {
        // The first payment is the guarantee itself: if it cannot be refunded,
        // nothing has moved and the caller must say so.
        if (index === 0) throw error;
        failedPaymentIds.push(payment.payment_id);
      }
    }

    return {
      providerRefundId: firstRefundId,
      amountMinor: refundedMinor,
      ...(failedPaymentIds.length > 0 ? { failedPaymentIds } : {}),
    };
  }

  async fetchSubscription(providerSubscriptionId: string): Promise<ProviderSubscription | null> {
    try {
      const subscription = await this.call(() => dodo().subscriptions.retrieve(providerSubscriptionId));
      const productId = subscription.product_id ?? null;
      const stored = productId ? await findStoredPlanByProviderPlanId(this.name, productId) : null;
      return toProviderSubscription(subscription, stored?.tier ?? null, subscription.currency ?? null);
    } catch (error) {
      if (error instanceof BillingProviderError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Creates a Dodo customer portal session
   * (`POST /customers/{customer_id}/customer-portal/session`).
   * https://docs.dodopayments.com/api-reference/customers/create-customer-portal-session
   *
   * Unlike Paddle's portal session (which ignores `returnUrl`), Dodo accepts
   * `return_url` and renders a "Return to {business}" link in the portal.
   */
  async createBillingPortalSession(input: {
    providerCustomerId: string | null;
    providerSubscriptionId?: string | null;
    returnUrl: string;
  }): Promise<{ url: string }> {
    void input.providerSubscriptionId;
    if (!input.providerCustomerId || input.providerCustomerId.startsWith('pending:')) {
      throw new BillingProviderError(
        'This workspace has no Dodo Payments customer yet, so there is no billing portal to open.',
        'CUSTOMER_NOT_CREATED',
        409,
      );
    }
    const providerCustomerId = input.providerCustomerId;

    const session = await this.call(() =>
      dodo().customers.customerPortal.create(providerCustomerId, {
        return_url: input.returnUrl,
        send_email: false,
      }),
    );

    if (!session?.link) {
      throw new BillingProviderError('Dodo Payments did not return a billing portal URL.', 'DODO_NO_PORTAL_URL', 502);
    }

    return { url: session.link };
  }

  /**
   * Creates a recurring Dodo product per catalog plan entry and stores its
   * `product_id` in `billing_plan` under provider `DODO`.
   * https://docs.dodopayments.com/api-reference/products/create-product
   *
   * In Dodo Payments each product carries a single `price` object (unlike
   * Paddle, where one product holds multiple prices). Every entry in
   * `expectedPlans(currency)` (Fairway, Harbor and Admiralty monthly and
   * annual, plus Fleet bands 0 to 3) therefore becomes one Dodo product with
   * `tax_category: 'saas'`.
   *
   * Note on `subscription_period_count` / `subscription_period_interval`:
   * Dodo's API separates the billing cycle (`payment_frequency_count` +
   * `payment_frequency_interval`) from the total contract duration
   * (`subscription_period_count` + `subscription_period_interval`). Per Dodo's
   * schema documentation, an evergreen subscription that renews until cancelled
   * sets `subscription_period_count: 20` and `subscription_period_interval:
   * 'Year'` (setting 1 Month would expire the subscription after one month).
   *
   * Idempotent and safe to re-run: an existing mapping in `billing_plan` is
   * reused without creating a duplicate product or orphaning live subscriptions.
   */
  async syncPlans(currency: BillingCurrency): Promise<{
    created: number;
    reused: number;
    /**
     * Products Dodo refused, with its reason. The sync goes on past them, so one
     * refusal (a new account's cart value limit on an annual price, say) does
     * not leave every plan after it unsynced. Re-run once the cause is fixed.
     */
    refused: Array<{ tier: PlanTier; interval: BillingInterval; band: number; message: string }>;
  }> {
    let created = 0;
    let reused = 0;
    const refused: Array<{ tier: PlanTier; interval: BillingInterval; band: number; message: string }> = [];

    for (const entry of expectedPlans(currency)) {
      const existing = await findStoredPlan({
        provider: this.name,
        tier: entry.tier,
        interval: entry.interval,
        currency,
        band: entry.band,
      });
      if (existing) {
        reused += 1;
        continue;
      }

      const intervalUnit = entry.interval === 'annual' ? ('Year' as const) : ('Month' as const);
      const suffix = bandSuffix(entry.tier, entry.band);

      let product: { product_id: string };
      try {
        product = await this.call(() =>
        dodo().products.create({
          name: `DMARC Harbor ${entry.tier}${suffix} (${entry.interval})`,
          description: `DMARC Harbor ${entry.tier}${suffix}, billed ${entry.interval}`,
          tax_category: 'saas',
          price: {
            type: 'recurring_price',
            currency,
            price: entry.priceMinor,
            payment_frequency_count: 1,
            payment_frequency_interval: intervalUnit,
            subscription_period_count: 20,
            subscription_period_interval: 'Year',
            purchasing_power_parity: false,
            tax_inclusive: false,
            trial_period_days: 0,
          },
          metadata: {
            app: 'dmarcharbor',
            tier: entry.tier,
            interval: entry.interval,
            currency,
            band: String(entry.band),
          },
        }),
        );
      } catch (error) {
        if (!(error instanceof BillingProviderError) || error.code !== 'DODO_ERROR') throw error;
        refused.push({ tier: entry.tier, interval: entry.interval, band: entry.band, message: error.message });
        continue;
      }

      await saveStoredPlan({
        provider: this.name,
        tier: entry.tier,
        interval: entry.interval,
        currency,
        band: entry.band,
        priceMinor: entry.priceMinor,
        providerPlanId: product.product_id,
      });
      created += 1;
    }

    return { created, reused, refused };
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await withTimeout(operation, PROVIDER_TIMEOUT_MS, 'Dodo Payments');
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

function toProviderError(error: unknown): BillingProviderError {
  if (error instanceof BillingProviderError) {
    return error;
  }

  if (error instanceof APIError) {
    const status = error.status;
    const description = error.message || 'Unknown Dodo Payments error.';
    return new BillingProviderError(
      `Dodo Payments rejected the request: ${description}`,
      'DODO_ERROR',
      status === 404 ? 404 : 502,
    );
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new BillingProviderError('Dodo Payments did not respond in time.', 'DODO_TIMEOUT', 504);
  }

  return new BillingProviderError('Dodo Payments could not be reached.', 'DODO_UNREACHABLE', 502);
}

function toProviderSubscription(
  subscription: {
    subscription_id: string;
    status: string;
    customer?: { customer_id?: string | null } | null;
    product_id?: string | null;
    quantity?: number | null;
    cancel_at_next_billing_date?: boolean | null;
    next_billing_date?: string | null;
    cancelled_at?: string | null;
  },
  storedTier: PlanTier | null,
  currency: string | null,
): ProviderSubscription {
  const periodEnd = dodoPaidThrough(
    subscription.status,
    subscription.next_billing_date ?? null,
    subscription.cancelled_at ?? null,
    subscription.cancel_at_next_billing_date ?? false,
  );
  const recognisedCurrency = toBillingCurrency(currency);

  return {
    providerSubscriptionId: subscription.subscription_id,
    providerCustomerId: subscription.customer?.customer_id ?? null,
    plan: storedTier && recognisedCurrency ? storedTier : null,
    status: statusMap[subscription.status] ?? 'past_due',
    currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
    cancelAtPeriodEnd:
      Boolean(subscription.cancel_at_next_billing_date) ||
      subscription.status === 'cancelled' ||
      subscription.status === 'canceled',
    cancelAtPeriodEndAuthoritative: true,
    quantity: typeof subscription.quantity === 'number' ? subscription.quantity : null,
    nextAttemptAt: subscription.next_billing_date ? new Date(subscription.next_billing_date) : null,
  };
}

/**
 * The date a Dodo subscription is paid through.
 *
 * When a subscription is active or scheduled to cancel at period end
 * (`cancel_at_next_billing_date: true`), `next_billing_date` is the end of the
 * paid billing period. When cancelled immediately (`status === 'cancelled'` and
 * `cancel_at_next_billing_date` is false), `cancelled_at` marks when the
 * subscription ended so access is withdrawn immediately rather than lingering
 * until the originally scheduled next billing date.
 */
export function dodoPaidThrough(
  status: string | null | undefined,
  nextBillingDate: string | null,
  cancelledAt: string | null,
  cancelAtNextBillingDate?: boolean | null,
): string | null {
  if ((status === 'cancelled' || status === 'canceled') && !cancelAtNextBillingDate && cancelledAt) {
    return cancelledAt;
  }
  return nextBillingDate ?? cancelledAt ?? null;
}

/**
 * The allowed quantity range for a plan tier (1..maxActiveDomains for Fleet,
 * 1..1 for flat plans).
 */
export function dodoQuantityRange(tier: PlanTier): { minimum: number; maximum: number } {
  const definition = planCatalog[tier];
  return definition.pricing === 'per_domain'
    ? { minimum: 1, maximum: definition.maxActiveDomains }
    : { minimum: 1, maximum: 1 };
}

/**
 * The exact body sent to `subscriptions.changePlan` for a pre-renewal quantity
 * sync (`proration_billing_mode: 'do_not_bill'`).
 *
 * Exported for unit tests. `do_not_bill` updates the quantity (and band
 * product) for the upcoming renewal without charging or crediting the period
 * already paid.
 */
export function dodoQuantityUpdateBody(
  productId: string,
  quantity: number,
): { product_id: string; quantity: number; proration_billing_mode: 'do_not_bill' } {
  return { product_id: productId, quantity, proration_billing_mode: 'do_not_bill' };
}

export interface DodoWebhookHeaders {
  webhookId?: string | undefined;
  webhookTimestamp?: string | undefined;
  webhookSignature?: string | undefined;
}

/**
 * Verifies a Dodo Payments webhook signature per the Standard Webhooks spec.
 * https://docs.dodopayments.com/developer-resources/webhooks
 *
 * Hand-written rather than delegated to `standardwebhooks` / `dodo.webhooks.unwrap`
 * for the same reasons as `verifyPaddleSignature`:
 * 1. `standardwebhooks` reads `Date.now()` directly inside `verifyTimestamp`,
 *    making the 5-minute tolerance window untestable without mutating global
 *    timers, and throws generic `Error` instances on malformed base64 secrets
 *    rather than `SignatureVerificationError`.
 * 2. `unwrap` parses the JSON body as part of verification and re-serialises
 *    the timestamp through `Date`, whereas verifying the raw `id.timestamp.body`
 *    bytes directly before `JSON.parse` guarantees the signature is checked
 *    against the exact bytes received over the wire.
 *
 * Standard Webhooks format:
 * - Headers: `webhook-id`, `webhook-timestamp` (Unix seconds), `webhook-signature`
 *   (space-separated list of versioned signatures, e.g. `v1,<base64> v1,<base64>`
 *   during secret rotation).
 * - Secret: base64-encoded key prefixed with `whsec_`.
 * - Signed payload: `${webhookId}.${webhookTimestamp}.${rawBody}`.
 * - Digest: HMAC-SHA256 encoded as standard base64, compared in constant time.
 */
export async function verifyDodoSignature(
  rawBody: string,
  headers: DodoWebhookHeaders,
  secret: string,
  now = new Date(),
): Promise<void> {
  const webhookId = headers.webhookId?.trim();
  const webhookTimestamp = headers.webhookTimestamp?.trim();
  const webhookSignature = headers.webhookSignature?.trim();

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    throw new SignatureVerificationError('The Dodo webhook was missing required Standard Webhooks headers.');
  }

  if (!/^\d+$/.test(webhookTimestamp)) {
    throw new SignatureVerificationError('The Dodo signature timestamp was not a number.');
  }

  const signedAt = Number(webhookTimestamp);
  if (!Number.isFinite(signedAt)) {
    throw new SignatureVerificationError('The Dodo signature timestamp was not a number.');
  }

  // Five-minute tolerance window in both directions, matching Standard Webhooks
  // and verifyPaddleSignature.
  const ageSeconds = Math.abs(now.getTime() / 1000 - signedAt);
  if (ageSeconds > 300) {
    throw new SignatureVerificationError('The Dodo webhook signature is too old to trust.');
  }

  const rawSecret = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  if (!rawSecret || !/^[A-Za-z0-9+/]+={0,2}$/.test(rawSecret) || rawSecret.length % 4 !== 0) {
    throw new SignatureVerificationError('The Dodo webhook secret is not valid base64.');
  }
  const keyBytes = Buffer.from(rawSecret, 'base64');
  if (keyBytes.length === 0) {
    throw new SignatureVerificationError('The Dodo webhook secret is empty.');
  }

  const expected = createHmac('sha256', keyBytes)
    .update(`${webhookId}.${webhookTimestamp}.${rawBody}`)
    .digest('base64');
  const expectedBytes = Buffer.from(expected, 'utf8');

  const candidates: string[] = [];
  for (const token of webhookSignature.split(/\s+/)) {
    if (!token) continue;
    const commaIndex = token.indexOf(',');
    if (commaIndex <= 0) continue;
    const version = token.slice(0, commaIndex).trim();
    const sig = token.slice(commaIndex + 1).trim();
    if (version === 'v1' && sig.length > 0) {
      candidates.push(sig);
    }
  }

  if (candidates.length === 0) {
    throw new SignatureVerificationError('The Dodo signature header was malformed.');
  }

  for (const candidate of candidates) {
    const candidateBytes = Buffer.from(candidate, 'utf8');
    if (candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)) {
      return;
    }
  }

  throw new SignatureVerificationError('The Dodo webhook signature did not match.');
}

export function dodoWebhookSecret(): string | null {
  return env.DODO_WEBHOOK_SECRET ?? null;
}
