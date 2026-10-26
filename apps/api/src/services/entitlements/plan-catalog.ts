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
  | 'data.erase'
  | 'trust.center'
  | 'reports.compliancePack'
  | 'reports.inbox'
  | 'branding.logoUpload'
  | 'integrations.webhooks'
  | 'senders.owners'
  | 'dns.automation'
  | 'dns.hosted';

export type QuotaKey = 'client' | 'activeDomain' | 'member';

/**
 * What each entitlement is called in a sentence a person reads. Refusals used
 * to open with the raw key ("auth.sso is not included in Harbor"). The same
 * wording as the web app's plan comparison (apps/web/lib/plan-features.ts).
 */
export const entitlementLabels: Record<EntitlementKey, string> = {
  'reports.aggregate': 'Aggregate DMARC reporting',
  'reports.forensic': 'Forensic reporting',
  'reports.forensicNamed': 'Named forensic evidence',
  'alerts.email': 'Email alerts',
  'alerts.spoofing': 'Spoofing alerts',
  'rollout.canary': 'Staged policy rollout',
  'sharing.links': 'Report share links',
  digests: 'Scheduled report digests',
  'audit.trail': 'The audit trail',
  'portal.client': 'The client portal',
  'branding.whitelabel': 'White label',
  'api.access': 'API access',
  'auth.sso': 'Single sign-on',
  'data.export': 'Data export',
  'data.erase': 'Data erasure',
  'trust.center': 'The Trust Center',
  'reports.compliancePack': 'The compliance pack',
  'reports.inbox': 'Report collection from your own mailbox',
  'branding.logoUpload': 'Logo upload',
  'integrations.webhooks': 'Webhooks',
  'senders.owners': 'Sender owners',
  'dns.automation': 'Publish DNS records through Cloudflare',
  'dns.hosted': 'Hosted DMARC record',
};

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
  /**
   * How the plan is charged: a flat price for the interval, or per active
   * domain. A per-domain plan's `prices` hold the unit price.
   */
  pricing: 'flat' | 'per_domain';
  /** The intervals this plan can be bought on. FLEET is monthly only. */
  intervals: ('monthly' | 'annual')[];
  /** The least quantity a per-domain plan bills. Null for a flat plan. */
  minimumQuantity: number | null;
  maxClients: number;
  maxActiveDomains: number;
  maxMembers: number;
  /**
   * How many workspaces this plan allows its owner to hold.
   *
   * Bounded rather than open on purpose. An uncapped free tier is a farm: every
   * extra Mooring workspace is another client and another two domains monitored at
   * no cost, so the limit is what makes the client and domain limits mean anything.
   *
   * The allowance is read from the strongest plan the account holds, not summed,
   * because the plan a customer has paid for is the plan they get the workspaces
   * from. Owning one Admiralty workspace already bought the entitlement.
   */
  maxWorkspaces: number;
  /**
   * How long a domain keeps counting toward `maxActiveDomains` after its last
   * report (countCountedDomainsIn). A quota rule, not a retention period.
   *
   * This was `dataRetentionDays`, beside an `auditRetentionDays` that nothing
   * read, and both looked like promises about how long data is kept. They were
   * not: retention is the same on every plan and is set per deployment
   * (REPORT_RETENTION_DAYS, FORENSIC_RETENTION_DAYS, FORENSIC_PII_RETENTION_DAYS),
   * and the audit log is kept indefinitely as the record of what was done. The
   * Trust Center and the compliance pack publish those real windows. Plans
   * differ by quotas and features, never by how long evidence survives, so a
   * downgrade never deletes history.
   */
  activeDomainWindowDays: number;
  features: Record<EntitlementKey, boolean>;
}

const allFeatures = (overrides: Partial<Record<EntitlementKey, boolean>> = {}): Record<EntitlementKey, boolean> => ({
  'reports.aggregate': true,
  'reports.forensic': true,
  'reports.forensicNamed': true,
  'alerts.email': true,
  'alerts.spoofing': true,
  'sharing.links': true,
  digests: true,
  'audit.trail': true,
  'portal.client': true,
  // Granted at Admiralty. Provisioned members are bounded by the connection's
  // email domain allowlist and can never be handed the owner role, so an
  // identity provider is a way to admit a workspace's own staff and not a way to
  // hand out ownership.
  'auth.sso': true,
  'rollout.canary': false,
  'branding.whitelabel': true,
  'api.access': true,
  'data.export': true,
  'data.erase': true,
  'trust.center': true,
  'reports.compliancePack': true,
  'reports.inbox': true,
  'branding.logoUpload': true,
  'integrations.webhooks': true,
  'senders.owners': true,
  'dns.automation': true,
  'dns.hosted': true,
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
 * `rollout.canary` is the only one: a commercial promise, not a working
 * feature. It may not appear in checkout, a public plan comparison or any
 * other marketing surface until the code that delivers it exists, because
 * selling it early is a chargeback waiting to happen.
 */
export const plannedEntitlements: readonly EntitlementKey[] = ['rollout.canary'];

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
/**
 * The public API (keys, /api/v1) starts at Harbor.
 *
 * Harbor is the plan an agency runs a real client book on (20 clients, 80
 * domains), and that is where bulk onboarding and scripted verification stop
 * being a convenience: dmarcian keeps its API for Enterprise, so an API at the
 * middle tier is a reason to move. It costs little to serve (seven endpoints,
 * rate limited per key). Admiralty is sold on white label, SSO and size, not
 * on the API. Harbor has always granted it, so nothing is taken from anyone.
 */
const noApi = { 'api.access': false } as const;
const noSso = { 'auth.sso': false } as const;
// Logo upload ships with white labelling, so the two travel together.
const noBrand = { 'branding.whitelabel': false, 'branding.logoUpload': false } as const;
/**
 * Scheduled client digests start at Harbor.
 *
 * Fairway used to include them and now does not. The ladder is meant to read
 * as watch, act, prove, resell, and a recurring emailed digest is a proof
 * artefact: it asserts what we concluded and keeps showing up in the client's
 * inbox whether or not anyone acts on it. Charging for it at Fairway meant a
 * small agency paid for scheduled outbound mail it had no use for, while the
 * forensic and enforcement work they were actually buying sat below it.
 *
 * Deliberately a downgrade in the ladder rather than a removal: a Fairway
 * workspace that had digests configured keeps the rows and simply stops being
 * sent them, because silently deleting a client's digest history would destroy
 * the audit trail the feature exists to create.
 */
const noDigests = { digests: false } as const;

/**
 * The Trust Center and the compliance pack are enterprise procurement gates, so
 * both start at Harbor rather than being Admiral only. A pack that only the
 * largest plan can produce is a trophy nobody reaches.
 */
const noTrustCenter = { 'trust.center': false, 'reports.compliancePack': false } as const;

/**
 * Emailed report collection starts at Harbor.
 *
 * The feature exists so a workspace can stop polling for DNS published reports
 * it already has, and the mailbox is the fragile part: credentials, a
 * third party mail host and a UID cursor that can fall behind. Charging for it
 * at a tier where the volume justifies that upkeep, rather than giving every
 * free account a credential to store.
 */
const noInbox = { 'reports.inbox': false } as const;

/**
 * Webhooks and sender owners start at Fairway.
 *
 * DNS monitoring runs on every plan, so without a gate a free workspace could
 * receive the same change and report events by webhook that email and Slack
 * reserve for paid plans. The endpoint rows are kept on a downgrade, exactly
 * like digests, so an upgrade resumes delivery without reconfiguration.
 * Sender owners are a review workflow for a real client book; the service
 * names, evidence and approved / not-ours decisions remain available to
 * everyone because they are what makes the Senders table readable at all.
 */
const noIntegrations = { 'integrations.webhooks': false, 'senders.owners': false } as const;

/**
 * Publishing DNS records starts at Fairway with the other integrations.
 *
 * The Cloudflare token is a credential a workspace chooses to store, and the
 * feature removes the last copy-paste between adding a domain and enforcing a
 * policy. Mooring keeps its connection on a downgrade so it can be removed or
 * resumed, but publishing is refused until the plan grants it again.
 */
const noDnsAutomation = { 'dns.automation': false } as const;

/**
 * Hosted DMARC records start at Fairway with the other DNS automation.
 * On a downgrade the last value keeps being served; only changes pause.
 */
const noDnsHosted = { 'dns.hosted': false } as const;

/**
 * Harbor's feature set, shared by FLEET rather than copied.
 *
 * FLEET is Harbor's features for a much larger portfolio. A copy would drift
 * the first time either plan changed, and the promise is exactly that the two
 * grant the same things.
 */
const harborFeatures = allFeatures({ ...noSso, ...noBrand, 'trust.center': true });

export const planCatalog: Record<PlanTier, PlanDefinition> = {
  MOORING: {
    tier: 'MOORING',
    label: 'Mooring',
    descriptor: 'Watch a couple of domains while you decide.',
    prices: { USD: { monthlyMinor: 0, annualMinor: 0 }, INR: { monthlyMinor: 0, annualMinor: 0 } },
    pricing: 'flat',
    intervals: ['monthly', 'annual'],
    minimumQuantity: null,
    maxClients: 1,
    maxActiveDomains: 2,
      maxMembers: 1,
      maxWorkspaces: 1,
    activeDomainWindowDays: 30,
    features: allFeatures({ ...noAlerts, ...noForensic, ...noSharing, ...noPortal, ...noApi, ...noSso, ...noBrand, ...noTrustCenter, ...noInbox, ...noIntegrations, ...noDnsAutomation, ...noDnsHosted, ...off }),
  },
  FAIRWAY: {
    tier: 'FAIRWAY',
    label: 'Fairway',
    descriptor: 'Quarantine without rejection. Run a small client book.',
    prices: { USD: { monthlyMinor: 2900, annualMinor: 29000 }, INR: { monthlyMinor: 249900, annualMinor: 2499000 } },
    pricing: 'flat',
    intervals: ['monthly', 'annual'],
    minimumQuantity: null,
    maxClients: 5,
    maxActiveDomains: 20,
      maxMembers: 3,
      maxWorkspaces: 2,
    activeDomainWindowDays: 365,
    features: allFeatures({ ...noNamedForensic, ...noPortal, ...noApi, ...noSso, ...noBrand, ...noTrustCenter, ...noInbox, ...noDigests }),
  },
  HARBOR: {
    tier: 'HARBOR',
    label: 'Harbor',
    descriptor: 'Full enforcement with named forensic evidence, client portal and API.',
    prices: { USD: { monthlyMinor: 14900, annualMinor: 149000 }, INR: { monthlyMinor: 1249900, annualMinor: 12499000 } },
    pricing: 'flat',
    intervals: ['monthly', 'annual'],
    minimumQuantity: null,
    maxClients: 20,
    maxActiveDomains: 80,
      maxMembers: 10,
      maxWorkspaces: 3,
    activeDomainWindowDays: 1095,
    features: harborFeatures,
  },
  ADMIRALTY: {
    tier: 'ADMIRALTY',
    label: 'Admiralty',
    descriptor: 'White label and SSO for large portfolios.',
    prices: { USD: { monthlyMinor: 39900, annualMinor: 399000 }, INR: { monthlyMinor: 3399900, annualMinor: 33999000 } },
    pricing: 'flat',
    intervals: ['monthly', 'annual'],
    minimumQuantity: null,
    maxClients: 75,
    maxActiveDomains: 300,
      maxMembers: 25,
      maxWorkspaces: 5,
    activeDomainWindowDays: 3650,
    features: allFeatures(),
  },
  /**
   * Harbor's features for larger portfolios, billed per active domain.
   *
   * Never cheaper than Harbor at the minimum, and never a route to white label
   * or SSO: those stay Admiralty-only, which is what keeps the two plans from
   * competing for the same buyer.
   */
  FLEET: {
    tier: 'FLEET',
    label: 'Fleet',
    descriptor: "Harbor's features for larger portfolios, billed per active domain.",
    prices: { USD: { monthlyMinor: 200, annualMinor: 0 }, INR: { monthlyMinor: 16900, annualMinor: 0 } },
    pricing: 'per_domain',
    intervals: ['monthly'],
    minimumQuantity: 75,
    maxClients: 1000,
    maxActiveDomains: 5000,
    maxMembers: 25,
    maxWorkspaces: 5,
    activeDomainWindowDays: 30,
    features: harborFeatures,
  },
};

export const planOrder: PlanTier[] = ['MOORING', 'FAIRWAY', 'HARBOR', 'ADMIRALTY'];

/** Plans priced per domain rather than per interval. */
export const perDomainPlans: PlanTier[] = ['FLEET'];

/**
 * Every plan in the order a buyer reads them: the ladder first, then the
 * per-domain plans. A per-domain unit price is not a rung on the ladder.
 */
export const catalogOrder: PlanTier[] = [...planOrder, ...perDomainPlans];

/**
 * Smallest currency unit for a currency. INR divides into 100 paise, and USD
 * into 100 cents, but they are different units, so a helper is safer than
 * remembering which is which at a call site.
 */
const minorUnitDigits = 2;

function formatAmount(amount: number, currency: BillingCurrency): string {
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

export function formatPrice(plan: PlanTier, currency: BillingCurrency, interval: 'monthly' | 'annual'): string {
  const definition = planCatalog[plan];
  // A per-domain plan's price is a unit price. It has one interval, so asking
  // for an annual figure must not read the zero placeholder and say "Free".
  const amount =
    definition.pricing === 'per_domain'
      ? definition.prices[currency].monthlyMinor
      : definition.prices[currency][interval === 'monthly' ? 'monthlyMinor' : 'annualMinor'];

  return formatAmount(amount, currency);
}

/**
 * The total a given quantity costs on a plan.
 *
 * Flat plans ignore the quantity. A per-domain plan multiplies its monthly unit
 * price, falling back to the billed minimum when the caller has not measured a
 * quantity. Integer minor units throughout.
 */
export function formatPlanPrice(
  plan: PlanTier,
  currency: BillingCurrency,
  interval: 'monthly' | 'annual',
  quantity?: number,
): string {
  const definition = planCatalog[plan];
  if (definition.pricing !== 'per_domain') {
    return formatPrice(plan, currency, interval);
  }

  const qty = Math.max(1, Math.trunc(quantity ?? definition.minimumQuantity ?? 1));
  return formatAmount(definition.prices[currency].monthlyMinor * qty, currency);
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

  const definition = planCatalog[plan];
  const amount =
    definition.pricing === 'per_domain'
      ? definition.prices.USD.monthlyMinor
      : definition.prices.USD[interval === 'monthly' ? 'monthlyMinor' : 'annualMinor'];
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
