import type { PlanTier, SubscriptionStatus } from '@prisma/client';

export type PlanTierName = PlanTier;

export type EntitlementKey =
  | 'reports.aggregate'
  | 'reports.forensic'
  | 'reports.forensicNamed'
  | 'alerts.email'
  | 'alerts.spoofing'
  | 'rollout.canary'
  | 'sharing.links'
  | 'digests'
  | 'audit.trail'
  | 'portal.client'
  | 'branding.whitelabel'
  | 'api.access'
  | 'auth.sso'
  | 'data.export'
  | 'data.erase';

export type QuotaKey = 'client' | 'activeDomain' | 'member';

/**
 * Currencies a plan can be sold in.
 *
 * The catalog holds both rather than a single price so the same plan ladder
 * serves an Indian agency and a European one. Which currency is actually
 * charged is decided at checkout by the provider, not here.
 */
export type BillingCurrency = 'USD' | 'INR';

export const billingCurrencies: readonly BillingCurrency[] = ['USD', 'INR'];

/** Whole currency units, never a floating point fraction of money. */
export interface PlanPrice {
  /** Paise for INR, cents for USD. */
  monthlyMinor: number;
  annualMinor: number;
}

export interface PlanDefinition {
  tier: PlanTier;
  label: string;
  descriptor: string;
  prices: Record<BillingCurrency, PlanPrice>;
  maxClients: number;
  maxActiveDomains: number;
  maxMembers: number;
  dataRetentionDays: number;
  auditRetentionDays: number;
  features: Record<EntitlementKey, boolean>;
}

const allFeatures = (overrides: Partial<Record<EntitlementKey, boolean>> = {}): Record<EntitlementKey, boolean> => ({
  'reports.aggregate': true,
  'reports.forensic': true,
  'reports.forensicNamed': true,
  'alerts.email': true,
  'alerts.spoofing': true,
  'rollout.canary': true,
  'sharing.links': true,
  digests: true,
  'audit.trail': true,
  'portal.client': true,
  'branding.whitelabel': true,
  'api.access': true,
  'auth.sso': true,
  'data.export': true,
  'data.erase': true,
  ...overrides,
});

/**
 * The legal floor. Data portability and the right to erasure are statutory in
 * the EU, the UK and California, so they can never be paywalled. Every plan
 * must grant them, and a test asserts that across the whole catalog so a later
 * pricing change cannot quietly make compliance a paid feature.
 */
export const alwaysAllowedEntitlements: readonly EntitlementKey[] = ['data.export', 'data.erase'];

/**
 * Entitlements that are deliberately priced but not yet enforced.
 *
 * These belong to a plan tier in the catalog, yet there is no code path that
 * can turn them on, so there is nothing to gate. They are listed here rather
 * than left out of the catalog so the door stays open, and so the audit test
 * can tell an intentional omission apart from an oversight.
 *
 * `auth.sso` and `rollout.canary` are commercial promises, not working
 * features. Neither may appear in checkout, a public plan comparison or any
 * other marketing surface until the code that delivers it exists, because
 * selling them early is a chargeback waiting to happen.
 */
export const plannedEntitlements: readonly EntitlementKey[] = ['auth.sso', 'rollout.canary'];

/**
 * Features granted on every plan, so there is no gate to write.
 *
 * Aggregate reporting is what a free user exists to see, and the audit trail
 * is the trust signal that makes an MSP willing to hand over a client list in
 * the first place. Neither is a paid differentiator.
 */
export const alwaysOnEntitlements: readonly EntitlementKey[] = ['reports.aggregate', 'audit.trail'];

const off = { 'alerts.spoofing': false, 'rollout.canary': false, digests: false } as const;
const noForensic = { 'reports.forensic': false, 'reports.forensicNamed': false } as const;
const noNamedForensic = { 'reports.forensicNamed': false } as const;
const noAlerts = { 'alerts.email': false } as const;
const noSharing = { 'sharing.links': false, digests: false } as const;
const noPortal = { 'portal.client': false } as const;
const noApi = { 'api.access': false } as const;
const noSso = { 'auth.sso': false } as const;
const noBrand = { 'branding.whitelabel': false } as const;

export const planCatalog: Record<PlanTier, PlanDefinition> = {
  MOORING: {
    tier: 'MOORING',
    label: 'Mooring',
    descriptor: 'Watch a couple of domains while you decide.',
    prices: { USD: { monthlyMinor: 0, annualMinor: 0 }, INR: { monthlyMinor: 0, annualMinor: 0 } },
    maxClients: 1,
    maxActiveDomains: 2,
    maxMembers: 1,
    dataRetentionDays: 30,
    auditRetentionDays: 30,
    features: allFeatures({ ...noAlerts, ...noForensic, ...noSharing, ...noPortal, ...noApi, ...noSso, ...noBrand, ...off }),
  },
  FAIRWAY: {
    tier: 'FAIRWAY',
    label: 'Fairway',
    descriptor: 'Quarantine without rejection. Run a small client book.',
    prices: { USD: { monthlyMinor: 1900, annualMinor: 19000 }, INR: { monthlyMinor: 159900, annualMinor: 1599000 } },
    maxClients: 5,
    maxActiveDomains: 20,
    maxMembers: 3,
    dataRetentionDays: 365,
    auditRetentionDays: 365,
    features: allFeatures({ ...noNamedForensic, ...noPortal, ...noApi, ...noSso, ...noBrand }),
  },
  HARBOR: {
    tier: 'HARBOR',
    label: 'Harbor',
    descriptor: 'Full enforcement with named forensic evidence and client portal.',
    prices: { USD: { monthlyMinor: 7900, annualMinor: 79000 }, INR: { monthlyMinor: 659900, annualMinor: 6599000 } },
    maxClients: 20,
    maxActiveDomains: 80,
    maxMembers: 10,
    dataRetentionDays: 1095,
    auditRetentionDays: 1095,
    features: allFeatures({ ...noSso, ...noBrand }),
  },
  ADMIRALTY: {
    tier: 'ADMIRALTY',
    label: 'Admiralty',
    descriptor: 'White label, API and SSO for large portfolios.',
    prices: { USD: { monthlyMinor: 24900, annualMinor: 249000 }, INR: { monthlyMinor: 2099900, annualMinor: 20999000 } },
    maxClients: 75,
    maxActiveDomains: 300,
    maxMembers: 25,
    dataRetentionDays: 3650,
    auditRetentionDays: 3650,
    features: allFeatures(),
  },
};

export const planOrder: PlanTier[] = ['MOORING', 'FAIRWAY', 'HARBOR', 'ADMIRALTY'];

/**
 * Smallest currency unit for a currency. INR divides into 100 paise, and USD
 * into 100 cents, but they are different units, so a helper is safer than
 * remembering which is which at a call site.
 */
const minorUnitDigits = 2;

export function formatPrice(plan: PlanTier, currency: BillingCurrency, interval: 'monthly' | 'annual'): string {
  const amount = planCatalog[plan].prices[currency][interval === 'monthly' ? 'monthlyMinor' : 'annualMinor'];

  if (amount === 0) {
    return 'Free';
  }

  const major = amount / 10 ** minorUnitDigits;
  const formatted = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(major);

  return `${currency === 'INR' ? '\u20b9' : '$'}${formatted}`;
}

/**
 * The rough rate used only to show an Indian buyer what a USD price means.
 *
 * This is a display convenience, never a conversion for charging. The amount a
 * customer is billed is always the price in the currency they check out in, so
 * a stale rate here can mislead but can never overcharge.
 */
export const displayRateUsdToInr = 84;

export function formatPriceWithConversion(
  plan: PlanTier,
  currency: BillingCurrency,
  interval: 'monthly' | 'annual',
): { primary: string; secondary: string | null } {
  const primary = formatPrice(plan, currency, interval);
  if (currency === 'INR') {
    return { primary, secondary: null };
  }

  const amount = planCatalog[plan].prices.USD[interval === 'monthly' ? 'monthlyMinor' : 'annualMinor'];
  if (amount === 0) {
    return { primary, secondary: null };
  }

  const major = amount / 10 ** minorUnitDigits;
  const inr = Math.round((major * displayRateUsdToInr) / 100) * 100;

  return { primary, secondary: `\u2248 \u20b9${new Intl.NumberFormat('en-IN').format(inr)}` };
}

export function planLabel(tier: PlanTier): string {
  return planCatalog[tier].label;
}

export function nextTier(tier: PlanTier): PlanTier | null {
  const index = planOrder.indexOf(tier);
  if (index < 0 || index === planOrder.length - 1) {
    return null;
  }
  return planOrder[index + 1] ?? null;
}

export function previousTier(tier: PlanTier): PlanTier | null {
  const index = planOrder.indexOf(tier);
  if (index <= 0) {
    return null;
  }
  return planOrder[index - 1] ?? null;
}

export function quotaLimitFor(tier: PlanTier, quota: QuotaKey): number {
  const plan = planCatalog[tier];
  switch (quota) {
    case 'client':
      return plan.maxClients;
    case 'activeDomain':
      return plan.maxActiveDomains;
    case 'member':
      return plan.maxMembers;
    default:
      return 0;
  }
}

export function quotaLabel(quota: QuotaKey): string {
  switch (quota) {
    case 'client':
      return 'clients';
    case 'activeDomain':
      return 'active domains';
    case 'member':
      return 'team members';
    default:
      return quota;
  }
}

/**
 * Resolves the plan a subscription actually grants right now. Cancelling keeps
 * access until the paid period ends, a lapsed trial drops to Mooring, and a
 * past due card stays on the current plan so billing can attempt a retry
 * instead of locking a customer out mid month.
 */
export function effectivePlan(
  subscription: { plan: PlanTier; status: SubscriptionStatus; currentPeriodEnd: Date | null } | null,
  now = new Date(),
): PlanTier {
  if (!subscription) {
    return 'MOORING';
  }

  const paidThrough = subscription.currentPeriodEnd && subscription.currentPeriodEnd.getTime() > now.getTime();

  if (subscription.status === 'TRIALING') {
    return paidThrough ? subscription.plan : 'MOORING';
  }

  if (subscription.status === 'CANCELLED' || subscription.status === 'EXPIRED') {
    return paidThrough ? subscription.plan : 'MOORING';
  }

  return subscription.plan;
}
