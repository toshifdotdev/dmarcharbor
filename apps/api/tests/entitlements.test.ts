import { describe, expect, it } from 'vitest';
import {
  alwaysAllowedEntitlements,
  effectivePlan,
  nextTier,
  planCatalog,
  planOrder,
  planLabel,
  previousTier,
  quotaLimitFor,
} from '../src/services/entitlements/plan-catalog.js';

describe('plan catalog', () => {
  it('exposes the four plans in ascending order', () => {
    expect(planOrder).toEqual(['MOORING', 'FAIRWAY', 'HARBOR', 'ADMIRALTY']);
    expect(planCatalog.MOORING.label).toBe('Mooring');
    expect(planCatalog.FAIRWAY.label).toBe('Fairway');
    expect(planCatalog.HARBOR.label).toBe('Harbor');
    expect(planCatalog.ADMIRALTY.label).toBe('Admiralty');
  });

  it('gives every plan a plain language descriptor', () => {
    for (const plan of Object.values(planCatalog)) {
      expect(plan.descriptor.length).toBeGreaterThan(10);
    }
  });

  it('never increases a limit as the price drops', () => {
    for (let index = 1; index < planOrder.length; index += 1) {
      const lower = planCatalog[planOrder[index - 1]!];
      const higher = planCatalog[planOrder[index]!];
      expect(higher.prices.USD.monthlyMinor).toBeGreaterThanOrEqual(lower.prices.USD.monthlyMinor);
      expect(higher.maxClients).toBeGreaterThanOrEqual(lower.maxClients);
      expect(higher.maxActiveDomains).toBeGreaterThanOrEqual(lower.maxActiveDomains);
      expect(higher.maxMembers).toBeGreaterThanOrEqual(lower.maxMembers);
      expect(higher.dataRetentionDays).toBeGreaterThanOrEqual(lower.dataRetentionDays);
    }
  });

  it('keeps the free plan free', () => {
    expect(planCatalog.MOORING.prices.USD.monthlyMinor).toBe(0);
    expect(planCatalog.MOORING.prices.USD.annualMinor).toBe(0);
  });

  it('prices the agreed ladder', () => {
    expect(planCatalog.FAIRWAY.prices.USD.monthlyMinor).toBe(2900);
    expect(planCatalog.HARBOR.prices.USD.monthlyMinor).toBe(14900);
    expect(planCatalog.ADMIRALTY.prices.USD.monthlyMinor).toBe(39900);

    expect(planCatalog.FAIRWAY.prices.INR.monthlyMinor).toBe(249900);
    expect(planCatalog.HARBOR.prices.INR.monthlyMinor).toBe(1249900);
    expect(planCatalog.ADMIRALTY.prices.INR.monthlyMinor).toBe(3399900);
  });

  it('offers a roughly 17 percent annual discount on paid plans', () => {
    for (const tier of ['FAIRWAY', 'HARBOR', 'ADMIRALTY'] as const) {
      const plan = planCatalog[tier];
      const tenMonths = plan.prices.USD.monthlyMinor * 10;
      expect(plan.prices.USD.annualMinor).toBeLessThanOrEqual(tenMonths);
      expect(plan.prices.USD.annualMinor).toBeGreaterThan(plan.prices.USD.monthlyMinor * 9);
    }
  });

  it('moves up and down one tier at a time', () => {
    expect(nextTier('MOORING')).toBe('FAIRWAY');
    expect(nextTier('FAIRWAY')).toBe('HARBOR');
    expect(nextTier('HARBOR')).toBe('ADMIRALTY');
    expect(nextTier('ADMIRALTY')).toBeNull();
    expect(previousTier('MOORING')).toBeNull();
    expect(previousTier('ADMIRALTY')).toBe('HARBOR');
  });

  it('reports quota limits per plan', () => {
    expect(quotaLimitFor('MOORING', 'client')).toBe(1);
    expect(quotaLimitFor('MOORING', 'activeDomain')).toBe(2);
    expect(quotaLimitFor('HARBOR', 'activeDomain')).toBe(80);
    expect(quotaLimitFor('ADMIRALTY', 'activeDomain')).toBe(300);
  });

  it('labels every plan', () => {
    expect(planLabel('HARBOR')).toBe('Harbor');
  });
});

describe('statutory entitlements are never paywalled', () => {
  it('grants data export and erasure on every plan', () => {
    for (const plan of Object.values(planCatalog)) {
      for (const required of alwaysAllowedEntitlements) {
        expect(plan.features[required], `${plan.label} must include ${required}`).toBe(true);
      }
    }
  });

  it('gives the free plan aggregate reports, audit trail and its statutory rights, nothing else', () => {
    const free = planCatalog.MOORING.features;
    const granted = Object.entries(free)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key)
      .sort();

    expect(granted).toEqual(['audit.trail', 'data.erase', 'data.export', 'reports.aggregate']);
  });

  it('still offers pseudonymous forensic evidence on Fairway but never named', () => {
    expect(planCatalog.MOORING.features['reports.forensic']).toBe(false);
    expect(planCatalog.FAIRWAY.features['reports.forensic']).toBe(true);
    expect(planCatalog.HARBOR.features['reports.forensic']).toBe(true);
  });

  it('gates the agency growth features to the plans that can be grown into', () => {
    expect(planCatalog.MOORING.features['portal.client']).toBe(false);
    expect(planCatalog.FAIRWAY.features['portal.client']).toBe(false);
    expect(planCatalog.HARBOR.features['portal.client']).toBe(true);

    expect(planCatalog.MOORING.features['api.access']).toBe(false);
    expect(planCatalog.FAIRWAY.features['api.access']).toBe(false);
    expect(planCatalog.HARBOR.features['api.access']).toBe(true);

    expect(planCatalog.HARBOR.features['branding.whitelabel']).toBe(false);
    expect(planCatalog.ADMIRALTY.features['branding.whitelabel']).toBe(true);

    // SSO shipped, so Admiralty is now granted it. Provisioned members are
    // bounded by the connection's email domain allowlist and can never be given
    // the owner role, so trusting a provider is a way to admit a workspace's own
    // staff rather than a way to hand out ownership.
    expect(planCatalog.HARBOR.features['auth.sso']).toBe(false);
    expect(planCatalog.ADMIRALTY.features['auth.sso']).toBe(true);

    // Scheduled client digests moved from Fairway to Harbor, where the other
    // proof features sit.
    expect(planCatalog.FAIRWAY.features['digests']).toBe(false);
    expect(planCatalog.HARBOR.features['digests']).toBe(true);

    // Logo upload is an Admiralty feature, alongside white labelling.
    expect(planCatalog.HARBOR.features['branding.logoUpload']).toBe(false);
    expect(planCatalog.ADMIRALTY.features['branding.logoUpload']).toBe(true);

    // The Trust Center is live and starts at Harbor.
    expect(planCatalog.MOORING.features['trust.center']).toBe(false);
    expect(planCatalog.FAIRWAY.features['trust.center']).toBe(false);
    expect(planCatalog.HARBOR.features['trust.center']).toBe(true);
    expect(planCatalog.ADMIRALTY.features['trust.center']).toBe(true);
  });

  it('keeps named forensic evidence off every plan below Harbor', () => {
    expect(planCatalog.MOORING.features['reports.forensicNamed']).toBe(false);
    expect(planCatalog.FAIRWAY.features['reports.forensicNamed']).toBe(false);
    expect(planCatalog.HARBOR.features['reports.forensicNamed']).toBe(true);
    expect(planCatalog.ADMIRALTY.features['reports.forensicNamed']).toBe(true);
  });
});

describe('effective plan from subscription state', () => {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  it('treats a workspace with no subscription as the free plan', () => {
    expect(effectivePlan(null)).toBe('MOORING');
  });

  it('honours an active subscription', () => {
    expect(effectivePlan({ plan: 'HARBOR', status: 'ACTIVE', currentPeriodEnd: future })).toBe('HARBOR');
  });

  it('keeps a cancelled plan until the paid period ends', () => {
    expect(effectivePlan({ plan: 'HARBOR', status: 'CANCELLED', currentPeriodEnd: future })).toBe('HARBOR');
    expect(effectivePlan({ plan: 'HARBOR', status: 'CANCELLED', currentPeriodEnd: past })).toBe('MOORING');
  });

  it('drops a lapsed trial to the free plan', () => {
    expect(effectivePlan({ plan: 'ADMIRALTY', status: 'TRIALING', currentPeriodEnd: future })).toBe('ADMIRALTY');
    expect(effectivePlan({ plan: 'ADMIRALTY', status: 'TRIALING', currentPeriodEnd: past })).toBe('MOORING');
  });

  it('keeps a past due customer on the plan so billing can retry', () => {
    expect(effectivePlan({ plan: 'FAIRWAY', status: 'PAST_DUE', currentPeriodEnd: future })).toBe('FAIRWAY');
  });
});
