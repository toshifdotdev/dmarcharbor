import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  catalogOrder,
  isUnlimited,
  planCatalog,
  planOrder,
  quotaLimitFor,
  type EntitlementKey,
  type PlanDefinition,
  type QuotaKey,
} from '../src/services/entitlements/plan-catalog.js';
import { planCatalogResponse } from '../src/services/entitlements/entitlement.service.js';
import {
  allEntitlements,
  catalogueExemptions,
  gatedFeatures,
  probeTableFile,
  ungatedEntitlements,
} from './helpers/plan-limits.js';

/**
 * Every plan limit has a gate in the code and a probe in the integration suite.
 *
 * The integration suite (tests/plan-limits.integration.test.ts) runs each probe
 * on every plan in CI. This file is the part that runs locally in milliseconds:
 * it reads the source as text and checks that nothing in the catalogue is
 * published without a gate, a quota without a place that enforces it, or a
 * gated key without a probe, so a new key fails here before anyone has to wait
 * for CI. plan-catalog.unit.test.ts already checks that each key appears quoted
 * somewhere near a gate; this checks that it appears inside one.
 */

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (full.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

const sources = sourceFiles(join(process.cwd(), 'src')).map((file) => ({
  file: file.slice(process.cwd().length + 1).replace(/\\/g, '/'),
  text: readFileSync(file, 'utf8'),
}));

/**
 * The text of every call to `name(...)`, balanced on parentheses.
 *
 * `assertFeature` is sometimes written over several lines with the key chosen
 * by a ternary (the alert controller picks spoofing or email from the metric),
 * so a one-line pattern would miss it. Strings are not parsed: a parenthesis
 * inside a quoted key never occurs, because keys are dotted words.
 */
function callArguments(text: string, name: string): string[] {
  const calls: string[] = [];
  const opener = new RegExp(`\\b${name}\\(`, 'g');
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < text.length && depth > 0) {
      if (text[index] === '(') depth += 1;
      if (text[index] === ')') depth -= 1;
      index += 1;
    }
    calls.push(text.slice(start, index - 1));
  }
  return calls;
}

/** Every entitlement key that something in src actually checks, with where. */
function gateSites(): Map<string, Set<string>> {
  const sites = new Map<string, Set<string>>();
  const add = (key: string, file: string) => {
    if (!sites.has(key)) sites.set(key, new Set());
    sites.get(key)!.add(file);
  };

  for (const { file, text } of sources) {
    // The definitions themselves are not gates.
    if (file.endsWith('entitlement.middleware.ts') || file.endsWith('entitlement.service.ts')) continue;

    for (const name of ['requireFeature', 'requireFeatureUnless', 'assertFeature']) {
      for (const args of callArguments(text, name)) {
        for (const quoted of args.matchAll(/'([a-zA-Z]+(?:\.[a-zA-Z]+)?)'/g)) {
          add(quoted[1]!, file);
        }
      }
    }
    // A feature read off resolved entitlements: how delivery, schedulers and
    // controllers that answer differently for kept rows decide.
    for (const read of text.matchAll(/features\[\s*'([a-zA-Z.]+)'\s*\]/g)) add(read[1]!, file);
    for (const read of text.matchAll(/features\.([a-zA-Z]+)\b/g)) add(read[1]!, file);
  }
  return sites;
}

const sites = gateSites();

describe('every entitlement is gated, granted to all, or planned', () => {
  it('pins the probe helper to the catalogue, so the GatedFeature type cannot drift', () => {
    expect([...ungatedEntitlements].sort()).toEqual([...catalogueExemptions].sort());
  });

  it('reads every key from the catalogue, and finds the gate scan non-empty', () => {
    // Guards against the scan reading nothing and every key looking unenforced
    // for the wrong reason, or every key looking enforced because the list was empty.
    expect(allEntitlements.length).toBeGreaterThan(20);
    expect(gatedFeatures.length + ungatedEntitlements.length).toBe(allEntitlements.length);
    expect(sites.size).toBeGreaterThan(gatedFeatures.length / 2);
  });

  it.each(gatedFeatures)('%s has a gate in src', (key) => {
    const where = [...(sites.get(key) ?? [])];
    expect(
      where,
      `${key} is sold on some plans but no requireFeature, assertFeature or features['${key}'] read in src checks it, so it is free on every plan.`,
    ).not.toEqual([]);
  });

  it('withholds every gated key from at least one plan, or it would need no gate', () => {
    const grantedEverywhere = gatedFeatures.filter((key) => catalogOrder.every((tier) => planCatalog[tier].features[key]));
    expect(grantedEverywhere, 'Move these to alwaysOnEntitlements, or take them off a plan.').toEqual([]);
  });
});

describe('every gated key has a probe in the integration suite', () => {
  const table = readFileSync(join(process.cwd(), probeTableFile), 'utf8');

  it.each(gatedFeatures)('%s is a key of the probe table', (key) => {
    const escaped = key.replace(/\./g, '\\.');
    // `'reports.forensic': {` or, for a key that is a plain word, `digests: {`.
    const entry = new RegExp(`^\\s*(?:'${escaped}'|${escaped}):\\s*\\{`, 'm');
    expect(entry.test(table), `${probeTableFile} has no probe for ${key}.`).toBe(true);
  });

  it('types the table against GatedFeature, so a missing probe fails the typecheck too', () => {
    expect(table).toMatch(/satisfies Record<GatedFeature, Probe>/);
  });
});

/**
 * Where each quota is enforced on a create path. Typed against QuotaKey so a new
 * quota cannot be added without saying where it is enforced.
 */
const quotaEnforcement = {
  client: [/requireQuota\('client'\)/, /withQuota\([^)]*'client'/],
  activeDomain: [/requireQuota\('activeDomain'\)/, /withQuota\([^)]*'activeDomain'/],
  // Members join through Better Auth: an invitation is refused by the hook,
  // and an acceptance by the plugin's membershipLimit.
  member: [/beforeCreateInvitation[\s\S]{0,400}memberAllowance\(/, /membershipLimit:/],
} satisfies Record<QuotaKey, RegExp[]>;

const quotaKeys = Object.keys(quotaEnforcement) as QuotaKey[];

describe('every quota has a limit on every plan and a place that enforces it', () => {
  const allSource = sources
    .filter(({ file }) => !file.endsWith('entitlement.middleware.ts'))
    .map(({ text }) => text)
    .join('\n');

  it.each(quotaKeys)('%s is enforced on its create path', (quota) => {
    for (const pattern of quotaEnforcement[quota]) {
      expect(pattern.test(allSource), `${quota}: nothing in src matches ${pattern}`).toBe(true);
    }
  });

  it.each(quotaKeys)('%s has a limit on every plan', (quota) => {
    for (const tier of catalogOrder) {
      const limit = quotaLimitFor(tier, quota);
      // 0 is quotaLimitFor's answer for a quota it does not know, which would
      // refuse the first client or domain on that plan.
      expect(limit, `${tier} ${quota}`).toBeGreaterThan(0);
    }
  });
});

/** The limits a buyer compares, by the name the pricing page reads. */
const limitFields = ['maxClients', 'maxActiveDomains', 'maxMembers', 'maxWorkspaces', 'maxProspectReportsPerMonth'] as const satisfies readonly (keyof PlanDefinition)[];

describe('limits never fall as a plan is upgraded', () => {
  it.each(limitFields)('%s rises or holds along the ladder', (field) => {
    for (let index = 1; index < planOrder.length; index += 1) {
      const lower = planCatalog[planOrder[index - 1]!];
      const higher = planCatalog[planOrder[index]!];
      expect(higher[field], `${lower.tier} to ${higher.tier}`).toBeGreaterThanOrEqual(lower[field]);
    }
  });

  it.each(limitFields)('%s on Fleet is at least Harbor, whose features Fleet sells for larger books', (field) => {
    expect(planCatalog.FLEET[field]).toBeGreaterThanOrEqual(planCatalog.HARBOR[field]);
  });

  it('offers prospect reports exactly where the feature is on', () => {
    for (const tier of catalogOrder) {
      const plan = planCatalog[tier];
      expect(plan.maxProspectReportsPerMonth > 0, tier).toBe(plan.features['prospects.reports']);
    }
  });
});

describe('GET /api/plans carries every limit the way the pricing page reads it', () => {
  // What the route answers, through the JSON encoder the response uses:
  // `{ plans: planCatalogResponse(), order: catalogOrder }`.
  const wire = JSON.parse(JSON.stringify({ plans: planCatalogResponse(), order: catalogOrder })) as {
    plans: Array<Record<string, unknown> & { tier: string; features: Record<string, unknown> }>;
    order: string[];
  };

  it('lists every plan in reading order', () => {
    expect(wire.order).toEqual(catalogOrder);
    expect(wire.plans.map((plan) => plan.tier)).toEqual(catalogOrder);
  });

  it.each(catalogOrder)('%s serialises each limit as a number, and an unlimited team as null', (tier) => {
    const plan = wire.plans.find((entry) => entry.tier === tier)!;
    for (const field of limitFields) {
      const limit = planCatalog[tier][field];
      if (isUnlimited(limit)) {
        // Infinity becomes null in JSON, which the web app reads as "Unlimited".
        expect(plan[field], `${tier} ${field}`).toBeNull();
      } else {
        expect(plan[field], `${tier} ${field}`).toBe(limit);
      }
    }
  });

  it.each(catalogOrder)('%s states every entitlement as true or false', (tier) => {
    const plan = wire.plans.find((entry) => entry.tier === tier)!;
    for (const key of allEntitlements) {
      expect(typeof plan.features[key], `${tier} ${key}`).toBe('boolean');
      expect(plan.features[key]).toBe(planCatalog[tier].features[key as EntitlementKey]);
    }
  });
});
