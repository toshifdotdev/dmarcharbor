/**
 * The rules of Razorpay Recurring Payments (INR), with no I/O.
 *
 * A mandate is the customer's standing permission to debit a card, a UPI
 * account or a bank account (eNACH) up to a maximum. We take the first payment
 * on a hosted registration link that also creates the mandate, then charge each
 * renewal on the saved mandate ourselves. Kept free of the database and the SDK
 * so the arithmetic that decides what a customer is charged can be unit tested.
 */

import type { BillingInterval } from './provider.js';

export type MandateMethod = 'card' | 'upi' | 'emandate';

export const mandateMethods: readonly MandateMethod[] = ['card', 'upi', 'emandate'];

/**
 * RBI's ceiling for an automatic card or UPI debit without the customer
 * approving each one (additional factor authentication), in paise: ₹15,000.
 */
export const noApprovalLimitMinor = 1_500_000;

/** The least a card or bank mandate is registered for, in paise: ₹1,00,000. */
export const mandateFloorMinor = 10_000_000;

/** How far ahead of the period end a renewal is scheduled and announced. */
export const renewalLeadMs = 3 * 24 * 60 * 60 * 1000;

/**
 * How far ahead a renewal that cannot go on the saved mandate (cancelled,
 * paused, rejected, or below the amount) is sent as a payment link instead.
 */
export const linkLeadMs = 7 * 24 * 60 * 60 * 1000;

/**
 * Razorpay debits a card or UPI mandate only 36 hours and 5 minutes after the
 * pre-debit notification is delivered; a few minutes more is our margin.
 */
export const preDebitWaitMs = (36 * 60 + 15) * 60 * 1000;

/** How long a first-payment registration link stays open. */
export const checkoutLinkTtlMs = 2 * 24 * 60 * 60 * 1000;

/** The mandate itself is registered for ten years; it ends sooner when cancelled. */
export const mandateLifetimeMs = 10 * 365 * 24 * 60 * 60 * 1000;

const recurringKeyPrefix = 'rr_';

/** The subscription id we keep for a recurring subscription: its first order, prefixed. */
export function recurringSubscriptionKey(firstOrderId: string): string {
  return `${recurringKeyPrefix}${firstOrderId}`;
}

/** True for a subscription billed on a mandate rather than a Razorpay subscription (`sub_…`). */
export function isRecurringKey(providerSubscriptionId: string | null | undefined): boolean {
  return Boolean(providerSubscriptionId?.startsWith(recurringKeyPrefix));
}

export interface MethodOption {
  method: MandateMethod;
  available: boolean;
  /** Said beside the option when it is available but has a catch. */
  note: string | null;
  /** Why it is not offered, when it is not. */
  unavailableReason: string | null;
}

/**
 * The ways a charge of this size can be set up, in the order offered.
 *
 * Up to ₹15,000 a card or UPI mandate debits on its own. Above it, a card
 * debit needs the customer to approve each charge, so eNACH (a bank mandate,
 * signed with netbanking or a debit card) is the default and a card is offered
 * with that said; UPI is not offered.
 */
export function methodOptions(chargeMinor: number): MethodOption[] {
  const small = chargeMinor <= noApprovalLimitMinor;
  return [
    {
      method: 'card',
      available: true,
      note: small ? null : 'Above ₹15,000 your bank asks you to approve each charge, so a renewal can wait on you.',
      unavailableReason: null,
    },
    {
      method: 'upi',
      available: small,
      note: null,
      unavailableReason: small ? null : 'UPI Autopay takes charges up to ₹15,000 on its own; this one is larger.',
    },
    {
      method: 'emandate',
      available: true,
      note: 'Signed with netbanking or a debit card. The bank can take up to two working days to confirm it.',
      unavailableReason: null,
    },
  ];
}

export function defaultMandateMethod(chargeMinor: number): MandateMethod {
  return chargeMinor <= noApprovalLimitMinor ? 'card' : 'emandate';
}

/** Whether this method may carry a charge of this size. */
export function methodAllowed(method: MandateMethod, chargeMinor: number): boolean {
  return methodOptions(chargeMinor).some((option) => option.method === method && option.available);
}

/**
 * The maximum one charge on the mandate may be.
 *
 * Room for growth (a Fleet portfolio, an upgrade) without asking the customer
 * to sign again: the larger of ₹1,00,000 or twice the charge. A UPI mandate is
 * held at ₹15,000, the most it debits without approval.
 */
export function mandateMaxFor(method: MandateMethod, chargeMinor: number): number {
  if (method === 'upi') {
    return noApprovalLimitMinor;
  }
  return Math.max(mandateFloorMinor, 2 * Math.ceil(chargeMinor));
}

/**
 * One billing period on from `start`: the same day next month (or next year),
 * in UTC, clamped to the month's last day (31 January plus a month is 28 or 29
 * February, never 3 March).
 *
 * `anchorDay` is the day of the month the subscription started on. Without it
 * a plan bought on 31 January renews on 28 February and then on the 28th for
 * ever; with it the renewal goes back to the 31st (or the month's last day)
 * each month, the way Paddle bills and the way people expect.
 */
export function addInterval(start: Date, interval: BillingInterval, anchorDay?: number): Date {
  const months = interval === 'annual' ? 12 : 1;
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay ?? start.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(year, month, day, start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()),
  );
}

/** The start of the period that ends at `end`. */
export function subtractInterval(end: Date, interval: BillingInterval): Date {
  const months = interval === 'annual' ? 12 : 1;
  const year = end.getUTCFullYear();
  const month = end.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(end.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(year, month, day, end.getUTCHours(), end.getUTCMinutes(), end.getUTCSeconds(), end.getUTCMilliseconds()),
  );
}

/**
 * What an upgrade made part way through a paid period owes, added to the next
 * renewal: the price difference for the share of the period still to run,
 * rounded to the paisa. Never negative: a cheaper plan waits for the period end.
 */
export function upgradeCarryOverMinor(input: {
  fromMinor: number;
  toMinor: number;
  periodStart: Date;
  periodEnd: Date;
  now: Date;
}): number {
  const total = input.periodEnd.getTime() - input.periodStart.getTime();
  const remaining = input.periodEnd.getTime() - input.now.getTime();
  if (total <= 0 || remaining <= 0 || input.toMinor <= input.fromMinor) {
    return 0;
  }
  const share = Math.min(1, remaining / total);
  return Math.round((input.toMinor - input.fromMinor) * share);
}

/** How a method is named to a customer. */
export function methodLabel(method: string | null | undefined): string {
  switch (method) {
    case 'card':
      return 'card';
    case 'upi':
      return 'UPI Autopay';
    case 'emandate':
      return 'bank mandate (eNACH)';
    default:
      return 'payment method';
  }
}
