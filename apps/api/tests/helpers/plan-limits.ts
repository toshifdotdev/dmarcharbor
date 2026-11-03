import {
  alwaysAllowedEntitlements,
  alwaysOnEntitlements,
  entitlementLabels,
  plannedEntitlements,
  type EntitlementKey,
} from '../../src/services/entitlements/plan-catalog.js';

/**
 * Which entitlements have a gate to probe, shared by the plan-limit suites.
 *
 * tests/plan-limits.integration.test.ts keeps one probe per gated key in a table
 * typed `Record<GatedFeature, Probe>`, so a key added to `EntitlementKey` without
 * a probe fails the typecheck. tests/plan-coverage.unit.test.ts imports the same
 * list to check, without a database, that every gated key has an enforcement site
 * in src and a probe in the integration file.
 *
 * The keys with nothing to gate are written out here as literal types, because
 * the catalogue's own lists are typed `readonly EntitlementKey[]` and a type
 * cannot be subtracted from that. The unit test pins this list to the
 * catalogue's (always on, always allowed, planned), so the two cannot drift.
 */
export const ungatedEntitlements = [
  'reports.aggregate',
  'audit.trail',
  'data.export',
  'data.erase',
  'rollout.canary',
] as const satisfies readonly EntitlementKey[];

export type UngatedEntitlement = (typeof ungatedEntitlements)[number];

/** Every key a plan can withhold, and so every key that needs a probe. */
export type GatedFeature = Exclude<EntitlementKey, UngatedEntitlement>;

/** Every entitlement key, read from a record the compiler holds complete. */
export const allEntitlements = Object.keys(entitlementLabels) as EntitlementKey[];

export const gatedFeatures: GatedFeature[] = allEntitlements.filter(
  (key): key is GatedFeature => !(ungatedEntitlements as readonly string[]).includes(key),
);

/** The catalogue's own exemptions, for the unit test to compare against. */
export const catalogueExemptions: EntitlementKey[] = [
  ...alwaysOnEntitlements,
  ...alwaysAllowedEntitlements,
  ...plannedEntitlements,
];

/** The integration file the probe table lives in, relative to apps/api. */
export const probeTableFile = 'tests/plan-limits.integration.test.ts';
