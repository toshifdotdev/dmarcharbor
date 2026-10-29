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
  | 'reports.tlsrpt'
  | 'branding.logoUpload'
  | 'branding.customDomain'
  | 'integrations.webhooks'
  | 'senders.owners'
  | 'dns.automation'
  | 'dns.hosted'
  | 'dns.managedSpf'
  | 'dns.hostedBimi'
  | 'dns.hostedMtaSts'
  | 'integrations.psa'
  | 'prospects.reports'
  | 'reports.usageExport'
  | 'dns.spfUsage';

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
  // One key gates every alert channel (email, Slack, Teams) and the DNS-change
  // and domain-expiry warnings, so the label names what it unlocks.
  'alerts.email': 'Alerts by email, Slack and Teams',
  'alerts.spoofing': 'Spoofing alerts',
  'rollout.canary': 'Staged policy rollout',
  'sharing.links': 'Report share links',
  digests: 'Scheduled report digests',
  'audit.trail': 'The audit trail',
  'portal.client': 'The client portal and client approvals',
  // Logo and colours on client-facing pages and emails. The custom domain is a
  // separate key, so the two can sit on different plans.
  'branding.whitelabel': 'Your logo and colours for clients',
  'api.access': 'API access',
  'auth.sso': 'Single sign-on',
  'data.export': 'Data export',
  'data.erase': 'Data erasure',
  'trust.center': 'The Trust Center',
  'reports.compliancePack': 'The compliance pack and monthly client reports',
  'reports.inbox': 'Report collection from your own mailbox',
  'reports.tlsrpt': 'TLS reports',
  'branding.logoUpload': 'Logo upload',
  'branding.customDomain': 'Client pages on your own domain',
  'integrations.webhooks': 'Webhooks',
  'senders.owners': 'Sender owners',
  'dns.automation': 'Publish DNS records through Cloudflare',
  'dns.hosted': 'Hosted DMARC record',
  'dns.managedSpf': 'Managed SPF',
  'dns.hostedBimi': 'Logo in the inbox (BIMI)',
  'dns.hostedMtaSts': 'Hosted MTA-STS policy',
  'integrations.psa': 'PSA ticketing',
  'prospects.reports': 'Prospect risk reports',
  'reports.usageExport': 'Monthly usage export per client',
  'dns.spfUsage': 'SPF check for unused includes',
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

/** No cap. Serialises as null. */
export const UNLIMITED = Number.POSITIVE_INFINITY;

export function isUnlimited(limit: number | null | undefined): boolean {
  return limit === null || limit === undefined || !Number.isFinite(limit);
}

/** A limit as a person reads it: "25", or "unlimited". */
export function limitText(limit: number): string {
  return isUnlimited(limit) ? 'unlimited' : String(limit);
}

export interface PerDomainBand {
  /** The highest active-domain count this band covers. */
  upTo: number;
  /** The least count billed in this band. */
  minimumQuantity: number;
  /** Price per billed domain per month, in minor units. */
  unitMinor: Record<BillingCurrency, number>;
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
  /**
   * Volume bands for a per-domain plan, in ascending order; null for a flat plan.
   *
   * The band is chosen by the measured active-domain count: the first band
   * whose `upTo` holds it. The bill is max(count, band.minimumQuantity) × the
   * band's unit price. Each band's minimum is set so the bill at the top of one
   * band equals the bill at the bottom of the next, so adding a domain never
   * lowers the bill. `prices` and `minimumQuantity` above are the first band's.
   */
  bands: PerDomainBand[] | null;
  maxClients: number;
  maxActiveDomains: number;
  /**
   * Team members per workspace. `UNLIMITED` (Infinity) where there is no cap:
   * every comparison then holds without a special case, and JSON writes it as
   * null, which is what the web app reads as "Unlimited".
   */
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
  /**
   * Prospect risk reports a workspace may create per calendar month (UTC).
   *
   * Each one is a live scan of a domain nobody in the workspace has verified,
   * so it is bounded per month rather than by stored rows: deleting old
   * reports must not buy more scans. 0 where the feature is off.
   */
  maxProspectReportsPerMonth: number;
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
  'reports.tlsrpt': true,
  'branding.logoUpload': true,
  'branding.customDomain': true,
  'integrations.webhooks': true,
  'senders.owners': true,
  'dns.automation': true,
  'dns.hosted': true,
  'dns.managedSpf': true,
  'dns.hostedBimi': true,
  'dns.hostedMtaSts': true,
  'integrations.psa': true,
  'prospects.reports': true,
  'reports.usageExport': true,
  'dns.spfUsage': true,
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
/**
 * Branding for what clients see.
 *
 * Logo and colours start at Harbor, the plan with the client portal: a portal
 * that carries someone else's look tells the agency's clients who the vendor
 * is. Logo upload ships with them. The custom domain, which hides us entirely,
 * stays Admiralty-only along with SSO, and is what Admiralty is bought for.
 */
const noBrand = { 'branding.whitelabel': false, 'branding.logoUpload': false, 'branding.customDomain': false } as const;
const noCustomDomain = { 'branding.customDomain': false } as const;
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
 * Managed SPF starts at Harbor. The addresses keep being refreshed on a
 * downgrade, so a provider changing its ranges cannot break mail; only editing
 * the source list pauses.
 */
const noManagedSpf = { 'dns.managedSpf': false } as const;

/**
 * Hosted BIMI starts at Harbor.
 *
 * It is the most expensive thing in the DNS group to serve — logo and
 * certificate bytes on a public URL — and it only means anything once DMARC is
 * at enforcement and a mark certificate has been bought, which is a Harbor
 * customer. On a downgrade the TXT keeps being served and the files keep being
 * fetched; only uploads and removals pause, because a logo that vanished the
 * day a card expired would look like a bug in the brand, not a billing state.
 */
const noHostedBimi = { 'dns.hostedBimi': false } as const;

/**
 * Hosted MTA-STS starts at Harbor with the other hosted records.
 *
 * It costs a Cloudflare for SaaS custom hostname and a certificate per domain,
 * which is the most expensive thing in the group to hold. On a downgrade the
 * policy keeps being served and keeps being refreshed; only edits pause, because
 * a policy that vanished would make senders that cached enforce refuse delivery.
 */
const noHostedMtaSts = { 'dns.hostedMtaSts': false } as const;

/**
 * PSA ticketing starts at Harbor with the other integrations.
 *
 * A PSA is where an MSP's work already lives, so a ticket has to land in the
 * same system the technician opens in the morning; that makes it a Fairway-plus
 * feature rather than a free convenience. On a downgrade nothing new is opened,
 * but tickets that already exist still get their notes and their close, because
 * leaving them open would strand work in the customer's own queue.
 */
const noPsa = { 'integrations.psa': false } as const;

/**
 * Prospect risk reports start at Fairway.
 *
 * They are a sales tool for an agency winning its next client, which is what
 * a paying agency is doing; on the free plan they would be a free scanner with
 * a share link. The monthly allowance grows with the plan because a bigger
 * agency pitches more.
 */
const noProspects = { 'prospects.reports': false } as const;

/**
 * The monthly usage export starts at Harbor, with the API and PSA ticketing.
 *
 * It is what an MSP bills its clients from, so it belongs with the plan an
 * agency resells a full client book on. The figures themselves are visible
 * per domain on every plan; this is the per-client roll-up and the file.
 */
const noUsageExport = { 'reports.usageExport': false } as const;

/**
 * The SPF check for unused includes starts at Fairway, with alerts and DNS
 * publishing: it tells an agency what to change, where the free plan shows
 * what is happening. Mooring still gets the lookup count and its warning from
 * every scan. Nothing is stored, so a downgrade only hides the check.
 */
const noSpfUsage = { 'dns.spfUsage': false } as const;

/** TLS-RPT viewing starts at Fairway; collection happens on every plan. */
const noTlsRpt = { 'reports.tlsrpt': false } as const;

/**
 * Harbor's feature set, shared by FLEET rather than copied.
 *
 * FLEET is Harbor's features for a much larger portfolio. A copy would drift
 * the first time either plan changed, and the promise is exactly that the two
 * grant the same things.
 */
const harborFeatures = allFeatures({ ...noSso, ...noCustomDomain, 'trust.center': true });

/**
 * Fleet's volume bands.
 *
 * Fleet is the step up from Harbor below 200 domains and the only plan above
 * 300. Between 200 and 300 it costs about what Admiralty does ($400 against
 * $399) without the custom domain and SSO, so Admiralty is the better buy
 * where both fit. Above 300 the price per domain falls with volume. The
 * minimums make each boundary continuous: 200 × $2.00 = 320 × $1.25 = $400,
 * 500 × $1.25 = 625 × $1.00 = $625, 2,000 × $1.00 ≈ 2,667 × $0.75 = $2,000.
 * INR is at the same parity as every other plan (about ₹84 to the dollar),
 * each band rounded up to the next rupee where plain parity would make the
 * bill fall by a few rupees at the boundary. A unit test walks every count
 * from 1 to 5,000 in both currencies to keep it that way.
 */
const fleetBands: PerDomainBand[] = [
  { upTo: 200, minimumQuantity: 75, unitMinor: { USD: 200, INR: 16900 } },
  { upTo: 500, minimumQuantity: 320, unitMinor: { USD: 125, INR: 10600 } },
  { upTo: 2000, minimumQuantity: 625, unitMinor: { USD: 100, INR: 8500 } },
  { upTo: 5000, minimumQuantity: 2667, unitMinor: { USD: 75, INR: 6400 } },
];

export const planCatalog: Record<PlanTier, PlanDefinition> = {
  MOORING: {
    tier: 'MOORING',
    label: 'Mooring',
    descriptor: 'Watch a couple of domains while you decide.',
    prices: { USD: { monthlyMinor: 0, annualMinor: 0 }, INR: { monthlyMinor: 0, annualMinor: 0 } },
    pricing: 'flat',
    intervals: ['monthly', 'annual'],
    minimumQuantity: null,
    bands: null,
    maxClients: 1,
    maxActiveDomains: 2,
    // Two, so an owner can bring in the one technician who will look at it.
    maxMembers: 2,
    maxWorkspaces: 1,
    activeDomainWindowDays: 30,
    maxProspectReportsPerMonth: 0,
    features: allFeatures({ ...noAlerts, ...noForensic, ...noSharing, ...noPortal, ...noApi, ...noSso, ...noBrand, ...noTrustCenter, ...noInbox, ...noIntegrations, ...noDnsAutomation, ...noDnsHosted, ...noManagedSpf, ...noHostedBimi, ...noHostedMtaSts, ...noPsa, ...noProspects, ...noTlsRpt, ...noUsageExport, ...noSpfUsage, ...off }),
  },
  FAIRWAY: {
    tier: 'FAIRWAY',
    label: 'Fairway',
    // Every plan can publish any policy, reject included; plans differ in what is
    // around the policy. This said "Quarantine without rejection", which nothing
    // enforced and no customer could have relied on.
    descriptor: 'Alerts, forensic evidence and hosted DMARC for a small client book.',
    prices: { USD: { monthlyMinor: 3900, annualMinor: 39000 }, INR: { monthlyMinor: 329900, annualMinor: 3299000 } },
    pricing: 'flat',
    intervals: ['monthly', 'annual'],
    minimumQuantity: null,
    bands: null,
    maxClients: 5,
    maxActiveDomains: 20,
    maxMembers: 5,
    maxWorkspaces: 2,
    activeDomainWindowDays: 365,
    maxProspectReportsPerMonth: 10,
    features: allFeatures({ ...noNamedForensic, ...noPortal, ...noApi, ...noSso, ...noBrand, ...noTrustCenter, ...noInbox, ...noDigests, ...noManagedSpf, ...noHostedBimi, ...noHostedMtaSts, ...noPsa, ...noUsageExport }),
  },
  HARBOR: {
    tier: 'HARBOR',
    label: 'Harbor',
    descriptor: 'Client portal under your logo, named forensic evidence, API and PSA for a full client book.',
    prices: { USD: { monthlyMinor: 14900, annualMinor: 149000 }, INR: { monthlyMinor: 1249900, annualMinor: 12499000 } },
    pricing: 'flat',
    intervals: ['monthly', 'annual'],
    minimumQuantity: null,
    bands: null,
    maxClients: 20,
    maxActiveDomains: 80,
    maxMembers: 25,
    maxWorkspaces: 3,
    activeDomainWindowDays: 1095,
    maxProspectReportsPerMonth: 50,
    features: harborFeatures,
  },
  ADMIRALTY: {
    tier: 'ADMIRALTY',
    label: 'Admiralty',
    descriptor: 'Client pages on your own domain, SSO and an unlimited team, up to 300 domains.',
    prices: { USD: { monthlyMinor: 39900, annualMinor: 399000 }, INR: { monthlyMinor: 3399900, annualMinor: 33999000 } },
    pricing: 'flat',
    intervals: ['monthly', 'annual'],
    minimumQuantity: null,
    bands: null,
    maxClients: 75,
    maxActiveDomains: 300,
    // SSO adds people on their first sign-in, so a cap would refuse a new hire
    // arriving through the agency's own identity provider.
    maxMembers: UNLIMITED,
    maxWorkspaces: 5,
    activeDomainWindowDays: 3650,
    maxProspectReportsPerMonth: 200,
    features: allFeatures(),
  },
  /**
   * Harbor's features for larger portfolios, billed per active domain.
   *
   * Never cheaper than Harbor at the minimum, and never a route to the custom
   * domain or SSO: those stay Admiralty-only, which is what keeps the two plans
   * from competing for the same buyer.
   */
  FLEET: {
    tier: 'FLEET',
    label: 'Fleet',
    descriptor: "Harbor's features for larger portfolios, billed per active domain at a price that falls with volume.",
    prices: { USD: { monthlyMinor: 200, annualMinor: 0 }, INR: { monthlyMinor: 16900, annualMinor: 0 } },
    pricing: 'per_domain',
    intervals: ['monthly'],
    minimumQuantity: 75,
    bands: fleetBands,
    maxClients: 1000,
    maxActiveDomains: 5000,
    // Billed per domain, so seats are not a second meter.
    maxMembers: UNLIMITED,
    maxWorkspaces: 5,
    activeDomainWindowDays: 30,
    maxProspectReportsPerMonth: 200,
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

  return formatAmount(perDomainBill(plan, quantity ?? definition.minimumQuantity ?? 1, currency).totalMinor, currency);
}

/**
 * The band a count falls in, as its index. 0 for a flat plan.
 *
 * A count above the top band is billed in the top band, and a count below the
 * first band's minimum is billed at that minimum, in the first band. Because
 * every band's minimum sits inside its own range, the billed quantity always
 * falls in the same band as the count it came from, so the band can be read
 * back from a stored quantity alone.
 */
export function bandIndexFor(plan: PlanTier, count: number): number {
  const bands = planCatalog[plan].bands;
  if (!bands || bands.length === 0) return 0;
  const n = Math.max(0, Math.trunc(count));
  const index = bands.findIndex((band) => n <= band.upTo);
  return index === -1 ? bands.length - 1 : index;
}

/** " (201 to 500 domains)" for a band of a per-domain plan, for provider plan names; "" otherwise. */
export function bandSuffix(plan: PlanTier, band: number): string {
  const bands = planCatalog[plan].bands;
  const entry = bands?.[band];
  if (!bands || !entry) return '';
  const from = band === 0 ? 1 : (bands[band - 1]?.upTo ?? 0) + 1;
  return ` (${from} to ${entry.upTo} domains)`;
}

/** What a measured count bills on a plan: the quantity, the band's unit price and the total. */
export function perDomainBill(
  plan: PlanTier,
  count: number,
  currency: BillingCurrency,
): { band: number; quantity: number; minimum: number; unitMinor: number; totalMinor: number } {
  const definition = planCatalog[plan];
  if (definition.pricing !== 'per_domain') {
    const unitMinor = definition.prices[currency].monthlyMinor;
    return { band: 0, quantity: 1, minimum: 1, unitMinor, totalMinor: unitMinor };
  }
  const band = bandIndexFor(plan, count);
  const entry = definition.bands?.[band];
  const minimum = Math.max(1, entry?.minimumQuantity ?? definition.minimumQuantity ?? 1);
  const unitMinor = entry?.unitMinor[currency] ?? definition.prices[currency].monthlyMinor;
  const quantity = Math.max(minimum, Math.trunc(count));
  return { band, quantity, minimum, unitMinor, totalMinor: unitMinor * quantity };
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

/** A limit for a quota; `UNLIMITED` where the plan has none. */
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
