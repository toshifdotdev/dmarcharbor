import { describe, expect, it } from 'vitest';
import { intervalLabel, resolveBillingInterval } from '../src/billing/interval.js';

/**
 * The billing interval is not stored anywhere, so it has to be read out of the
 * shape of the billing cycle. Getting this wrong quotes a refund of a tenth of
 * what an annual customer paid, so both measurements, the order they are tried
 * in, and the cases where nothing can be known are pinned here rather than left
 * to the integration suite.
 */

const DAY = 24 * 60 * 60 * 1000;

describe('resolveBillingInterval', () => {
  it('reads a charge that bought a year long cycle as annual', () => {
    const charge = new Date('2026-01-01T00:00:00Z');

    // Straight after purchase: a year of remaining time, decisive on its own.
    expect(
      resolveBillingInterval(new Date(charge.getTime() + 365 * DAY), charge, new Date('2026-01-02T00:00:00Z')),
    ).toEqual({ interval: 'annual', basis: 'remaining' });
  });

  it('reads a charge that bought a monthly cycle as monthly', () => {
    const charge = new Date('2026-01-01T00:00:00Z');

    // Inside the charge's own first cycle, with only a fortnight left.
    expect(
      resolveBillingInterval(new Date(charge.getTime() + 30 * DAY), charge, new Date(charge.getTime() + 14 * DAY)),
    ).toEqual({ interval: 'monthly', basis: 'cycle' });
  });

  /**
   * The case that cannot be resolved, and why it is better to say so.
   *
   * An annual charge whose period has almost run out and then been renewed is
   * locally indistinguishable from a monthly subscription: too little time left
   * to be annual on its own, and too far past the charge for the cycle to still
   * mean what it meant when it was bought. A real answer needs the provider's
   * plan id, which the subscription does not store. Returning monthly here
   * understates rather than overstates what a customer is owed.
   */
  it('says it does not know rather than guessing annual when a renewal has overtaken the charge', () => {
    const charge = new Date('2025-01-01T00:00:00Z');
    const now = new Date('2026-01-10T00:00:00Z');
    // A year in, six days left of a cycle that was renewed.
    const periodEnd = new Date('2026-01-16T00:00:00Z');

    expect(resolveBillingInterval(periodEnd, charge, now)).toEqual({
      interval: 'monthly',
      basis: 'default',
    });
  });

  /**
   * Remaining time is bounded above by the cycle it measures, so it cannot be
   * fooled by a long-running monthly subscription. This is the case that breaks
   * any measurement anchored on the charge: `firstChargeAt` never moves and
   * `currentPeriodEnd` advances every renewal, so the gap grows without bound
   * and eight months in it reads as nine months of cycle.
   */
  it('keeps answering monthly for a monthly cycle however long it has been running', () => {
    const now = new Date('2026-09-01T00:00:00Z');
    const originalCharge = new Date('2025-01-01T00:00:00Z');
    // Eight months of monthly renewals. The original charge is long past and
    // the gap to the period end is more than half a year, which is why the
    // cycle signal has to stay out of this.
    const periodEnd = new Date('2026-09-20T00:00:00Z');

    const result = resolveBillingInterval(periodEnd, originalCharge, now);

    // Not annual. That is the part that matters most here: monthly cycles must
    // never be read as annual, because that quotes ten times the refund.
    expect(result.interval).toBe('monthly');
    // And it is honest that the answer is not a measurement, because nothing
    // local distinguishes it from a renewed annual subscription.
    expect(result.basis).toBe('default');
  });

  it('reads a year long remaining period as annual even with no charge on record', () => {
    expect(
      resolveBillingInterval(new Date(Date.now() + 400 * DAY), null, new Date()),
    ).toEqual({ interval: 'annual', basis: 'remaining' });
  });

  it('falls back to monthly and marks the fallback when there is nothing to read', () => {
    expect(resolveBillingInterval(null, null)).toEqual({ interval: 'monthly', basis: 'default' });
    expect(resolveBillingInterval(null, new Date())).toEqual({ interval: 'monthly', basis: 'default' });
    // A period end in the past with nothing else to go on.
    expect(
      resolveBillingInterval(new Date('2020-01-01T00:00:00Z'), null, new Date()),
    ).toEqual({ interval: 'monthly', basis: 'default' });
  });

  it('puts the long-cycle boundary well clear of both real values', () => {
    const charge = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-02T00:00:00Z');
    const boundary = 238 * DAY;

    expect(boundary).toBeGreaterThan(30 * DAY * 4);
    expect(boundary).toBeLessThan(365 * DAY);

    expect(resolveBillingInterval(new Date(charge.getTime() + boundary - DAY), charge, now).interval).toBe('monthly');
    expect(resolveBillingInterval(new Date(charge.getTime() + boundary + DAY), charge, now).interval).toBe('annual');
  });

  it('labels the interval the way a charge on a statement is labelled', () => {
    expect(intervalLabel('monthly')).toBe('monthly');
    expect(intervalLabel('annual')).toBe('annual');
  });
});
