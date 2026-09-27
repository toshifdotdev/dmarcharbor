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

export interface PlanDefinition {
  tier: PlanTier;
  label: string;
  descriptor: string;
  priceMonthlyUsd: number;
  priceAnnualUsd: number;
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
    priceMonthlyUsd: 0,
    priceAnnualUsd: 0,
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
    priceMonthlyUsd: 19,
    priceAnnualUsd: 190,
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
    priceMonthlyUsd: 79,
    priceAnnualUsd: 790,
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
    priceMonthlyUsd: 249,
    priceAnnualUsd: 2490,
    maxClients: 75,
    maxActiveDomains: 300,
    maxMembers: 25,
    dataRetentionDays: 3650,
    auditRetentionDays: 3650,
    features: allFeatures(),
  },
};

export const planOrder: PlanTier[] = ['MOORING', 'FAIRWAY', 'HARBOR', 'ADMIRALTY'];

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
