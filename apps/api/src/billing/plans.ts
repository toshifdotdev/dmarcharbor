import type { BillingCurrency as CurrencyEnum, BillingInterval as IntervalEnum, PlanTier } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { planCatalog, type BillingCurrency } from '../services/entitlements/plan-catalog.js';
import type { BillingInterval } from './provider.js';

type CurrencyCode = BillingCurrency;

/**
 * The bridge between our catalog and a provider's plan objects.
 *
 * Our price and tier live in code, because they are the product decision. The
 * provider's plan id lives in the database, because a plan can equally be
 * created by an operator on the provider's dashboard, and the mapping has to
 * survive a deploy and be readable during support.
 *
 * A checkout that cannot find a stored plan for the requested tier, interval
 * and currency fails rather than guessing a price. Charging the wrong amount
 * is the one failure this whole layer exists to prevent.
 */

export class BillingPlanError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'BILLING_PLAN_ERROR', status = 400) {
    super(message);
    this.name = 'BillingPlanError';
    this.code = code;
    this.status = status;
  }
}

const intervalToEnum: Record<BillingInterval, IntervalEnum> = {
  monthly: 'MONTHLY',
  annual: 'ANNUAL',
};

const enumToInterval: Record<IntervalEnum, BillingInterval> = {
  MONTHLY: 'monthly',
  ANNUAL: 'annual',
};

const currencyToEnum: Record<CurrencyCode, CurrencyEnum> = {
  USD: 'USD',
  INR: 'INR',
};

const enumToCurrency: Record<CurrencyEnum, CurrencyCode> = {
  USD: 'USD',
  INR: 'INR',
};

export interface StoredPlan {
  id: string;
  provider: string;
  tier: PlanTier;
  interval: BillingInterval;
  currency: CurrencyCode;
  priceMinor: number;
  providerPlanId: string;
  active: boolean;
}

/** What the catalog says a plan should cost, for a given interval. */
export function catalogPriceMinor(tier: PlanTier, interval: BillingInterval, currency: CurrencyCode): number {
  const prices = planCatalog[tier].prices as Record<BillingCurrency, { monthlyMinor: number; annualMinor: number }>;
  const bucket = prices[currency];
  if (!bucket) {
    throw new BillingPlanError(`We do not sell ${tier} in ${currency}.`, 'CURRENCY_UNSUPPORTED', 400);
  }
  return interval === 'monthly' ? bucket.monthlyMinor : bucket.annualMinor;
}

/**
 * Every plan combination the catalog defines for a currency, excluding the free
 * tier. A free plan has no provider plan because there is nothing to charge.
 */
export function expectedPlans(currency: CurrencyCode): { tier: PlanTier; interval: BillingInterval; priceMinor: number }[] {
  const tiers: PlanTier[] = ['FAIRWAY', 'HARBOR', 'ADMIRALTY'];
  const intervals: BillingInterval[] = ['monthly', 'annual'];

  return tiers.flatMap((tier) =>
    intervals.map((interval) => ({ tier, interval, priceMinor: catalogPriceMinor(tier, interval, currency) })),
  );
}

export async function findStoredPlan(input: {
  provider: string;
  tier: PlanTier;
  interval: BillingInterval;
  currency: CurrencyCode;
}): Promise<StoredPlan | null> {
  const row = await prisma.billingPlan.findUnique({
    where: {
      provider_tier_interval_currency: {
        provider: input.provider as never,
        tier: input.tier,
        interval: intervalToEnum[input.interval],
        currency: currencyToEnum[input.currency],
      },
    },
  });

  return row ? toStoredPlan(row) : null;
}

/**
 * Resolves the provider plan to charge, or explains why it cannot.
 *
 * The stored price is checked against the catalog on every lookup rather than
 * only when the plan is saved, so a price change in code that has not been
 * pushed to the provider is caught at checkout instead of silently billing the
 * old amount.
 */
export async function requireStoredPlan(input: {
  provider: string;
  tier: PlanTier;
  interval: BillingInterval;
  currency: CurrencyCode;
}): Promise<StoredPlan> {
  const stored = await findStoredPlan(input);
  if (!stored) {
    throw new BillingPlanError(
      `${input.provider} has no ${input.interval} ${input.tier} plan stored in ${input.currency}. Run the plan sync before accepting payment for it.`,
      'PLAN_NOT_SYNCED',
      503,
    );
  }

  if (!stored.active) {
    throw new BillingPlanError(`That plan is no longer on sale.`, 'PLAN_RETIRED', 409);
  }

  const expected = catalogPriceMinor(input.tier, input.interval, input.currency);
  if (stored.priceMinor !== expected) {
    throw new BillingPlanError(
      `The stored price for ${input.tier} ${input.interval} in ${input.currency} does not match the catalog. Run the plan sync before accepting payment.`,
      'PLAN_PRICE_DRIFT',
      503,
    );
  }

  return stored;
}

/**
 * Records or refreshes a plan mapping.
 *
 * Uses an upsert so re-running the sync is safe, and refuses to store a price
 * that disagrees with the catalog. That is the point of the sync: it should be
 * impossible to end up charging a price the product does not advertise.
 */
export async function saveStoredPlan(input: {
  provider: string;
  tier: PlanTier;
  interval: BillingInterval;
  currency: CurrencyCode;
  priceMinor: number;
  providerPlanId: string;
  active?: boolean;
}): Promise<StoredPlan> {
  const expected = catalogPriceMinor(input.tier, input.interval, input.currency);
  if (input.priceMinor !== expected) {
    throw new BillingPlanError(
      `Refusing to store ${input.tier} ${input.interval} in ${input.currency} at ${input.priceMinor}, because the catalog says ${expected}.`,
      'PLAN_PRICE_MISMATCH',
      422,
    );
  }

  const row = await prisma.billingPlan.upsert({
    where: {
      provider_tier_interval_currency: {
        provider: input.provider as never,
        tier: input.tier,
        interval: intervalToEnum[input.interval],
        currency: currencyToEnum[input.currency],
      },
    },
    create: {
      provider: input.provider as never,
      tier: input.tier,
      interval: intervalToEnum[input.interval],
      currency: currencyToEnum[input.currency],
      priceMinor: input.priceMinor,
      providerPlanId: input.providerPlanId,
      active: input.active ?? true,
    },
    update: {
      priceMinor: input.priceMinor,
      providerPlanId: input.providerPlanId,
      active: input.active ?? true,
    },
  });

  return toStoredPlan(row);
}

/** Resolves a stored plan from the provider's plan id, as seen on a live subscription. */
export async function findStoredPlanByProviderPlanId(
  provider: string,
  providerPlanId: string,
): Promise<StoredPlan | null> {
  const row = await prisma.billingPlan.findFirst({ where: { provider: provider as never, providerPlanId } });
  return row ? toStoredPlan(row) : null;
}

export async function listStoredPlans(provider: string): Promise<StoredPlan[]> {
  const rows = await prisma.billingPlan.findMany({ where: { provider: provider as never }, orderBy: [{ tier: 'asc' }, { interval: 'asc' }] });
  return rows.map(toStoredPlan);
}

/**
 * Reports which catalog plans are missing a provider mapping, so a sync can be
 * shown what it still has to create.
 */
export async function planSyncReport(provider: string, currency: CurrencyCode): Promise<
  { tier: PlanTier; interval: BillingInterval; priceMinor: number; providerPlanId: string | null; status: 'missing' | 'ready' | 'price_drift' }[]
> {
  const expected = expectedPlans(currency);
  const stored = await listStoredPlans(provider);
  const byKey = new Map(stored.map((plan) => [`${plan.tier}:${plan.interval}:${plan.currency}`, plan]));

  return expected.map((plan) => {
    const match = byKey.get(`${plan.tier}:${plan.interval}:${currency}`);
    if (!match) {
      return { ...plan, providerPlanId: null, status: 'missing' };
    }
    if (match.priceMinor !== plan.priceMinor) {
      return { ...plan, providerPlanId: match.providerPlanId, status: 'price_drift' };
    }
    return { ...plan, providerPlanId: match.providerPlanId, status: 'ready' };
  });
}

function toStoredPlan(row: {
  id: string;
  provider: string;
  tier: PlanTier;
  interval: IntervalEnum;
  currency: CurrencyEnum;
  priceMinor: number;
  providerPlanId: string;
  active: boolean;
}): StoredPlan {
  return {
    id: row.id,
    provider: row.provider,
    tier: row.tier,
    interval: enumToInterval[row.interval],
    currency: enumToCurrency[row.currency],
    priceMinor: row.priceMinor,
    providerPlanId: row.providerPlanId,
    active: row.active,
  };
}

export { intervalToEnum, currencyToEnum, enumToInterval, enumToCurrency };
