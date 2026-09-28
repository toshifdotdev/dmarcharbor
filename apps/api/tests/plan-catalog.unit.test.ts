import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  alwaysAllowedEntitlements,
  alwaysOnEntitlements,
  billingCurrencies,
  formatPrice,
  formatPriceWithConversion,
  planCatalog,
  planOrder,
  plannedEntitlements,
  type EntitlementKey,
} from '../src/services/entitlements/plan-catalog.js';

/**
 * Walks the source tree looking for an enforcement site for one entitlement.
 *
 * A textual scan is crude but it is exactly the check that matters here. The
 * failure mode being guarded against is a plan catalog that advertises a
 * feature while no route or controller ever asks for it, which silently hands
 * a paid feature to the free tier and looks correct in review.
 */
function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (full.endsWith('.ts') && !full.includes(`${join('tests', '')}`)) {
      found.push(full);
    }
  }
  return found;
}

function scanEnforcementSites(): string {
  const root = join(process.cwd(), 'src');
  const parts: string[] = [];

  for (const file of sourceFiles(root)) {
    try {
      const contents = readFileSync(file, 'utf8');
      if (contents.includes('assertFeature') || contents.includes('requireFeature')) {
        parts.push(contents);
      }
    } catch {
      // A file that cannot be read is skipped rather than failing the suite.
      // Treating an unreadable file as "not enforced" would produce a failure
      // that looks like a real regression.
    }
  }

  const sites = parts.join('\n');

  // Guards against the scan silently finding nothing, which would make every
  // key look planned and turn this test into a no-op.
  if (sites.length < 200) {
    throw new Error('The enforcement scan read too little source to be meaningful.');
  }

  return sites;
}

// Read once, at module load, so the assertion itself is instant and cannot
// flake on a slow or busy machine.
const enforcementSites = scanEnforcementSites();

const allKeys: EntitlementKey[] = Array.from(
  new Set(planOrder.flatMap((tier) => Object.keys(planCatalog[tier].features) as EntitlementKey[])),
);

describe('plan catalog integrity', () => {
  it('grants data portability and erasure on every plan', () => {
    for (const tier of planOrder) {
      for (const key of alwaysAllowedEntitlements) {
        expect(planCatalog[tier].features[key], `${tier} must grant ${key}`).toBe(true);
      }
    }
  });

  it('grants the always-on features on every plan', () => {
    for (const tier of planOrder) {
      for (const key of alwaysOnEntitlements) {
        expect(planCatalog[tier].features[key], `${tier} must grant ${key}`).toBe(true);
      }
    }
  });

  it('never lets a downgrade hand back a statutory right', () => {
    const mooring = planCatalog.MOORING.features;
    for (const key of alwaysAllowedEntitlements) {
      expect(mooring[key]).toBe(true);
    }
  });

  it('enforces every entitlement, or lists it as planned, or grants it to all', () => {
    const sites = enforcementSites;
    const intentional = new Set<EntitlementKey>([...plannedEntitlements, ...alwaysOnEntitlements, ...alwaysAllowedEntitlements]);

    const unenforced = allKeys.filter((key) => !intentional.has(key) && !sites.includes(`'${key}'`));

    expect(
      unenforced,
      `These entitlements are declared in the catalog but nothing checks them, so they are free on every plan: ${unenforced.join(', ')}. Add a gate, or add the key to plannedEntitlements if it is not built yet.`,
    ).toEqual([]);
  });

  it('does not duplicate a key across the intentional exemptions', () => {
    const seen = new Set<EntitlementKey>();
    for (const key of [...plannedEntitlements, ...alwaysOnEntitlements, ...alwaysAllowedEntitlements]) {
      expect(seen.has(key), `${key} is listed twice, which would hide a future overlap`).toBe(false);
      seen.add(key);
    }
  });

  it('grants a planned feature to nobody, because nothing can turn it on yet', () => {
    // A planned entitlement is priced so the ladder is honest about where the
    // feature will sit, but it must be granted to no tier. If one is, the
    // catalog is promising something the code cannot deliver.
    for (const key of plannedEntitlements) {
      const grantedBy = planOrder.filter((tier) => planCatalog[tier].features[key]);
      expect(grantedBy, `${key} is planned but granted by ${grantedBy.join(', ')}`).toEqual([]);
    }
  });

  it('never reduces a limit as a plan is upgraded', () => {
    for (let index = 1; index < planOrder.length; index += 1) {
      const lower = planCatalog[planOrder[index - 1]!];
      const higher = planCatalog[planOrder[index]!];

      expect(higher.maxClients).toBeGreaterThanOrEqual(lower.maxClients);
      expect(higher.maxActiveDomains).toBeGreaterThanOrEqual(lower.maxActiveDomains);
      expect(higher.maxMembers).toBeGreaterThanOrEqual(lower.maxMembers);
      expect(higher.dataRetentionDays).toBeGreaterThanOrEqual(lower.dataRetentionDays);
      expect(higher.auditRetentionDays).toBeGreaterThanOrEqual(lower.auditRetentionDays);
    }
  });

  it('never removes a feature as a plan is upgraded', () => {
    for (let index = 1; index < planOrder.length; index += 1) {
      const lower = planCatalog[planOrder[index - 1]!];
      const higher = planCatalog[planOrder[index]!];

      for (const key of allKeys) {
        if (!higher.features[key]) {
          expect(lower.features[key], `${key} is lost when moving up to ${higher.tier}`).toBe(false);
        }
      }
    }
  });

  it('keeps the free tier usable, so it can act as the trial', () => {
    const mooring = planCatalog.MOORING;
    expect(mooring.maxClients).toBeGreaterThan(0);
    expect(mooring.maxActiveDomains).toBeGreaterThan(0);
    expect(mooring.features['reports.aggregate']).toBe(true);
  });

  it('prices the free tier at zero and every paid tier above it, in both currencies', () => {
    for (const currency of billingCurrencies) {
      const prices = planOrder.map((tier) => planCatalog[tier].prices[currency].monthlyMinor);
      expect(prices[0], `${currency} free tier`).toBe(0);

      for (let index = 1; index < prices.length; index += 1) {
        expect(prices[index]!, `${currency} tier ${index}`).toBeGreaterThan(prices[index - 1]!);
      }
    }
  });

  it('gives two months free on annual billing, in both currencies', () => {
    for (const tier of planOrder) {
      for (const currency of billingCurrencies) {
        const { monthlyMinor, annualMinor } = planCatalog[tier].prices[currency];
        if (monthlyMinor === 0) {
          expect(annualMinor).toBe(0);
          continue;
        }
        // Ten months of price for twelve months of service. Anything cheaper
        // would be hiding a real discount from whoever checks the arithmetic.
        expect(annualMinor, `${tier} ${currency}`).toBe(monthlyMinor * 10);
      }
    }
  });

  it('keeps every price a whole number of minor units', () => {
    for (const tier of planOrder) {
      for (const currency of billingCurrencies) {
        for (const [interval, amount] of Object.entries(planCatalog[tier].prices[currency])) {
          expect(Number.isInteger(amount), `${tier} ${currency} ${interval}`).toBe(true);
        }
      }
    }
  });

  it('orders the two currencies the same way, so the ladder is never inverted', () => {
    for (const currency of billingCurrencies) {
      const usd = planOrder.map((tier) => planCatalog[tier].prices[currency].monthlyMinor);
      expect(usd).toEqual([...usd].sort((a, b) => a - b));
    }
  });

  it('renders a price the way a customer would expect to read it', () => {
    expect(formatPrice('MOORING', 'USD', 'monthly')).toBe('Free');
    expect(formatPrice('FAIRWAY', 'USD', 'monthly')).toBe('$19');
    expect(formatPrice('HARBOR', 'USD', 'monthly')).toBe('$79');
    expect(formatPrice('ADMIRALTY', 'USD', 'annual')).toBe('$2,490');
    expect(formatPrice('FAIRWAY', 'INR', 'monthly')).toBe('\u20b91,599');
    expect(formatPrice('HARBOR', 'INR', 'annual')).toBe('\u20b965,990');
  });

  it('shows a rough rupee figure for a dollar price without using it to charge', () => {
    const usd = formatPriceWithConversion('HARBOR', 'USD', 'monthly');
    expect(usd.primary).toBe('$79');
    expect(usd.secondary).toContain('\u20b9');

    const inr = formatPriceWithConversion('HARBOR', 'INR', 'monthly');
    expect(inr.secondary).toBeNull();

    expect(formatPriceWithConversion('MOORING', 'USD', 'monthly').secondary).toBeNull();
  });
});
