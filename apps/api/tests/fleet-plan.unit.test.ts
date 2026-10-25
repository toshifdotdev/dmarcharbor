import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  catalogOrder,
  formatPlanPrice,
  formatPrice,
  nextTier,
  perDomainPlans,
  planCatalog,
  planOrder,
  previousTier,
} from '../src/services/entitlements/plan-catalog.js';
import {
  entitlementRefusalMessage,
  planCatalogResponse,
  quotaUsage,
  requiredPlanFor,
} from '../src/services/entitlements/entitlement.service.js';
import { billableQuantity } from '../src/billing/quantity.js';
import { expectedPlans } from '../src/billing/plans.js';
import { assertValidQuantity, BillingProviderError } from '../src/billing/provider.js';
import {
  paddleQuantityUpdateBody,
} from '../src/billing/paddle.provider.js';
import { razorpayQuantityUpdateBody } from '../src/billing/razorpay.provider.js';
import { reconcileEventId } from '../src/billing/subscription-state.js';
import { parseQuantity } from '../src/billing/webhook.service.js';

vi.mock('../src/services/entitlements/entitlement.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/entitlements/entitlement.service.js')>();
  return { ...actual, quotaUsage: vi.fn() };
});

const FLEET = planCatalog.FLEET;

beforeEach(() => {
  vi.mocked(quotaUsage).mockReset();
  vi.mocked(quotaUsage).mockResolvedValue({ used: 0, limit: 5000 });
});

describe('Fleet in the catalog', () => {
  it('grants exactly Harbor features and nothing Admiralty sells', () => {
    expect(FLEET.features).toBe(planCatalog.HARBOR.features);
    expect(FLEET.features['branding.whitelabel']).toBe(false);
    expect(FLEET.features['branding.logoUpload']).toBe(false);
    expect(FLEET.features['auth.sso']).toBe(false);
  });

  it('is monthly only', () => {
    expect(FLEET.intervals).toEqual(['monthly']);
    expect(FLEET.pricing).toBe('per_domain');
    expect(FLEET.minimumQuantity).toBe(75);
  });

  it('never undercuts Harbor at the minimum, in either currency', () => {
    for (const currency of ['USD', 'INR'] as const) {
      const minimumTotal = FLEET.prices[currency].monthlyMinor * FLEET.minimumQuantity!;
      expect(minimumTotal, currency).toBeGreaterThanOrEqual(planCatalog.HARBOR.prices[currency].monthlyMinor);
    }
  });

  it('is not a rung on the ladder and does not change tier navigation', () => {
    expect(planOrder).toEqual(['MOORING', 'FAIRWAY', 'HARBOR', 'ADMIRALTY']);
    expect(perDomainPlans).toEqual(['FLEET']);
    expect(catalogOrder).toEqual([...planOrder, 'FLEET']);
    expect(nextTier('FLEET')).toBeNull();
    expect(previousTier('FLEET')).toBeNull();
    expect(planOrder.map((tier) => nextTier(tier))).not.toContain('FLEET');
  });

  it('serves /plans in reading order with Fleet last', () => {
    const response = planCatalogResponse() as unknown as Array<{ tier: string; pricing: string; minimumQuantity: number | null }>;

    expect(response.map((plan) => plan.tier)).toEqual(catalogOrder);
    expect(response.at(-1)?.tier).toBe('FLEET');
    expect(response.at(-1)?.pricing).toBe('per_domain');
    expect(response.at(-1)?.minimumQuantity).toBe(75);
  });

  it('prices a per-domain plan by the unit, never by a zero annual placeholder', () => {
    expect(formatPrice('FLEET', 'USD', 'annual')).toBe('$2');
    expect(formatPrice('FLEET', 'INR', 'annual')).toBe('\u20b9169');
    expect(formatPlanPrice('FLEET', 'USD', 'monthly', 75)).toBe('$150');
    expect(formatPlanPrice('FLEET', 'INR', 'monthly', 75)).toBe('\u20b912,675');
    expect(formatPlanPrice('FLEET', 'USD', 'monthly', 120)).toBe('$240');
    // Flat plans are unchanged and ignore quantity.
    expect(formatPlanPrice('HARBOR', 'USD', 'monthly', 75)).toBe('$149');
    expect(formatPlanPrice('HARBOR', 'USD', 'annual', 75)).toBe('$1,490');
  });

  it('adds exactly one monthly provider plan and leaves the six flat ones alone', () => {
    for (const currency of ['USD', 'INR'] as const) {
      const plans = expectedPlans(currency);
      expect(plans).toHaveLength(7);
      const fleet = plans.filter((plan) => plan.tier === 'FLEET');
      expect(fleet).toEqual([
        { tier: 'FLEET', interval: 'monthly', priceMinor: planCatalog.FLEET.prices[currency].monthlyMinor },
      ]);
    }
  });
});

describe('feature refusals stay on the ladder', () => {
  it('names the same plans as before for the existing tiers', () => {
    expect(entitlementRefusalMessage('auth.sso', 'Mooring')).toBe(
      'Single sign-on is not included in Mooring. Upgrade to Admiralty to use it.',
    );
    expect(entitlementRefusalMessage('auth.sso', 'Fairway')).toBe(
      'Single sign-on is not included in Fairway. Upgrade to Admiralty to use it.',
    );
    expect(entitlementRefusalMessage('auth.sso', 'Harbor')).toBe(
      'Single sign-on is not included in Harbor. Upgrade to Admiralty to use it.',
    );
    expect(entitlementRefusalMessage('api.access', 'Mooring')).toBe(
      'API access is not included in Mooring. Upgrade to Harbor to use it.',
    );
  });

  it('never points at Fleet, whatever its unit price', () => {
    for (const feature of ['auth.sso', 'branding.whitelabel', 'branding.logoUpload', 'api.access'] as const) {
      expect(requiredPlanFor(feature)).not.toBe('FLEET');
    }
    expect(requiredPlanFor('auth.sso')).toBe('ADMIRALTY');
    expect(requiredPlanFor('api.access')).toBe('HARBOR');
  });
});

describe('billable quantity', () => {
  it('bills the flat plan as one unit', async () => {
    vi.mocked(quotaUsage).mockResolvedValue({ used: 12, limit: 80 });

    await expect(billableQuantity('org-1', 'HARBOR')).resolves.toEqual({
      quantity: 1,
      activeDomains: 12,
      minimum: null,
    });
  });

  it('charges the minimum below 75 active domains', async () => {
    vi.mocked(quotaUsage).mockResolvedValue({ used: 10, limit: 5000 });

    await expect(billableQuantity('org-1', 'FLEET')).resolves.toEqual({
      quantity: 75,
      activeDomains: 10,
      minimum: 75,
    });
  });

  it('charges the measured count above the minimum', async () => {
    vi.mocked(quotaUsage).mockResolvedValue({ used: 120, limit: 5000 });

    const result = await billableQuantity('org-1', 'FLEET');
    expect(result.quantity).toBe(120);
    expect(result.activeDomains).toBe(120);
    expect(result.minimum).toBe(75);
    // The count must be the account-wide active-domain quota, measured with
    // Fleet's own window, never a number supplied by the caller.
    expect(quotaUsage).toHaveBeenCalledWith('org-1', 'activeDomain', 'FLEET', expect.any(Date), expect.anything());
  });
});

describe('provider quantity payloads', () => {
  it('schedules a Razorpay quantity change at cycle end', () => {
    expect(razorpayQuantityUpdateBody(140)).toEqual({ quantity: 140, schedule_change_at: 'cycle_end' });
  });

  it('sends Paddle a quantity change with no proration', () => {
    expect(paddleQuantityUpdateBody('pri_fleet_monthly', 140)).toEqual({
      items: [{ priceId: 'pri_fleet_monthly', quantity: 140 }],
      prorationBillingMode: 'do_not_bill',
    });
  });

  it('refuses a quantity that is not a whole number from 1 to 5000', () => {
    expect(() => assertValidQuantity(1)).not.toThrow();
    expect(() => assertValidQuantity(5000)).not.toThrow();

    for (const bad of [0, 5001, 2.5]) {
      try {
        assertValidQuantity(bad);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(BillingProviderError);
        expect(error).toMatchObject({ code: 'BAD_QUANTITY', status: 422 });
      }
    }
  });
});

describe('webhook quantity parsing and reconciliation identity', () => {
  it('accepts only a positive integer quantity', () => {
    expect(parseQuantity(140)).toBe(140);
    expect(parseQuantity(undefined)).toBeNull();
    expect(parseQuantity(0)).toBeNull();
    expect(parseQuantity(2.5)).toBeNull();
    expect(parseQuantity('140')).toBeNull();
  });

  it('includes the quantity in the reconciliation event id', () => {
    const periodEnd = new Date('2026-10-25T00:00:00.000Z');
    const base = { currentPeriodEnd: periodEnd, status: 'active' as const };

    expect(reconcileEventId('org-1', { ...base, quantity: 140 })).toBe(
      'reconcile:org-1:2026-10-25T00:00:00.000Z:active:140',
    );
    expect(reconcileEventId('org-1', { ...base, quantity: null })).toContain(':na');
    expect(reconcileEventId('org-1', { ...base, quantity: 140 })).not.toBe(
      reconcileEventId('org-1', { ...base, quantity: 141 }),
    );
  });
});
