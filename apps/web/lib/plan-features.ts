/**
 * plan-features.ts — how the plan catalog is read for a buyer.
 *
 * GET /api/plans is the only source of plan names, prices, limits and which
 * features each plan carries. This module adds only words and order: a plain
 * label per entitlement key, the order a buyer reads them in, and the sums a
 * reader should not have to do (what the annual price saves).
 *
 * `rollout.canary` is never listed: staged policy rollout is not offered, so
 * it is not something a plan can be sold on. A key the module does not know
 * still renders, through featureLabel, so a new entitlement never vanishes.
 */

import { featureLabel } from "./feature-label";
import type { PlanDefinition, PlanPriceMinor } from "./types";

/** Plain labels, in reading order: what every plan has, then what is added. */
const FEATURES: Array<[key: string, label: string]> = [
  ["reports.aggregate", "Aggregate DMARC reporting"],
  ["audit.trail", "Audit trail"],
  ["data.export", "Data export"],
  ["data.erase", "Data erasure"],
  ["alerts.email", "Alerts by email, Slack and Teams"],
  ["alerts.spoofing", "Spoofing alerts"],
  ["senders.owners", "Sender owners"],
  ["integrations.webhooks", "Webhooks"],
  ["dns.automation", "Publish DNS records through Cloudflare"],
  ["dns.hosted", "Hosted DMARC record"],
  ["dns.managedSpf", "Managed SPF"],
  ["dns.hostedBimi", "Logo in the inbox (BIMI)"],
  ["dns.hostedMtaSts", "Hosted MTA-STS policy"],
  ["integrations.psa", "PSA ticketing"],
  ["prospects.reports", "Prospect risk reports"],
  ["reports.forensic", "Forensic reports, recipients unnamed"],
  ["sharing.links", "Report share links"],
  ["reports.forensicNamed", "Named forensic evidence"],
  ["digests", "Scheduled report digests"],
  ["portal.client", "Client portal and client approvals"],
  ["api.access", "API access"],
  ["trust.center", "Trust Center"],
  ["reports.compliancePack", "Compliance pack and monthly client reports"],
  ["reports.inbox", "Report collection from your own mailbox"],
  ["reports.tlsrpt", "TLS reports"],
  ["branding.whitelabel", "White label"],
  ["branding.logoUpload", "Logo upload"],
  ["auth.sso", "Single sign-on (OIDC and SAML)"],
];

const LABEL = new Map(FEATURES);
const ORDER = new Map(FEATURES.map(([k], i) => [k, i]));

/**
 * The plan the company recommends to agencies, by tier id. This is advice, not
 * data: it carries no claim about what customers choose (there are no sales
 * figures behind it, and the page must never imply there are). The label,
 * price and everything else still come from the catalog; if the tier is not
 * in the catalog nothing is marked.
 */
export const RECOMMENDED_TIER = "HARBOR";

/** Not offered, so never listed. */
export const UNLISTED_FEATURES = new Set(["rollout.canary"]);

export function planFeatureLabel(key: string): string {
  return LABEL.get(key) ?? featureLabel(key);
}

/**
 * The API's 402 sentence opens with the raw entitlement key ("auth.sso is not
 * included in Harbor. Upgrade to Admiralty to use it."). The sentence is kept,
 * because it names the plans; only the key is swapped for its plain label, so
 * the person reads "Single sign-on (OIDC and SAML) is not included in Harbor".
 */
export function planRefusalText(message: string | null | undefined, feature: string | null | undefined): string | null {
  if (!message) return null;
  if (!feature || !message.includes(feature)) return message;
  return message.split(feature).join(planFeatureLabel(feature));
}

function byReadingOrder(a: string, b: string): number {
  return (ORDER.get(a) ?? 999) - (ORDER.get(b) ?? 999) || a.localeCompare(b);
}

function granted(plan: PlanDefinition): string[] {
  return Object.entries(plan.features)
    .filter(([k, on]) => on && !UNLISTED_FEATURES.has(k))
    .map(([k]) => k);
}

/** Every key at least one plan grants, in reading order. A key granted on no
 *  plan is not a row anyone can buy. */
export function soldFeatures(plans: PlanDefinition[]): string[] {
  const keys = new Set<string>();
  for (const p of plans) for (const k of granted(p)) keys.add(k);
  return [...keys].sort(byReadingOrder);
}

/** What this plan adds over the one before it. */
export function addedFeatures(plan: PlanDefinition, previous: PlanDefinition | null): string[] {
  return granted(plan)
    .filter((k) => !previous || previous.features[k as keyof PlanDefinition["features"]] !== true)
    .sort(byReadingOrder);
}

/** True only when every plan in the catalog grants the key. */
export function onEveryPlan(plans: PlanDefinition[], key: string): boolean {
  return plans.length > 0 && plans.every((p) => p.features[key as keyof PlanDefinition["features"]] === true);
}

export function isFree(price: PlanPriceMinor): boolean {
  return price.monthlyMinor === 0 && price.annualMinor === 0;
}

/** What paying annually saves against twelve monthly payments, in minor units.
 *  Integer arithmetic only; zero or less means no saving to state. */
export function annualSavingMinor(price: PlanPriceMinor): number {
  return price.monthlyMinor * 12 - price.annualMinor;
}

/** The saving in whole months, when it is a whole number of months. */
export function monthsSaved(price: PlanPriceMinor): number | null {
  if (price.monthlyMinor <= 0) return null;
  const saving = annualSavingMinor(price);
  return saving > 0 && saving % price.monthlyMinor === 0 ? saving / price.monthlyMinor : null;
}

/** One figure for every paid flat plan in both currencies, or null when they differ.
 *  Per-domain plans are excluded: their unit price is not an annual saving. */
export function catalogMonthsSaved(plans: PlanDefinition[]): number | null {
  const all = plans
    .filter((p) => p.pricing === "flat")
    .flatMap((p) => [p.prices.USD, p.prices.INR])
    .filter((price) => !isFree(price))
    .map(monthsSaved);
  if (all.length === 0 || all.some((m) => m === null)) return null;
  return all.every((m) => m === all[0]) ? all[0] : null;
}
