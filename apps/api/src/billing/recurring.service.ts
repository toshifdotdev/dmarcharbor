import type { BillingCharge, PlanTier } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { planCatalog } from '../services/entitlements/plan-catalog.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { sendPlanChangedEmail, sendRenewalLinkEmail, sendRenewalNoticeEmail } from '../email/mailer.js';
import { afterPlanChange } from '../services/entitlements/plan-change-effects.js';
import { catalogPriceMinor } from './plans.js';
import { billableQuantity } from './quantity.js';
import { applyBillingEvent, writePlan } from './subscription-state.js';
import { BillingProviderError, type BillingEvent, type BillingInterval } from './provider.js';
import {
  cancelRegistrationLink,
  chargeToken,
  createRegistrationLink,
  createRenewalOrder,
  deleteToken,
  fetchOrderNotification,
  fetchOrderPayments,
  fetchPayment,
  fetchToken,
  razorpayRefused,
  refundPayment,
} from './razorpay-client.js';
import {
  addInterval,
  defaultMandateMethod,
  isRecurringKey,
  linkLeadMs,
  mandateLifetimeMs,
  mandateMaxFor,
  methodAllowed,
  preDebitWaitMs,
  renewalLeadMs,
  type MandateMethod,
} from './recurring-terms.js';

/**
 * Razorpay Recurring Payments: what happens to a charge after we ask for it,
 * and the job that asks for each renewal.
 *
 * Razorpay holds no subscription for these customers. We hold the schedule
 * (`Subscription.currentPeriodEnd`), each charge we ask for
 * (`BillingCharge`), and the mandate a renewal is charged on. Every change to
 * the plan or the paid period still goes through `applyBillingEvent`, so the
 * plan, the period, dunning and the audit trail behave as they do for Paddle.
 */

/** Matches `dunningGraceDays`: a renewal link stays open for the whole grace. */
const renewalLinkGraceMs = 7 * 24 * 60 * 60 * 1000;

const toStored = (interval: BillingInterval) => (interval === 'annual' ? ('ANNUAL' as const) : ('MONTHLY' as const));
const fromStored = (interval: 'MONTHLY' | 'ANNUAL' | null | undefined): BillingInterval =>
  interval === 'ANNUAL' ? 'annual' : 'monthly';

/**
 * What one period of a plan costs this workspace now, in paise.
 *
 * A flat plan is its catalog price. Fleet is the active-domain count (at least
 * the band's minimum) times the band's unit price, measured at the moment of
 * the charge, so a portfolio that grew is billed for what it holds.
 */
export async function recurringChargeFor(
  organizationId: string,
  plan: PlanTier,
  interval: BillingInterval,
): Promise<{ amountMinor: number; quantity: number; band: number }> {
  const definition = planCatalog[plan];
  const effectiveInterval: BillingInterval = definition.pricing === 'per_domain' ? 'monthly' : interval;
  const billable = await billableQuantity(organizationId, plan);
  const unit = catalogPriceMinor(plan, effectiveInterval, 'INR', billable.band);
  return {
    amountMinor: definition.pricing === 'per_domain' ? unit * billable.quantity : unit,
    quantity: billable.quantity,
    band: billable.band,
  };
}

/* ----------------------------------------------------------- webhook side */

/**
 * A charge was paid: the first payment on a registration link, a renewal on
 * the mandate, or a renewal paid on a link.
 *
 * `payment.captured`, `order.paid` and `invoice.paid` all describe the same
 * money, so all three are claimed under one event id (the order), and the
 * second and third are duplicates.
 */
export async function applyChargeCaptured(input: {
  orderId: string;
  paymentId: string | null;
  raw: unknown;
}): Promise<{ handled: boolean; duplicate: boolean; organizationId: string | null }> {
  const charge = await prisma.billingCharge.findUnique({ where: { providerOrderId: input.orderId } });
  if (!charge) {
    return { handled: false, duplicate: false, organizationId: null };
  }
  if (charge.status === 'CAPTURED') {
    return { handled: true, duplicate: true, organizationId: charge.organizationId };
  }

  if (charge.status === 'REFUNDED') {
    return { handled: true, duplicate: true, organizationId: charge.organizationId };
  }

  // A second payment for something already paid: a renewal whose period
  // another charge captured, or a checkout link closed because another one was
  // paid. Both happen when a debit settles late after the job fell back to a
  // payment link, or a link we cancelled is paid anyway. The money goes back
  // rather than being applied as a second purchase.
  if (await isDuplicatePayment(charge)) {
    await refundDuplicate(charge, input.paymentId);
    return { handled: true, duplicate: true, organizationId: charge.organizationId };
  }

  const now = new Date();
  const interval = fromStored(charge.interval);
  // A first payment's period starts when it is paid, not when the link was made.
  const periodStart = charge.kind === 'FIRST' ? now : charge.periodStart;
  const periodEnd = charge.kind === 'FIRST' ? addInterval(now, interval) : charge.periodEnd;

  const payment = input.paymentId ? await fetchPayment(input.paymentId).catch(() => null) : null;
  // Read before the event below writes the new customer id over it: the old
  // mandate is deleted under the customer it was made for.
  const previous = await prisma.subscription.findUnique({
    where: { organizationId: charge.organizationId },
    select: { mandateTokenId: true, providerCustomerId: true },
  });

  const claimed = await prisma.billingCharge.updateMany({
    where: { id: charge.id, status: { notIn: ['CAPTURED', 'REFUNDED'] } },
    data: {
      status: 'CAPTURED',
      providerPaymentId: input.paymentId ?? charge.providerPaymentId,
      periodStart,
      periodEnd,
      failureReason: null,
    },
  });
  if (claimed.count === 0) {
    return { handled: true, duplicate: true, organizationId: charge.organizationId };
  }

  try {
    await applyCapturedCharge(charge, { payment, previous, periodEnd, now, raw: input.raw });
  } catch (error) {
    // The claim is undone, so the provider's retry of this webhook applies the
    // payment instead of being answered as a duplicate of one never applied.
    // Each step below is safe to repeat: the event is deduplicated by id and
    // the rest are writes of the same values.
    await prisma.billingCharge
      .updateMany({
        where: { id: charge.id, status: 'CAPTURED' },
        data: {
          status: charge.status,
          providerPaymentId: charge.providerPaymentId,
          periodStart: charge.periodStart,
          periodEnd: charge.periodEnd,
        },
      })
      .catch(() => undefined);
    throw error;
  }

  // Housekeeping after the money is applied. A failure here is logged, never
  // allowed to undo a payment that has already been recorded.
  try {
    // Other checkouts the owner started and left open would start a second
    // subscription and charge again if paid, so they are closed now.
    if (charge.kind === 'FIRST') {
      await closeOtherCheckouts(charge.organizationId, charge.id);
    }
    // Any other open charge for the same period is now moot.
    await closeOpenCharges(charge.subscriptionKey, charge.periodStart, charge.id, 'Paid by another charge.');
    await recordAuditEvent({
      organizationId: charge.organizationId,
      action: 'SUBSCRIPTION_UPDATED',
      targetType: 'billing_charge',
      targetId: charge.id,
      detail: {
        event: 'recurring_charge_captured',
        kind: charge.kind,
        channel: charge.channel,
        amountMinor: charge.amountMinor,
        plan: charge.plan,
        periodEnd: periodEnd.toISOString(),
        orderId: charge.providerOrderId,
      },
    });
  } catch (error) {
    console.error(
      `[billing] housekeeping after capturing ${charge.providerOrderId} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  return { handled: true, duplicate: false, organizationId: charge.organizationId };
}

/**
 * Whether a captured payment pays for something already paid.
 *
 * A renewal is a duplicate when another charge for the same period was
 * captured. A first payment is a duplicate when its link was closed (EXPIRED)
 * and the workspace already holds a different live subscription that is paid
 * through: the owner paid two checkouts.
 */
async function isDuplicatePayment(charge: BillingCharge): Promise<boolean> {
  if (charge.kind === 'RENEWAL') {
    const sibling = await prisma.billingCharge.findFirst({
      where: {
        subscriptionKey: charge.subscriptionKey,
        kind: 'RENEWAL',
        periodStart: charge.periodStart,
        status: 'CAPTURED',
        id: { not: charge.id },
      },
      select: { id: true },
    });
    return Boolean(sibling);
  }
  if (charge.kind === 'FIRST' && charge.status === 'EXPIRED') {
    const live = await prisma.subscription.findUnique({
      where: { organizationId: charge.organizationId },
      select: { providerSubscriptionId: true, status: true, currentPeriodEnd: true },
    });
    return Boolean(
      live?.providerSubscriptionId &&
        live.providerSubscriptionId !== charge.subscriptionKey &&
        ['ACTIVE', 'PAST_DUE'].includes(live.status) &&
        live.currentPeriodEnd &&
        live.currentPeriodEnd.getTime() > Date.now(),
    );
  }
  return false;
}

/** Refunds a duplicate payment in full and records why. Never throws. */
async function refundDuplicate(charge: BillingCharge, paymentId: string | null): Promise<void> {
  const id = paymentId ?? charge.providerPaymentId;
  const claimed = await prisma.billingCharge.updateMany({
    where: { id: charge.id, status: { notIn: ['CAPTURED', 'REFUNDED'] } },
    data: { status: 'REFUNDED', providerPaymentId: id, failureReason: 'Duplicate payment, refunded in full.' },
  });
  if (claimed.count === 0 || !id) {
    return;
  }
  try {
    const payment = await fetchPayment(id);
    const refund = await refundPayment({
      paymentId: id,
      amountMinor: payment.amountMinor,
      capturedMinor: payment.amountMinor,
      notes: { reason: 'duplicate payment', order: charge.providerOrderId },
    });
    await recordAuditEvent({
      organizationId: charge.organizationId,
      action: 'SUBSCRIPTION_UPDATED',
      targetType: 'billing_charge',
      targetId: charge.id,
      detail: {
        event: 'duplicate_payment_refunded',
        kind: charge.kind,
        orderId: charge.providerOrderId,
        paymentId: id,
        amountMinor: payment.amountMinor,
        refundId: refund.id,
      },
    });
  } catch (error) {
    // Left REFUNDED with the reason, and loud: support refunds it by hand.
    console.error(
      `[billing] DUPLICATE PAYMENT ${id} on ${charge.providerOrderId} for ${charge.organizationId} could not be refunded automatically: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    await prisma.billingCharge
      .update({ where: { id: charge.id }, data: { failureReason: 'Duplicate payment: the automatic refund failed. Refund it by hand.' } })
      .catch(() => undefined);
  }
}

/** Everything a captured charge changes. Each step is safe to run again. */
async function applyCapturedCharge(
  charge: BillingCharge,
  context: {
    payment: Awaited<ReturnType<typeof fetchPayment>> | null;
    previous: { mandateTokenId: string | null; providerCustomerId: string | null } | null;
    periodEnd: Date;
    now: Date;
    raw: unknown;
  },
): Promise<void> {
  const { payment, previous, periodEnd, now } = context;

  const event: BillingEvent = {
    providerEventId: `razorpay:charge:${charge.providerOrderId}`,
    type: charge.kind === 'FIRST' ? 'subscription.activated' : 'subscription.updated',
    provider: 'RAZORPAY',
    providerSubscriptionId: charge.subscriptionKey,
    providerCustomerId: payment?.customerId ?? null,
    organizationId: charge.organizationId,
    plan: charge.plan,
    status: 'active',
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
    quantity: charge.quantity,
    nextAttemptAt: null,
    // When we received it, not Razorpay's time: the reconciliation job stamps
    // `lastEventAt` with the time it runs, and a capture dated a few seconds
    // earlier would be refused as stale. The order id is the deduplication.
    occurredAt: now,
    raw: context.raw,
  };
  await applyBillingEvent(event);

  // A payment taken on a page (the first one, or a renewal by link) leaves a
  // new mandate behind; one taken on the mandate leaves it as it was.
  if (charge.channel === 'LINK' && payment?.tokenId && payment.customerId) {
    const token = await fetchToken(payment.customerId, payment.tokenId).catch(() => null);
    await prisma.subscription.update({
      where: { organizationId: charge.organizationId },
      data: {
        billingInterval: charge.interval,
        mandateTokenId: payment.tokenId,
        mandateMethod: token?.method ?? payment.method,
        mandateMaxMinor: token?.maxAmountMinor ?? null,
        mandateStatus: token?.status ?? 'initiated',
        providerCustomerId: payment.customerId,
      },
    });
    if (previous?.mandateTokenId && previous.mandateTokenId !== payment.tokenId && previous.providerCustomerId) {
      // The old mandate must not stay chargeable beside the new one.
      await deleteToken(previous.providerCustomerId, previous.mandateTokenId).catch((error: unknown) => {
        console.error(
          `[billing] old mandate ${previous.mandateTokenId} for ${charge.organizationId} was not deleted: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      });
    }
  } else {
    await prisma.subscription.update({
      where: { organizationId: charge.organizationId },
      data: { billingInterval: charge.interval },
    });
  }

  // The upgrade difference this charge carried is paid now. One statement, so
  // an upgrade recorded at the same moment cannot have its increment lost
  // between a read and a write. Last on purpose: if it throws, nothing after
  // it ran, and the retry that follows the undone claim subtracts it once.
  if (charge.carryOverMinor > 0) {
    await prisma.$executeRaw`
      UPDATE "subscription"
      SET "carryOverMinor" = GREATEST(0, "carryOverMinor" - ${charge.carryOverMinor})
      WHERE "organizationId" = ${charge.organizationId}
    `;
  }
}

/**
 * A charge failed. A renewal on the mandate makes the subscription past due,
 * which is what dunning acts on; the job then sends a payment link. A first
 * payment that fails changes nothing: the customer can try again on the page.
 */
export async function applyChargeFailed(input: {
  orderId: string;
  paymentId: string | null;
  reason: string | null;
  raw: unknown;
}): Promise<{ handled: boolean; organizationId: string | null }> {
  const charge = await prisma.billingCharge.findUnique({ where: { providerOrderId: input.orderId } });
  if (!charge) {
    return { handled: false, organizationId: null };
  }
  if (charge.status === 'CAPTURED') {
    return { handled: true, organizationId: charge.organizationId };
  }
  if (charge.kind === 'FIRST' || charge.channel === 'LINK') {
    // A declined attempt on a hosted page; the page stays open for another try.
    await prisma.billingCharge.update({
      where: { id: charge.id },
      data: { failureReason: (input.reason ?? 'Payment declined.').slice(0, 240) },
    });
    return { handled: true, organizationId: charge.organizationId };
  }
  await markChargeFailed(charge, input.reason ?? 'The bank declined the charge.', input.paymentId, input.raw);
  return { handled: true, organizationId: charge.organizationId };
}

/** A registration link closed unpaid. */
export async function applyLinkExpired(input: { orderId: string | null; invoiceId: string | null }): Promise<boolean> {
  const charge = input.orderId
    ? await prisma.billingCharge.findUnique({ where: { providerOrderId: input.orderId } })
    : input.invoiceId
      ? await prisma.billingCharge.findFirst({ where: { providerInvoiceId: input.invoiceId } })
      : null;
  if (!charge || charge.status === 'CAPTURED') {
    return Boolean(charge);
  }
  await prisma.billingCharge.update({
    where: { id: charge.id },
    data: { status: charge.kind === 'FIRST' ? 'EXPIRED' : 'FAILED', failureReason: 'The payment link expired unpaid.' },
  });
  return true;
}

/**
 * The mandate changed state at the bank: confirmed (eNACH confirms days after
 * it is signed), paused or cancelled by the customer in their UPI or bank app,
 * or rejected. A mandate that is not `confirmed` is not charged; the next
 * renewal goes out as a payment link instead.
 */
export async function applyTokenStatus(input: { tokenId: string; status: string; maxAmountMinor: number | null }): Promise<string | null> {
  const row = await prisma.subscription.findFirst({
    where: { mandateTokenId: input.tokenId },
    select: { organizationId: true, mandateStatus: true, providerCustomerId: true },
  });
  if (!row) {
    return null;
  }

  /**
   * The mandate's state as Razorpay holds it now, not as the event says.
   *
   * Token events carry no ordering guarantee and Razorpay's signature has no
   * timestamp, so a late or replayed `token.confirmed` arriving after
   * `token.cancelled` marked a cancelled mandate usable again. Reading the
   * token settles it; the event's word is used only when the read fails.
   */
  let status = input.status;
  let maxAmountMinor = input.maxAmountMinor;
  if (row.providerCustomerId) {
    const current = await fetchToken(row.providerCustomerId, input.tokenId).catch(() => null);
    if (current?.status) {
      status = current.status;
      maxAmountMinor = current.maxAmountMinor ?? maxAmountMinor;
    }
  }

  await prisma.subscription.update({
    where: { organizationId: row.organizationId },
    data: {
      mandateStatus: status,
      ...(maxAmountMinor ? { mandateMaxMinor: maxAmountMinor } : {}),
    },
  });
  if (row.mandateStatus !== status) {
    await recordAuditEvent({
      organizationId: row.organizationId,
      action: 'SUBSCRIPTION_UPDATED',
      targetType: 'subscription',
      targetId: input.tokenId,
      detail: { event: 'mandate_status_changed', from: row.mandateStatus, to: status },
    });
  }
  // An upgrade's difference rides on the next charge to this mandate. A
  // mandate that can no longer be charged takes the upgrade with it.
  if (['cancelled', 'rejected', 'paused'].includes(status)) {
    await revertUnpaidUpgrade(row.organizationId, 'mandate_unusable');
  }
  return row.organizationId;
}

/* --------------------------------------------------------------- job side */

type RenewableRow = {
  organizationId: string;
  plan: PlanTier;
  status: string;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pendingPlan: PlanTier | null;
  pendingPlanInterval: 'MONTHLY' | 'ANNUAL' | null;
  billingInterval: 'MONTHLY' | 'ANNUAL' | null;
  mandateTokenId: string | null;
  mandateMethod: string | null;
  mandateMaxMinor: number | null;
  mandateStatus: string | null;
  carryOverMinor: number;
};

export interface RenewalRunSummary {
  examined: number;
  scheduled: number;
  charged: number;
  linksSent: number;
  ended: number;
  failed: number;
}

/**
 * The renewal job: one pass over every recurring subscription.
 *
 * - Cancelled and past its period end: the plan ends and the mandate is deleted.
 * - Three days before the period end, on a usable mandate: an order is made
 *   with the pre-debit notice and the owner is told the amount and the date.
 * - Once the period has ended and the notice has run its 36 hours: the
 *   mandate is charged. The result arrives by webhook.
 * - Seven days before, when the mandate cannot carry the charge (paused,
 *   cancelled, rejected, below the amount), or after a charge on it failed:
 *   a payment link is sent instead, open until the failed-payment grace ends.
 *
 * Idempotent: each step looks for the charge row it would create first, so a
 * second run in the same hour does nothing.
 */
export async function runRecurringRenewals(now = new Date()): Promise<RenewalRunSummary> {
  const rows = (await prisma.subscription.findMany({
    where: {
      provider: 'RAZORPAY',
      providerSubscriptionId: { startsWith: 'rr_' },
      status: { in: ['ACTIVE', 'PAST_DUE'] },
      dunningStage: { not: 'WITHDRAWN' },
      currentPeriodEnd: { not: null },
    },
    select: {
      organizationId: true,
      plan: true,
      status: true,
      providerSubscriptionId: true,
      providerCustomerId: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      pendingPlan: true,
      pendingPlanInterval: true,
      billingInterval: true,
      mandateTokenId: true,
      mandateMethod: true,
      mandateMaxMinor: true,
      mandateStatus: true,
      carryOverMinor: true,
    },
  })) as RenewableRow[];

  const summary: RenewalRunSummary = { examined: rows.length, scheduled: 0, charged: 0, linksSent: 0, ended: 0, failed: 0 };
  for (const row of rows) {
    try {
      const outcome = await renewOne(row, now);
      if (outcome) summary[outcome] += 1;
    } catch (error) {
      summary.failed += 1;
      const detail = error instanceof Error ? error.message : 'Unknown renewal failure.';
      console.error(`[billing] recurring renewal for ${row.organizationId} failed: ${detail}`);
      await recordAuditEvent({
        organizationId: row.organizationId,
        action: 'SUBSCRIPTION_UPDATED',
        targetType: 'subscription',
        targetId: row.providerSubscriptionId ?? row.organizationId,
        detail: { event: 'recurring_renewal_failed', message: detail.slice(0, 240) },
      }).catch(() => undefined);
    }
  }
  return summary;
}

async function renewOne(row: RenewableRow, now: Date): Promise<keyof Omit<RenewalRunSummary, 'examined' | 'failed'> | null> {
  const key = row.providerSubscriptionId;
  const end = row.currentPeriodEnd;
  if (!key || !end || !isRecurringKey(key)) {
    return null;
  }

  if (row.cancelAtPeriodEnd) {
    if (end.getTime() <= now.getTime()) {
      await endRecurringSubscription(row.organizationId, { reason: 'cancelled', endAt: end });
      return 'ended';
    }
    return null;
  }

  if (end.getTime() - now.getTime() > linkLeadMs) {
    return null;
  }

  const charges = await prisma.billingCharge.findMany({
    where: { subscriptionKey: key, kind: 'RENEWAL', periodStart: end },
    orderBy: { attempt: 'desc' },
  });
  if (charges.some((charge) => charge.status === 'CAPTURED')) {
    return null;
  }
  const latest = charges[0] ?? null;

  /**
   * The paid period is over and the renewal is waiting on the customer.
   *
   * A renewal that could not go on the mandate (cancelled or paused in the
   * bank's app, above its limit) goes out as a payment link, and nothing on
   * that path ever made the subscription past due: an unpaid or expired link
   * left it ACTIVE, the plan stayed for good, and dunning, which acts on past
   * due rows, never ran. Now the period ending unpaid is itself the failure, so
   * the grace and the withdrawal follow as for a declined charge. A day with
   * nothing asked for at all (the contact details could not be read) counts
   * the same way. A charge still in flight (scheduled, or being debited) does
   * not: that is the bank being slow, not the customer not paying.
   */
  const awaitingCustomer =
    latest?.channel === 'LINK' && ['PENDING', 'FAILED', 'EXPIRED'].includes(latest.status);
  const nothingAsked = !latest && now.getTime() - end.getTime() > 24 * 60 * 60 * 1000;
  if (row.status === 'ACTIVE' && end.getTime() <= now.getTime() && (awaitingCustomer || nothingAsked)) {
    await markRenewalLapsed(row, end);
  }

  if (latest?.status === 'CHARGING') {
    await settleStaleCharge(latest, now);
    return null;
  }
  if (latest?.status === 'PENDING' && latest.channel === 'LINK') {
    return null;
  }
  if (latest?.status === 'SCHEDULED') {
    return (await chargeScheduled(row, latest, now)) ? 'charged' : null;
  }

  /**
   * A scheduled move to a smaller plan is checked again before it is priced.
   *
   * The limits are checked when the change is asked for, and nothing stopped a
   * workspace scheduling Fairway and then filling Harbor's limits before the
   * period ended: it renewed at Fairway's price with Harbor's portfolio, and
   * the resources over the limit kept working. Over the smaller plan's limits
   * at renewal, the change is withdrawn and the renewal is the current plan's;
   * the owner can remove the excess and schedule it again.
   */
  if (row.pendingPlan && row.pendingPlan !== row.plan) {
    const { planOverageFor } = await import('./checkout.service.js');
    const overage = await planOverageFor(row.organizationId, row.pendingPlan);
    if (overage.length > 0) {
      await prisma.subscription.updateMany({
        where: { organizationId: row.organizationId, pendingPlan: row.pendingPlan },
        data: { pendingPlan: null, pendingPlanInterval: null },
      });
      await recordAuditEvent({
        organizationId: row.organizationId,
        action: 'BILLING_PLAN_CHANGE_REFUSED',
        targetType: 'subscription',
        targetId: key,
        detail: { from: row.plan, to: row.pendingPlan, overage, at: 'renewal' },
      });
      row.pendingPlan = null;
      row.pendingPlanInterval = null;
    }
  }

  const interval = row.pendingPlan ? fromStored(row.pendingPlanInterval) : fromStored(row.billingInterval);
  const plan = row.pendingPlan ?? row.plan;
  const priced = await recurringChargeFor(row.organizationId, plan, interval);
  // A retry after a failure asks for the same amount; otherwise the plan's
  // price now plus what an upgrade this period still owes.
  const carried = latest?.status === 'FAILED' ? latest.carryOverMinor : row.carryOverMinor;
  const total = latest?.status === 'FAILED' ? latest.amountMinor : priced.amountMinor + row.carryOverMinor;

  const mandateUsable =
    Boolean(row.mandateTokenId && row.providerCustomerId) &&
    row.mandateStatus === 'confirmed' &&
    (row.mandateMaxMinor ?? 0) >= total;
  const tokenFailed = latest?.status === 'FAILED' && latest.channel === 'TOKEN';

  if (mandateUsable && !tokenFailed) {
    if (end.getTime() - now.getTime() > renewalLeadMs) {
      return null;
    }
    await scheduleTokenRenewal(row, { plan, interval, quantity: priced.quantity, amountMinor: total, carryOverMinor: carried, attempt: (latest?.attempt ?? 0) + 1, now });
    return 'scheduled';
  }

  const reason: RenewalLinkReason = tokenFailed
    ? 'charge_failed'
    : !row.mandateTokenId || row.mandateStatus !== 'confirmed'
      ? 'mandate_unusable'
      : 'above_maximum';
  await sendRenewalLink(row, { plan, interval, quantity: priced.quantity, amountMinor: total, carryOverMinor: carried, attempt: (latest?.attempt ?? 0) + 1, reason, now });
  return 'linksSent';
}

/**
 * The day of the month the subscription first started, in UTC, so every later
 * period ends on that day (or the month's last day when it is shorter). Null
 * for a subscription with no captured first payment.
 */
async function anchorDayFor(subscriptionKey: string): Promise<number | undefined> {
  const first = await prisma.billingCharge.findFirst({
    where: { subscriptionKey, kind: 'FIRST', status: 'CAPTURED' },
    select: { periodStart: true },
  });
  return first?.periodStart.getUTCDate();
}

/**
 * A receipt unique to one renewal attempt: the subscription, the period it
 * pays and the attempt. Razorpay refuses a registration link whose receipt it
 * has seen before, so the period date has to be in it. Within 40 characters.
 */
function renewalReceipt(key: string, periodStart: Date, attempt: number): string {
  const id = key.replace(/^rr_(order_)?/, '').slice(0, 14);
  const day = periodStart.toISOString().slice(0, 10).replace(/-/g, '');
  return `dh-r-${id}-${day}-${attempt}`;
}

async function scheduleTokenRenewal(
  row: RenewableRow,
  input: { plan: PlanTier; interval: BillingInterval; quantity: number; amountMinor: number; carryOverMinor: number; attempt: number; now: Date },
): Promise<void> {
  const end = row.currentPeriodEnd as Date;
  const key = row.providerSubscriptionId as string;
  const needsNotice = row.mandateMethod !== 'emandate';
  // Charged at the period end, or for a card or UPI mandate 36 hours after the
  // notice if that is later. eNACH has no notice wait.
  const paymentAfter = needsNotice ? new Date(Math.max(end.getTime(), input.now.getTime() + preDebitWaitMs)) : end;

  const order = await createRenewalOrder({
    amountMinor: input.amountMinor,
    receipt: renewalReceipt(key, end, input.attempt),
    notes: { organizationId: row.organizationId, kind: 'renewal', subscriptionKey: key, plan: input.plan },
    notification: needsNotice ? { tokenId: row.mandateTokenId as string, paymentAfter } : null,
  });

  await prisma.$transaction(async (tx) => {
    await tx.billingCharge.create({
      data: {
        organizationId: row.organizationId,
        subscriptionKey: key,
        provider: 'RAZORPAY',
        kind: 'RENEWAL',
        channel: 'TOKEN',
        providerOrderId: order.id,
        amountMinor: input.amountMinor,
        currency: 'INR',
        plan: input.plan,
        interval: toStored(input.interval),
        quantity: input.quantity,
        periodStart: end,
        periodEnd: addInterval(end, input.interval, await anchorDayFor(key)),
        status: 'SCHEDULED',
        attempt: input.attempt,
        // Cleared from the subscription when this charge is captured, not now.
        carryOverMinor: input.carryOverMinor,
      },
    });
  });

  sendRenewalNoticeEmail({
    organizationId: row.organizationId,
    plan: input.plan,
    amountMinor: input.amountMinor,
    chargeOn: paymentAfter,
    method: row.mandateMethod,
  });
}

/** How long a sent charge waits for its webhook before the job asks Razorpay itself. */
const chargeSettleAfterMs = 60 * 60 * 1000;
/** How long a charge may stay unanswered before the renewal falls back to a payment link. */
const chargeGiveUpAfterMs = 7 * 24 * 60 * 60 * 1000;

/**
 * A charge on the mandate whose result never arrived by webhook. Some banks
 * settle card mandates in batch files, so a payment can sit in `created` for
 * hours; once it has waited an hour the job reads the payment and applies a
 * capture or failure itself, so a lost webhook cannot leave the renewal open
 * for ever. A payment still in progress is left for the next run.
 */
async function settleStaleCharge(charge: BillingCharge, now: Date): Promise<void> {
  if (now.getTime() - charge.updatedAt.getTime() < chargeSettleAfterMs) {
    return;
  }

  /**
   * A charge request with no payment id is one whose answer never arrived (a
   * timeout, a dropped connection, a crash right after the call). The order is
   * ours and unique to this charge, so its payments say what happened. With
   * none at all after the settle wait, nothing was debited and the charge is
   * put back to be asked for again; it is never asked for blind.
   */
  let paymentId = charge.providerPaymentId;
  if (!paymentId) {
    const payments = await fetchOrderPayments(charge.providerOrderId).catch(() => null);
    if (payments === null) {
      return;
    }
    const found = payments.find((entry) => entry.status === 'captured') ?? payments[0] ?? null;
    if (!found) {
      await prisma.billingCharge.updateMany({
        where: { id: charge.id, status: 'CHARGING', providerPaymentId: null },
        data: { status: 'SCHEDULED' },
      });
      return;
    }
    paymentId = found.id;
    await prisma.billingCharge.updateMany({
      where: { id: charge.id, status: 'CHARGING' },
      data: { providerPaymentId: paymentId },
    });
  }

  const payment = await fetchPayment(paymentId).catch(() => null);
  if (payment?.status === 'captured') {
    await applyChargeCaptured({ orderId: charge.providerOrderId, paymentId, raw: { settledBy: 'renewal-job' } });
  } else if (payment?.status === 'failed') {
    await markChargeFailed(charge, payment.errorDescription ?? 'The bank declined the charge.', paymentId, { settledBy: 'renewal-job' });
  } else if (now.getTime() - charge.updatedAt.getTime() > chargeGiveUpAfterMs) {
    // A week with no answer from the bank: the renewal goes out as a link.
    // eNACH debits settle in days, over weekends and bank holidays, so this
    // waits well past them. Should the charge still capture later, the capture
    // is recognised as a second payment for the period and refunded.
    await markChargeFailed(charge, 'The bank did not confirm the charge within a week.', paymentId, { settledBy: 'renewal-job' });
  }
}

/** Charges a scheduled renewal once its notice has run. True when the charge was sent. */
async function chargeScheduled(row: RenewableRow, charge: BillingCharge, now: Date): Promise<boolean> {
  const end = row.currentPeriodEnd as Date;
  let earliest = end;
  if (row.mandateMethod !== 'emandate') {
    const notice = await fetchOrderNotification(charge.providerOrderId);
    if (!notice.deliveredAt) {
      // A notice the bank never received cannot be charged against. Give it a
      // day past the period end, then fall back to a payment link.
      if (now.getTime() > end.getTime() + 24 * 60 * 60 * 1000) {
        await markChargeFailed(charge, 'The pre-debit notice was not delivered to the bank.', null, null);
      }
      return false;
    }
    earliest = new Date(Math.max(end.getTime(), notice.deliveredAt.getTime() + preDebitWaitMs, notice.paymentAfter?.getTime() ?? 0));
  }
  if (now.getTime() < earliest.getTime()) {
    return false;
  }

  const contact = await customerContact(row);

  /**
   * Claimed before Razorpay is asked, never after.
   *
   * The row used to move to CHARGING only once the charge call returned. A
   * process that stopped in between (a deploy, a crash, a lease that lapsed
   * while another instance took the job) left it SCHEDULED, and the next run
   * charged the same order again. Now the claim is the only way to the call,
   * and a call whose answer never arrived stays CHARGING with no payment id,
   * which `settleStaleCharge` resolves from the order's own payments.
   */
  const claimed = await prisma.billingCharge.updateMany({
    where: { id: charge.id, status: 'SCHEDULED' },
    data: { status: 'CHARGING' },
  });
  if (claimed.count !== 1) {
    return false;
  }

  try {
    const result = await chargeToken({
      orderId: charge.providerOrderId,
      customerId: row.providerCustomerId as string,
      tokenId: row.mandateTokenId as string,
      amountMinor: charge.amountMinor,
      email: contact.email,
      contact: contact.contact,
      description: `${planCatalog[charge.plan].label} renewal`,
      notes: { organizationId: row.organizationId, kind: 'renewal', subscriptionKey: charge.subscriptionKey },
    });
    if (result.paymentId) {
      await prisma.billingCharge.update({
        where: { id: charge.id },
        data: { providerPaymentId: result.paymentId },
      });
    }
    return true;
  } catch (error) {
    const code = error instanceof BillingProviderError ? String(error.detail?.razorpayCode ?? '') : '';
    // Too early for the bank: put it back and try again on the next run.
    if (/pre_debit|NOT_HONOURED|promised_debit/i.test(code) || (error instanceof Error && /36 hours|pre-debit|predebit|payment_after/i.test(error.message))) {
      await prisma.billingCharge.updateMany({ where: { id: charge.id, status: 'CHARGING' }, data: { status: 'SCHEDULED' } });
      console.warn(
        `[billing] renewal ${charge.providerOrderId} not charged yet, the bank's notice window is still open: ${error instanceof Error ? error.message : code}`,
      );
      return false;
    }
    if (razorpayRefused(error)) {
      // Razorpay answered and refused, so no payment exists: a link follows.
      await markChargeFailed(charge, error instanceof Error ? error.message : 'The charge was refused.', null, null);
      return false;
    }
    // No clear answer: the debit may have been made. Left CHARGING, never
    // retried blind; the next runs read the order's payments to find out.
    console.warn(
      `[billing] renewal ${charge.providerOrderId} got no clear answer from Razorpay; it is settled from the order's payments: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return false;
  }
}

type RenewalLinkReason = 'mandate_unusable' | 'above_maximum' | 'charge_failed';

async function sendRenewalLink(
  row: RenewableRow,
  input: {
    plan: PlanTier;
    interval: BillingInterval;
    quantity: number;
    amountMinor: number;
    carryOverMinor: number;
    attempt: number;
    reason: RenewalLinkReason;
    now: Date;
  },
): Promise<void> {
  const end = row.currentPeriodEnd as Date;
  const key = row.providerSubscriptionId as string;
  const preferred = (row.mandateMethod ?? '') as MandateMethod;
  const method = methodAllowed(preferred, input.amountMinor) ? preferred : defaultMandateMethod(input.amountMinor);
  const contact = await customerContact(row);
  // Open until the failed-payment grace ends, when dunning withdraws the plan.
  const expireBy = new Date(Math.max(end.getTime() + renewalLinkGraceMs, input.now.getTime() + 24 * 60 * 60 * 1000));

  const link = await createRegistrationLink({
    method,
    amountMinor: input.amountMinor,
    maxAmountMinor: mandateMaxFor(method, input.amountMinor),
    customer: { name: contact.name, email: contact.email, contact: contact.contact },
    description: `${planCatalog[input.plan].label} plan renewal`,
    // A link after a failed charge on the mandate is a new receipt, not the order's.
    receipt: `${renewalReceipt(key, end, input.attempt)}-l`,
    expireBy,
    mandateExpiresAt: new Date(input.now.getTime() + mandateLifetimeMs),
    notes: { organizationId: row.organizationId, kind: 'renewal', subscriptionKey: key, plan: input.plan },
  });

  await prisma.$transaction(async (tx) => {
    await tx.billingCharge.create({
      data: {
        organizationId: row.organizationId,
        subscriptionKey: key,
        provider: 'RAZORPAY',
        kind: 'RENEWAL',
        channel: 'LINK',
        providerOrderId: link.orderId,
        providerInvoiceId: link.id,
        paymentUrl: link.shortUrl,
        amountMinor: input.amountMinor,
        currency: 'INR',
        plan: input.plan,
        interval: toStored(input.interval),
        quantity: input.quantity,
        periodStart: end,
        periodEnd: addInterval(end, input.interval, await anchorDayFor(key)),
        status: 'PENDING',
        attempt: input.attempt,
        carryOverMinor: input.carryOverMinor,
      },
    });
  });

  sendRenewalLinkEmail({
    organizationId: row.organizationId,
    plan: input.plan,
    amountMinor: input.amountMinor,
    payUrl: link.shortUrl,
    payBy: expireBy,
    reason: input.reason,
  });
}

/** The name, email and phone the customer paid with, read from their first payment. */
async function customerContact(row: RenewableRow): Promise<{ name: string; email: string; contact: string }> {
  const first = await prisma.billingCharge.findFirst({
    where: { subscriptionKey: row.providerSubscriptionId as string, status: 'CAPTURED', providerPaymentId: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { providerPaymentId: true },
  });
  const payment = first?.providerPaymentId ? await fetchPayment(first.providerPaymentId).catch(() => null) : null;
  const owner = await prisma.member.findFirst({
    where: { organizationId: row.organizationId, role: 'owner' },
    select: { user: { select: { name: true, email: true } } },
  });
  const email = payment?.email ?? owner?.user.email;
  const contact = payment?.contact;
  if (!email || !contact) {
    throw new BillingProviderError('The customer contact for this mandate could not be read.', 'CONTACT_UNKNOWN', 409);
  }
  return { name: owner?.user.name ?? email, email, contact };
}

async function markChargeFailed(charge: BillingCharge, reason: string, paymentId: string | null, raw: unknown): Promise<void> {
  const updated = await prisma.billingCharge.updateMany({
    where: { id: charge.id, status: { in: ['SCHEDULED', 'CHARGING', 'PENDING'] } },
    data: { status: 'FAILED', failureReason: reason.slice(0, 240), ...(paymentId ? { providerPaymentId: paymentId } : {}) },
  });
  if (updated.count === 0) {
    return;
  }
  const row = await prisma.subscription.findUnique({
    where: { organizationId: charge.organizationId },
    select: { plan: true, providerSubscriptionId: true, providerCustomerId: true },
  });
  if (!row || row.providerSubscriptionId !== charge.subscriptionKey) {
    return;
  }
  await applyBillingEvent({
    providerEventId: `razorpay:failed:${charge.providerOrderId}:${paymentId ?? charge.attempt}`,
    type: 'payment.failed',
    provider: 'RAZORPAY',
    providerSubscriptionId: charge.subscriptionKey,
    providerCustomerId: row.providerCustomerId,
    organizationId: charge.organizationId,
    plan: row.plan,
    status: 'past_due',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    quantity: null,
    nextAttemptAt: null,
    occurredAt: new Date(),
    raw: raw ?? { orderId: charge.providerOrderId, reason },
  });
}

/** A renewal whose period ended unpaid: past due, so dunning's grace and withdrawal apply. */
async function markRenewalLapsed(row: RenewableRow, end: Date): Promise<void> {
  await applyBillingEvent({
    providerEventId: `razorpay:lapsed:${row.providerSubscriptionId}:${end.toISOString()}`,
    type: 'payment.failed',
    provider: 'RAZORPAY',
    providerSubscriptionId: row.providerSubscriptionId,
    providerCustomerId: row.providerCustomerId,
    organizationId: row.organizationId,
    plan: row.plan,
    status: 'past_due',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    quantity: null,
    nextAttemptAt: null,
    occurredAt: new Date(),
    raw: { reason: 'renewal_unpaid', periodEnd: end.toISOString() },
  });
  row.status = 'PAST_DUE';
}

/**
 * Undoes an upgrade whose difference will never be collected.
 *
 * Paying in rupees, an upgrade applies at once and its difference for the rest
 * of the period is added to the next renewal. With no renewal to come (the
 * subscription was cancelled) or no way to charge it (the mandate was
 * cancelled, paused or rejected at the bank), the difference was simply
 * forgiven: buy Fairway for a year, upgrade to Admiralty the same day, cancel,
 * and keep Admiralty for twelve months at Fairway's price. The plan returns to
 * the one this period was paid at, and the owner is told.
 *
 * Returns the plan restored, or null when there was nothing to undo.
 */
export async function revertUnpaidUpgrade(
  organizationId: string,
  reason: 'cancelled' | 'mandate_unusable',
): Promise<PlanTier | null> {
  const row = await prisma.subscription.findUnique({
    where: { organizationId },
    select: {
      plan: true,
      carryOverMinor: true,
      providerSubscriptionId: true,
      currentPeriodEnd: true,
      pendingPlan: true,
      pendingPlanInterval: true,
      billingInterval: true,
    },
  });
  if (!row?.providerSubscriptionId || !isRecurringKey(row.providerSubscriptionId) || row.carryOverMinor <= 0 || !row.currentPeriodEnd) {
    return null;
  }

  // The plan the current period was paid at: the captured charge whose period
  // is the one the subscription is in.
  const paid = await prisma.billingCharge.findFirst({
    where: { subscriptionKey: row.providerSubscriptionId, status: 'CAPTURED', periodEnd: row.currentPeriodEnd },
    orderBy: { createdAt: 'desc' },
    select: { plan: true },
  });
  if (!paid || paid.plan === row.plan) {
    return null;
  }

  // A pending change back to the paid plan has nothing left to do once the
  // plan is that plan again, unless it also switches the interval.
  const pendingIsMoot = row.pendingPlan === paid.plan && row.pendingPlanInterval === row.billingInterval;
  const claimed = await prisma.$transaction(async (tx) => {
    const cleared = await tx.subscription.updateMany({
      where: { organizationId, carryOverMinor: row.carryOverMinor, plan: row.plan },
      data: { carryOverMinor: 0, ...(pendingIsMoot ? { pendingPlan: null, pendingPlanInterval: null } : {}) },
    });
    if (cleared.count !== 1) {
      return false;
    }
    await writePlan(tx, organizationId, paid.plan);
    return true;
  });
  if (!claimed) {
    return null;
  }

  await withdrawScheduledRenewals(organizationId);
  await afterPlanChange(organizationId, { from: row.plan, to: paid.plan });
  await recordAuditEvent({
    organizationId,
    action: 'SUBSCRIPTION_UPDATED',
    targetType: 'subscription',
    targetId: row.providerSubscriptionId,
    detail: {
      event: 'unpaid_upgrade_reverted',
      reason,
      from: row.plan,
      to: paid.plan,
      forgoneMinor: row.carryOverMinor,
    },
  });
  sendPlanChangedEmail({
    organizationId,
    fromPlan: row.plan,
    toPlan: paid.plan,
    effectiveAt: new Date(),
    timing: 'immediate',
  });
  return paid.plan;
}

/** Closes every other unpaid charge for a period: its link is cancelled, its row expired. */
async function closeOpenCharges(subscriptionKey: string, periodStart: Date, exceptId: string | null, reason: string): Promise<void> {
  const open = await prisma.billingCharge.findMany({
    where: {
      subscriptionKey,
      periodStart,
      status: { in: ['PENDING', 'SCHEDULED'] },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  });
  for (const charge of open) {
    if (charge.providerInvoiceId) {
      await cancelRegistrationLink(charge.providerInvoiceId);
    }
    await prisma.billingCharge.update({ where: { id: charge.id }, data: { status: 'EXPIRED', failureReason: reason } });
  }
}

/**
 * Closes a workspace's unpaid first-payment links, except `exceptId`: called
 * when one is paid and when a new checkout starts, so only one checkout can
 * ever be paid.
 */
export async function closeOtherCheckouts(organizationId: string, exceptId: string | null): Promise<void> {
  const open = await prisma.billingCharge.findMany({
    where: { organizationId, kind: 'FIRST', status: 'PENDING', ...(exceptId ? { id: { not: exceptId } } : {}) },
  });
  for (const charge of open) {
    if (charge.providerInvoiceId) {
      await cancelRegistrationLink(charge.providerInvoiceId);
    }
    await prisma.billingCharge.update({
      where: { id: charge.id },
      data: { status: 'EXPIRED', failureReason: 'Replaced by another checkout.' },
    });
  }
}

/**
 * Ends a recurring subscription: the plan falls to free once the paid period
 * is over (now, for a refund), the mandate is deleted at Razorpay so it can
 * never be charged again, and any open charge is closed.
 */
export async function endRecurringSubscription(
  organizationId: string,
  input: { reason: 'cancelled' | 'refunded' | 'withdrawn'; endAt: Date },
): Promise<void> {
  const row = await prisma.subscription.findUnique({
    where: { organizationId },
    select: {
      plan: true,
      status: true,
      dunningStage: true,
      providerSubscriptionId: true,
      providerCustomerId: true,
      mandateTokenId: true,
      currentPeriodEnd: true,
    },
  });
  if (!row?.providerSubscriptionId || !isRecurringKey(row.providerSubscriptionId)) {
    return;
  }

  if (row.mandateTokenId && row.providerCustomerId) {
    await deleteToken(row.providerCustomerId, row.mandateTokenId).catch((error: unknown) => {
      console.error(
        `[billing] mandate ${row.mandateTokenId} for ${organizationId} was not deleted when the subscription ended: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    });
  }
  const open = await prisma.billingCharge.findMany({
    where: { subscriptionKey: row.providerSubscriptionId, status: { in: ['PENDING', 'SCHEDULED'] } },
  });
  for (const charge of open) {
    if (charge.providerInvoiceId) await cancelRegistrationLink(charge.providerInvoiceId);
    await prisma.billingCharge.update({ where: { id: charge.id }, data: { status: 'EXPIRED', failureReason: `Subscription ${input.reason}.` } });
  }

  // Dunning has already moved a withdrawn workspace to free; nothing to apply.
  if (row.dunningStage !== 'WITHDRAWN' && ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(row.status)) {
    await applyBillingEvent({
      providerEventId: `razorpay:ended:${row.providerSubscriptionId}:${input.reason}:${input.endAt.toISOString()}`,
      type: 'subscription.cancelled',
      provider: 'RAZORPAY',
      providerSubscriptionId: row.providerSubscriptionId,
      providerCustomerId: row.providerCustomerId,
      organizationId,
      plan: row.plan,
      status: 'cancelled',
      currentPeriodEnd: input.endAt,
      cancelAtPeriodEnd: false,
      cancelAtPeriodEndAuthoritative: true,
      quantity: null,
      nextAttemptAt: null,
      occurredAt: new Date(),
      raw: { reason: input.reason },
    });
  }
  // Nothing more is owed on an ended subscription, so an upgrade difference
  // left over must not ride onto a later subscription that reuses the row.
  await prisma.subscription.update({
    where: { organizationId },
    data: { mandateStatus: row.mandateTokenId ? 'cancelled' : null, carryOverMinor: 0 },
  });
}

/** A renewal at the old price, made before an upgrade, is withdrawn so the job prices it again. */
export async function withdrawScheduledRenewals(organizationId: string): Promise<void> {
  const row = await prisma.subscription.findUnique({
    where: { organizationId },
    select: { providerSubscriptionId: true, currentPeriodEnd: true },
  });
  if (!row?.providerSubscriptionId || !row.currentPeriodEnd) return;
  await closeOpenCharges(row.providerSubscriptionId, row.currentPeriodEnd, null, 'Repriced after a plan change.');
}
