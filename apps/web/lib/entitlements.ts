import type { EntitlementKey, ResolvedEntitlements } from "./types";

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
