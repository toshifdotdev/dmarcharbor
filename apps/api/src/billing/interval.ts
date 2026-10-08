/**
 * Deciding whether a subscription is billed monthly or annually.
 *
 * `Subscription` does not record it. `BillingPlan` does, but only reachable
 * through the provider's plan id, and the subscription stores the provider's
 * *subscription* id instead, so there is no local join that answers the
 * question. The consequence was real: `refundEligibility` read
 * `prices.monthlyMinor` unconditionally, so an annual Harbor customer who paid
 * 1,24,990 was quoted a refund of 12,499 - one tenth of what they were charged,
 * on a number that decides whether money moves.
 *
 * So the interval is inferred from the shape of the billing cycle, which is
 * recorded, and the inference is honest about being an inference.
 */

import type { BillingInterval } from './provider.js';

export interface IntervalGuess {
  interval: BillingInterval;
  /**
   * How it was decided, so a caller can tell a measurement from a fallback.
   *
   * `'remaining'` means the paid period had more of it left than a monthly cycle
   * can hold. `'cycle'` means the period the last charge bought was a year long.
   * `'default'` means nothing was known and monthly was assumed, which
   * understates rather than overstates what a customer should get back.
   */
  basis: 'remaining' | 'cycle' | 'default';
}

/**
 * A quarter plus, comfortably past any monthly cycle.
 *
 * The catalog makes annual exactly ten months of monthly, so a real monthly
 * value is 30 days and a real annual one is 365. Both boundaries sit far from
 * 238 and nothing realistic lands near them.
 */
const LONG_CYCLE_MS = 238 * 24 * 60 * 60 * 1000;

/**
 * Annual when the cycle is a year long, read from whichever signal is decisive.
 *
 * Neither measurement is sufficient alone, which is why both are tried and in a
 * specific order.
 *
 * Remaining time (`currentPeriodEnd` minus today) is bounded above by the cycle
 * it measures, so a long-running monthly subscription can never be mistaken for
 * an annual one. It fails at the other end: an annual subscription with three
 * weeks left has three weeks of remaining time, indistinguishable from a monthly
 * one.
 *
 * The cycle the last charge bought (`currentPeriodEnd` minus `firstChargeAt`)
 * answers that case exactly, because the purchase date and the end of the period
 * it paid for are both historical once the charge exists. It cannot be used on
 * its own, though, and this is the subtle part: `firstChargeAt` is stamped once
 * and never moves, while `currentPeriodEnd` advances on every renewal. So the
 * gap grows without bound - eight months into a monthly subscription the gap
 * reads as nine months of cycle - and a long-standing monthly customer would be
 * quoted an annual price and refunded at the annual rate.
 *
 * The way through is that the two signals are only both trustworthy inside the
 * charge's own first cycle, which is exactly the window where `firstChargeAt` has
 * not yet been overtaken by a renewal. Inside it, remaining time and the cycle
 * are the same measurement and always agree, so the cycle is redundant rather
 * than necessary. Outside it - a renewal has happened, or the charge is long
 * past - remaining time is the only signal that has not been invalidated, and it
 * is allowed to answer.
 *
 * Which leaves the case that cannot be resolved: a charge that bought a year
 * long cycle, essentially all of which has now been used, and then renewed. In
 * that window remaining time is short and the cycle is invalid, so nothing local
 * distinguishes it from a monthly subscription. That is where a real answer
 * needs the provider's plan id, which the subscription does not store, and the
 * honest outcome is the monthly default with `basis: 'default'` rather than a
 * number the code cannot stand behind.
 */
export function resolveBillingInterval(
  currentPeriodEnd: Date | null,
  firstChargeAt: Date | null,
  now: Date = new Date(),
): IntervalGuess {
  if (!currentPeriodEnd) {
    return { interval: 'monthly', basis: 'default' };
  }

  const remainingMs = currentPeriodEnd.getTime() - now.getTime();
  if (remainingMs > LONG_CYCLE_MS) {
    // A cycle with more than a monthly amount of time left can only be annual.
    return { interval: 'annual', basis: 'remaining' };
  }

  if (firstChargeAt && now.getTime() < firstChargeAt.getTime() + LONG_CYCLE_MS) {
    // Still inside the charge's own first cycle, so the period it bought is
    // still the one being paid for and the gap measures something real.
    const cycleMs = currentPeriodEnd.getTime() - firstChargeAt.getTime();
    if (cycleMs > LONG_CYCLE_MS) {
      return { interval: 'annual', basis: 'cycle' };
    }
    return { interval: 'monthly', basis: 'cycle' };
  }

  // A renewal has happened, or the charge is long past, and what is left of the
  // period is too short to be annual on its own. Nothing local can settle it.
  return { interval: 'monthly', basis: 'default' };
}

/**
 * Amounts, labelled the way a bank statement would label them.
 *
 * The refund screen prints this beside the amount, because "12,499" on its own
 * does not tell a customer which charge they are being asked to compare it
 * against, and the whole point of the figure is that comparison.
 */
export function intervalLabel(interval: BillingInterval): string {
  return interval === 'annual' ? 'annual' : 'monthly';
}
