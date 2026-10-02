import { describe, expect, it } from 'vitest';
import { CheckoutError, quotaRank } from '../src/billing/checkout.service.js';

/**
 * The downgrade guard is a money path, so the cases that matter are the ones
 * where refusing would be wrong and the ones where allowing would cost money.
 */

describe('plan ladder order', () => {
  it('orders the plans from smallest to largest', () => {
    expect(quotaRank('MOORING')).toBeLessThan(quotaRank('FAIRWAY'));
    expect(quotaRank('FAIRWAY')).toBeLessThan(quotaRank('HARBOR'));
    expect(quotaRank('HARBOR')).toBeLessThan(quotaRank('ADMIRALTY'));
  });

  it('treats an unknown plan as smallest rather than throwing', () => {
    // A row with a plan this build does not know about must not take billing down.
    expect(quotaRank('NOT_A_PLAN' as never)).toBe(0);
  });
});

describe('plan change refusal structure', () => {
  it('carries the overage as data, not only as prose', () => {
    const error = new CheckoutError('Fairway allows 5 clients.', 'PLAN_CHANGE_OVER_QUOTA', 409, {
      overage: [{ quota: 'client', label: 'clients', used: 12, limit: 5, by: 7 }],
    });

    // The message alone forced the UI to either print a paragraph or regex the
    // sentence apart to recover the numbers the customer needs.
    expect(error.detail?.overage).toEqual([
      { quota: 'client', label: 'clients', used: 12, limit: 5, by: 7 },
    ]);
    expect(error.status).toBe(409);
  });

  it('leaves detail undefined when there is nothing structured to say', () => {
    expect(new CheckoutError('Something went wrong.').detail).toBeUndefined();
  });
});
