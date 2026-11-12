import type { PlanTier } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { planCatalog } from '../services/entitlements/plan-catalog.js';
import {
  assertValidQuantity,
  BillingProviderError,
  type BillingContact,
  type BillingInterval,
  type BillingProvider,
  type CheckoutRequest,
  type CheckoutSession,
  type PlanChangePreview,
  type ProviderSubscription,
  type ProviderSubscriptionStatus,
} from './provider.js';
import { catalogPriceMinor } from './plans.js';
import { bandIndexFor } from '../services/entitlements/plan-catalog.js';
import { createRegistrationLink, fetchPayment, refundPayment } from './razorpay-client.js';
import {
  addInterval,
  checkoutLinkTtlMs,
  defaultMandateMethod,
  isRecurringKey,
  mandateLifetimeMs,
  mandateMaxFor,
  methodAllowed,
  recurringSubscriptionKey,
  subtractInterval,
  upgradeCarryOverMinor,
} from './recurring-terms.js';
export { razorpayConfigured, razorpayWebhookSecret, verifyRazorpaySignature } from './razorpay-client.js';

/**
 * The renewal service, loaded on first use.
 *
 * A static import closes a cycle: registry → this file → recurring.service →
 * quantity and subscription-state → registry. Whichever module loads first,
 * the registry could then run before this class exists ("is not a
 * constructor"). Nothing here needs the service at load time.
 */
const recurring = () => import('./recurring.service.js');
const recurringChargeFor = async (...args: Parameters<Awaited<ReturnType<typeof recurring>>['recurringChargeFor']>) =>
  (await recurring()).recurringChargeFor(...args);

/**
 * Razorpay adapter, on Recurring Payments (INR).
 *
 * Razorpay is a payment gateway, not a merchant of record: it takes the money
 * and settles INR into our bank account. Until November 2026 this adapter used
 * Razorpay Subscriptions, which on Indian cards and UPI refuses any plan or
 * quantity change and cannot undo a cancellation (session 11). It now uses
 * Recurring Payments:
 *
 * - Checkout is a hosted registration link that takes the first payment and
 *   registers a mandate (card, UPI Autopay or eNACH) up to a maximum.
 * - We keep the schedule and charge each renewal on the mandate ourselves
 *   (`recurring.service.ts`), after the pre-debit notice RBI requires.
 * - An upgrade applies at once and its prorated difference is added to the
 *   next charge; a downgrade waits for the end of the paid period.
 * - Cancelling only stops the next charge, so it can be undone until the
 *   period ends; the mandate is deleted when the plan ends.
 *
 * The subscription id we store is `rr_<first order id>`. A `sub_…` id is a
 * Razorpay Subscription from before the change; this adapter reports it as
 * gone, and reconciliation lets it end with its paid period.
 */
export class RazorpayBillingProvider implements BillingProvider {
  readonly name = 'RAZORPAY' as const;

  /** A downgrade waits for the period end; an upgrade is decided by `planChangeTiming`. */
  readonly appliesPlanChangeImmediately = false;

  /** No plan objects at Razorpay: every amount is computed from the catalog. */
  readonly usesStoredPlans = false;

  async ensureCustomer(input: { organizationId: string; contact: BillingContact }): Promise<{ providerCustomerId: string }> {
    const row = await prisma.subscription.findUnique({
      where: { organizationId: input.organizationId },
      select: { providerCustomerId: true, provider: true },
    });
    if (row?.provider === 'RAZORPAY' && row.providerCustomerId) {
      return { providerCustomerId: row.providerCustomerId };
    }
    // Razorpay creates the customer from the registration link's details; the
    // id is stored when the first payment is captured.
    throw new BillingProviderError('The Razorpay customer is created at checkout.', 'NO_CUSTOMER_YET', 409);
  }

  async createCheckout(input: CheckoutRequest): Promise<CheckoutSession> {
    assertValidQuantity(input.quantity);
    if (input.currency !== 'INR') {
      throw new BillingProviderError('Razorpay charges in Indian rupees only.', 'CURRENCY_UNSUPPORTED', 400);
    }
    const phone = normalisePhone(input.contact.phone);
    if (!phone) {
      throw new BillingProviderError(
        'Enter a mobile number. Razorpay sends the payment and mandate details to it.',
        'PHONE_REQUIRED',
        400,
      );
    }

    const definition = planCatalog[input.plan];
    const unit = catalogPriceMinor(input.plan, input.interval, 'INR', bandIndexFor(input.plan, input.quantity));
    const amountMinor = definition.pricing === 'per_domain' ? unit * input.quantity : unit;

    const method = input.mandateMethod ?? defaultMandateMethod(amountMinor);
    if (!methodAllowed(method, amountMinor)) {
      throw new BillingProviderError(
        'UPI Autopay takes charges up to ₹15,000 on its own. Choose a card or a bank mandate (eNACH) for this amount.',
        'METHOD_NOT_ALLOWED',
        400,
      );
    }

    // A checkout started earlier and left unpaid is closed, so the owner can
    // never pay two and start two subscriptions.
    await (await recurring()).closeOtherCheckouts(input.organizationId, null);

    const now = new Date();
    const link = await createRegistrationLink({
      method,
      amountMinor,
      maxAmountMinor: mandateMaxFor(method, amountMinor),
      customer: { name: input.contact.name, email: input.contact.email, contact: phone },
      // Razorpay shows our business name beside it, so the plan alone.
      description: `${definition.label} plan, billed ${input.interval === 'annual' ? 'annually' : 'monthly'}`,
      receipt: `dh-${input.organizationId.slice(0, 12)}-${now.getTime()}`,
      expireBy: new Date(now.getTime() + checkoutLinkTtlMs),
      mandateExpiresAt: new Date(now.getTime() + mandateLifetimeMs),
      notes: {
        organizationId: input.organizationId,
        reference: input.reference,
        planTier: input.plan,
        interval: input.interval,
        quantity: String(input.quantity),
        kind: 'first',
        ...(input.contact.taxId ? { gstin: input.contact.taxId } : {}),
      },
    });

    await prisma.billingCharge.create({
      data: {
        organizationId: input.organizationId,
        subscriptionKey: recurringSubscriptionKey(link.orderId),
        provider: 'RAZORPAY',
        kind: 'FIRST',
        channel: 'LINK',
        providerOrderId: link.orderId,
        providerInvoiceId: link.id,
        paymentUrl: link.shortUrl,
        amountMinor,
        currency: 'INR',
        plan: input.plan,
        interval: input.interval === 'annual' ? 'ANNUAL' : 'MONTHLY',
        quantity: input.quantity,
        periodStart: now,
        periodEnd: addInterval(now, input.interval),
        status: 'PENDING',
      },
    });

    return { id: link.id, url: link.shortUrl, expiresAt: new Date(now.getTime() + checkoutLinkTtlMs) };
  }

  async planChangeTiming(input: {
    organizationId: string;
    fromPlan: PlanTier;
    toPlan: PlanTier;
    toInterval: BillingInterval;
  }): Promise<'immediate' | 'cycle_end'> {
    const row = await prisma.subscription.findUnique({
      where: { organizationId: input.organizationId },
      select: { billingInterval: true },
    });
    const fromInterval: BillingInterval = row?.billingInterval === 'ANNUAL' ? 'annual' : 'monthly';
    const toInterval: BillingInterval = planCatalog[input.toPlan].pricing === 'per_domain' ? 'monthly' : input.toInterval;
    if (fromInterval !== toInterval) {
      // A different interval is a different period, so it starts at the next one.
      return 'cycle_end';
    }
    const [from, to] = await Promise.all([
      recurringChargeFor(input.organizationId, input.fromPlan, fromInterval),
      recurringChargeFor(input.organizationId, input.toPlan, toInterval),
    ]);
    return to.amountMinor > from.amountMinor ? 'immediate' : 'cycle_end';
  }

  /**
   * Records what an upgrade owes: the price difference for the rest of the
   * paid period, added to the next renewal. A renewal already scheduled at the
   * old price is withdrawn, so the job prices it again with the new plan.
   */
  async afterImmediatePlanChange(input: {
    organizationId: string;
    fromPlan: PlanTier;
    toPlan: PlanTier;
    interval: BillingInterval;
  }): Promise<void> {
    const row = await prisma.subscription.findUnique({
      where: { organizationId: input.organizationId },
      select: { currentPeriodEnd: true, billingInterval: true },
    });
    if (!row?.currentPeriodEnd) return;
    const interval: BillingInterval = row.billingInterval === 'ANNUAL' ? 'annual' : 'monthly';
    const [from, to] = await Promise.all([
      recurringChargeFor(input.organizationId, input.fromPlan, interval),
      recurringChargeFor(input.organizationId, input.toPlan, interval),
    ]);
    const owed = upgradeCarryOverMinor({
      fromMinor: from.amountMinor,
      toMinor: to.amountMinor,
      periodStart: subtractInterval(row.currentPeriodEnd, interval),
      periodEnd: row.currentPeriodEnd,
      now: new Date(),
    });
    if (owed > 0) {
      await prisma.subscription.update({
        where: { organizationId: input.organizationId },
        data: { carryOverMinor: { increment: owed } },
      });
    }
    await (await recurring()).withdrawScheduledRenewals(input.organizationId);
  }

  /** A renewal already announced at the old plan's price is withdrawn and priced again. */
  async afterScheduledPlanChange(organizationId: string): Promise<void> {
    await (await recurring()).withdrawScheduledRenewals(organizationId);
  }

  async previewPlanChange(input: {
    providerSubscriptionId: string;
    plan: PlanTier;
    interval: BillingInterval;
    quantity: number;
  }): Promise<PlanChangePreview> {
    const row = await this.rowFor(input.providerSubscriptionId);
    const interval: BillingInterval = row.billingInterval === 'ANNUAL' ? 'annual' : 'monthly';
    const [from, to] = await Promise.all([
      recurringChargeFor(row.organizationId, row.plan, interval),
      recurringChargeFor(row.organizationId, input.plan, input.interval),
    ]);
    const owed =
      row.currentPeriodEnd && interval === input.interval
        ? upgradeCarryOverMinor({
            fromMinor: from.amountMinor,
            toMinor: to.amountMinor,
            periodStart: subtractInterval(row.currentPeriodEnd, interval),
            periodEnd: row.currentPeriodEnd,
            now: new Date(),
          })
        : 0;
    return {
      currency: 'INR',
      chargeNowMinor: 0,
      creditMinor: 0,
      nextAmountMinor: to.amountMinor + row.carryOverMinor + owed,
      nextBilledAt: row.currentPeriodEnd,
    };
  }

  /**
   * Nothing to tell Razorpay: the plan is ours, and the next renewal is
   * charged at the new plan's price. Reports the state as it now is.
   */
  async changePlan(input: {
    providerSubscriptionId: string;
    plan: PlanTier;
    interval: BillingInterval;
    quantity: number;
  }): Promise<ProviderSubscription> {
    assertValidQuantity(input.quantity);
    const state = await this.fetchSubscription(input.providerSubscriptionId);
    if (!state) {
      throw new BillingProviderError('That subscription no longer exists at Razorpay.', 'SUBSCRIPTION_NOT_FOUND', 404);
    }
    return { ...state, plan: input.plan, quantity: input.quantity };
  }

  /** Fleet's count is measured at each charge, so there is nothing to push. */
  async updateQuantity(input: { providerSubscriptionId: string; plan: PlanTier; quantity: number }): Promise<void> {
    assertValidQuantity(input.quantity);
  }

  /** The next charge is simply not made; the row's flag is the cancellation. */
  async cancelAtPeriodEnd(providerSubscriptionId: string): Promise<void> {
    await this.rowFor(providerSubscriptionId);
  }

  /** Undoing a cancellation needs nothing at Razorpay while the mandate stands. */
  async resume(providerSubscriptionId: string): Promise<void> {
    const row = await this.rowFor(providerSubscriptionId);
    if (row.mandateStatus === 'cancelled' && row.currentPeriodEnd && row.currentPeriodEnd.getTime() <= Date.now()) {
      throw new BillingProviderError('This plan has already ended. Choose a plan to start again.', 'SUBSCRIPTION_ENDED', 409);
    }
  }

  /** Ends the plan now: used after a refund, and by dunning once the grace is over. */
  async cancelImmediately(providerSubscriptionId: string): Promise<void> {
    const row = await this.rowFor(providerSubscriptionId);
    await (await recurring()).endRecurringSubscription(row.organizationId, { reason: 'cancelled', endAt: new Date() });
  }

  /** Refunds the first payment: the one the 14-day guarantee covers. */
  async refund(input: {
    providerSubscriptionId: string;
    amountMinor: number;
    reason: string;
  }): Promise<{ providerRefundId: string | null; amountMinor?: number }> {
    const first = await prisma.billingCharge.findFirst({
      where: { subscriptionKey: input.providerSubscriptionId, kind: 'FIRST', status: 'CAPTURED' },
      select: { providerPaymentId: true },
    });
    if (!first?.providerPaymentId) {
      throw new BillingProviderError('No payment has been captured for that subscription.', 'PAYMENT_NOT_FOUND', 404);
    }
    const payment = await fetchPayment(first.providerPaymentId);
    const amountMinor = Math.min(input.amountMinor, payment.amountMinor);
    const refund = await refundPayment({
      paymentId: payment.id,
      amountMinor,
      capturedMinor: payment.amountMinor,
      notes: { reason: input.reason.slice(0, 250), subscription: input.providerSubscriptionId },
    });
    return { providerRefundId: refund.id, amountMinor };
  }

  /**
   * The state we hold, since Razorpay holds no subscription. A `sub_…` id is a
   * Razorpay Subscription from before Recurring Payments and is reported gone.
   */
  async fetchSubscription(providerSubscriptionId: string): Promise<ProviderSubscription | null> {
    if (!isRecurringKey(providerSubscriptionId)) {
      return null;
    }
    const row = await prisma.subscription.findFirst({
      where: { provider: 'RAZORPAY', providerSubscriptionId },
      select: {
        plan: true,
        status: true,
        providerCustomerId: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        quantity: true,
      },
    });
    if (!row) return null;
    return {
      providerSubscriptionId,
      providerCustomerId: row.providerCustomerId,
      plan: row.plan,
      status: storedStatusMap[row.status],
      currentPeriodEnd: row.currentPeriodEnd,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      cancelAtPeriodEndAuthoritative: true,
      quantity: row.quantity,
      nextAttemptAt: null,
    };
  }

  /**
   * Razorpay has no billing portal. When a renewal is waiting on the customer,
   * its payment link is the page to send them to; it also sets up a new
   * mandate. Otherwise there is nothing to manage there.
   */
  async createBillingPortalSession(input: {
    providerCustomerId: string | null;
    providerSubscriptionId?: string | null;
    returnUrl: string;
  }): Promise<{ url: string }> {
    void input.returnUrl;
    const open = input.providerSubscriptionId
      ? await prisma.billingCharge.findFirst({
          where: { subscriptionKey: input.providerSubscriptionId, channel: 'LINK', status: 'PENDING', paymentUrl: { not: null } },
          orderBy: { createdAt: 'desc' },
          select: { paymentUrl: true },
        })
      : null;
    if (open?.paymentUrl) {
      return { url: open.paymentUrl };
    }
    throw new BillingProviderError(
      'Nothing is waiting on you. If a renewal cannot be charged on your saved payment method, we email you a payment link, and it also appears here.',
      'NO_PAYMENT_DUE',
      409,
    );
  }

  private async rowFor(providerSubscriptionId: string) {
    const row = await prisma.subscription.findFirst({
      where: { provider: 'RAZORPAY', providerSubscriptionId },
      select: {
        organizationId: true,
        plan: true,
        currentPeriodEnd: true,
        billingInterval: true,
        carryOverMinor: true,
        mandateStatus: true,
      },
    });
    if (!row) {
      throw new BillingProviderError('That subscription is not on record.', 'SUBSCRIPTION_NOT_FOUND', 404);
    }
    return row;
  }
}

const storedStatusMap: Record<string, ProviderSubscriptionStatus> = {
  ACTIVE: 'active',
  TRIALING: 'trialing',
  PAST_DUE: 'past_due',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

/** An Indian mobile number as Razorpay takes it: ten digits, an optional +91. */
export function normalisePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/[^\d+]/g, '');
  const match = /^(?:\+?91)?([6-9]\d{9})$/.exec(digits);
  if (match) return `+91${match[1]}`;
  // An international number is passed through as typed, with its +.
  return /^\+\d{8,15}$/.test(digits) ? digits : null;
}
