import type { EntitlementKey, PlanDefinition, ResolvedEntitlements } from "./types";

/**
 * Whether a plan includes a feature, as three values rather than two.
 *
 * Every settings page used to read `entitlements?.features[key] === true` on a
 * `.catch(() => null)` result, which collapses two different facts into the same
 * answer: the plan genuinely does not include the feature, and the entitlements
 * read failed. Both answered `false`, so a workspace that had paid for the
 * report mailbox was told it was not included in their plan when the API had
 * simply not answered.
 *
 * `null` means the read failed and the answer is unknown, which is a different
 * sentence and a different colour, not the same one.
 *
 * This is the gate every screen uses before it offers a plan-gated control, and
 * tests/plan-gates.test.ts fails when a gated key has no gate anywhere.
 */
export type FeatureStatus = boolean | null;

export function featureOf(
  entitlements: ResolvedEntitlements | null,
  key: EntitlementKey,
): FeatureStatus {
  if (entitlements === null) return null;
  return entitlements.features[key] === true;
}

/**
 * Copy for the case above. Returns an empty string when the entitlement read
 * succeeded, so a page can render it unconditionally.
 */
export function entitlementLoadFailureNote(): string {
  return "The plan could not be read, so whether this is available on your workspace is unknown. This is an API problem, not a missing feature.";
}

/** GET /api/plans, as the pages read it. */
export interface PlanCatalog {
  plans: PlanDefinition[];
  order: string[];
}

/**
 * The first plan, in the catalog's reading order, that includes a feature: its
 * label, or null when the catalog could not be read or no plan sells it. The
 * name always comes from the catalog, so a pricing change never leaves a
 * screen naming the wrong plan.
 */
export function planIncluding(catalog: PlanCatalog | null, key: EntitlementKey): string | null {
  if (!catalog) return null;
  for (const tier of catalog.order) {
    const plan = catalog.plans.find((p) => p.tier === tier);
    if (plan?.features[key] === true) return plan.label;
  }
  return null;
}

/** "included from Harbor", or "included on a higher plan" when the catalog did not answer. */
export function includedFrom(catalog: PlanCatalog | null, key: EntitlementKey): string {
  const label = planIncluding(catalog, key);
  return label ? `included from ${label}` : "included on a higher plan";
}

/**
 * Usage against a plan limit. `limit` null is no limit (the API writes
 * Infinity as null). Reached means one more would be refused, which is how the
 * API counts: used + 1 > limit.
 */
export interface Allowance {
  used: number;
  limit: number | null;
}

export function limitReached(allowance: Allowance | null | undefined): boolean {
  if (!allowance || allowance.limit === null || !Number.isFinite(allowance.limit)) return false;
  return allowance.used >= allowance.limit;
}
