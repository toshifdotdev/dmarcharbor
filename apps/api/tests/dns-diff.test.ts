import { describe, expect, it } from 'vitest';
import type { DkimResult, DmarcResult, MxResult, ScanResult, SpfResult } from '../src/scanner/types.js';
import { diffScans } from '../src/services/monitoring/dns-diff.js';

const OUR_URI = 'mailto:dmarc-reports@reports.dmarcharbor.com';
const CLIENT_URI = 'mailto:dmarc-reports+abcdef012345@reports.dmarcharbor.com';

function dmarc(overrides: Partial<DmarcResult> = {}): DmarcResult {
  return {
    status: 'found',
    record: `v=DMARC1; p=reject; rua=${OUR_URI}`,
    policy: 'reject',
    tags: { v: 'DMARC1', p: 'reject', rua: OUR_URI },
    hasAggregateReports: true,
    hasForensicReports: false,
    aggregateMailtoTargets: ['dmarc-reports@reports.dmarcharbor.com'],
    aggregateWebTargets: [],
    testing: false,
    effectivePolicy: 'reject',
    ...overrides,
  };
}

function spf(overrides: Partial<SpfResult> = {}): SpfResult {
  return { status: 'found', record: 'v=spf1 -all', valid: true, lookupCount: 0, lookupLimitExceeded: false, lookupTree: [], ...overrides };
}

function dkim(overrides: Partial<DkimResult> = {}): DkimResult {
  return {
    status: 'found',
    selectors: ['default'],
    checkedSelectors: ['default'],
    records: { default: 'v=DKIM1; p=abc' },
    ...overrides,
  };
}

function mx(overrides: Partial<MxResult> = {}): MxResult {
  return { status: 'found', records: [{ exchange: 'mx.example.test', priority: 10 }], ...overrides };
}

function scan(overrides: { dmarc?: Partial<DmarcResult>; spf?: Partial<SpfResult>; dkim?: Partial<DkimResult>; mx?: Partial<MxResult> } = {}): ScanResult {
  return {
    domain: 'example.test',
    scannedAt: '2026-10-26T12:00:00.000Z',
    status: 'healthy',
    score: 100,
    scoreBreakdown: { base: 100, final: 100, factors: [] },
    dmarc: dmarc(overrides.dmarc),
    spf: spf(overrides.spf),
    dkim: dkim(overrides.dkim),
    mx: mx(overrides.mx),
    issues: [],
    recommendations: [],
  };
}

describe('DMARC record changes', () => {
  it('reports a removed and a published record', () => {
    const removed = diffScans(scan(), scan({ dmarc: { status: 'missing', record: undefined, policy: 'unknown', tags: {}, aggregateMailtoTargets: [], aggregateWebTargets: [] } }));
    expect(removed.map((draft) => draft.code)).toContain('dmarc_record_removed');
    expect(removed.find((draft) => draft.code === 'dmarc_record_removed')?.severity).toBe('CRITICAL');

    const added = diffScans(
      scan({ dmarc: { status: 'missing', record: undefined, policy: 'unknown', tags: {}, aggregateMailtoTargets: [], aggregateWebTargets: [] } }),
      scan(),
    );
    expect(added.map((draft) => draft.code)).toContain('dmarc_record_added');
    expect(added.find((draft) => draft.code === 'dmarc_record_added')?.severity).toBe('INFO');
  });

  it('reports a changed record only when no policy or rua change explains it', () => {
    const changed = diffScans(
      scan({ dmarc: { record: `v=DMARC1; p=reject; adkim=r; rua=${OUR_URI}` } }),
      scan({ dmarc: { record: `v=DMARC1; p=reject; adkim=s; rua=${OUR_URI}`, tags: { v: 'DMARC1', p: 'reject', adkim: 's', rua: OUR_URI } } }),
    );
    expect(changed.map((draft) => draft.code)).toContain('dmarc_record_changed');

    const policyExplained = diffScans(
      scan({ dmarc: { record: `v=DMARC1; p=reject; rua=${OUR_URI}` } }),
      scan({ dmarc: { record: `v=DMARC1; p=none; rua=${OUR_URI}`, policy: 'none', effectivePolicy: 'none', tags: { v: 'DMARC1', p: 'none', rua: OUR_URI } } }),
    );
    expect(policyExplained.map((draft) => draft.code)).toContain('dmarc_policy_weakened');
    expect(policyExplained.map((draft) => draft.code)).not.toContain('dmarc_record_changed');
  });

  it('treats t=y as one level softer when a scan did not store effectivePolicy', () => {
    const previous = scan({
      dmarc: {
        policy: 'reject',
        testing: false,
        effectivePolicy: undefined,
        tags: { v: 'DMARC1', p: 'reject', rua: OUR_URI },
      },
    });
    const current = scan({
      dmarc: {
        record: `v=DMARC1; p=reject; t=y; rua=${OUR_URI}`,
        policy: 'reject',
        testing: true,
        effectivePolicy: undefined,
        tags: { v: 'DMARC1', p: 'reject', t: 'y', rua: OUR_URI },
      },
    });

    const drafts = diffScans(previous, current);
    expect(drafts.find((draft) => draft.code === 'dmarc_policy_weakened')?.summary).toContain('p=reject to p=quarantine');
    expect(drafts.find((draft) => draft.code === 'dmarc_policy_weakened')?.severity).toBe('CRITICAL');
  });

  it('reports a strengthened policy', () => {
    const drafts = diffScans(
      scan({ dmarc: { policy: 'none', effectivePolicy: 'none', tags: { p: 'none', rua: OUR_URI } } }),
      scan(),
    );
    const draft = drafts.find((entry) => entry.code === 'dmarc_policy_strengthened');
    expect(draft?.severity).toBe('INFO');
    expect(draft?.summary).toContain('p=none to p=reject');
  });

  it('uses sp and np fallbacks and reports subdomain weakening', () => {
    const sp = diffScans(
      scan({ dmarc: { policy: 'none', effectivePolicy: 'none', tags: { p: 'none', sp: 'reject' } } }),
      scan({ dmarc: { policy: 'none', effectivePolicy: 'none', tags: { p: 'none' } } }),
    );
    expect(sp.find((draft) => draft.code === 'dmarc_subdomain_policy_weakened')?.summary).toContain('sp=reject to sp=none');

    const np = diffScans(
      scan({ dmarc: { policy: 'none', effectivePolicy: 'none', tags: { p: 'none', np: 'reject' } } }),
      scan({ dmarc: { policy: 'none', effectivePolicy: 'none', tags: { p: 'none' } } }),
    );
    expect(np.find((draft) => draft.code === 'dmarc_subdomain_policy_weakened')?.summary).toContain('np=reject to np=none');
  });

  it('reports one change, not two, when p drops and sp and np only inherit it', () => {
    const drafts = diffScans(
      scan(),
      scan({ dmarc: { record: `v=DMARC1; p=none; rua=${OUR_URI}`, policy: 'none', effectivePolicy: 'none', tags: { v: 'DMARC1', p: 'none', rua: OUR_URI } } }),
    );
    expect(drafts.map((draft) => draft.code)).toEqual(['dmarc_policy_weakened']);
  });

  it('reports a record receivers now discard, and its repair', () => {
    const broken = dmarc({
      status: 'error',
      record: 'v=DMARC1; p=reject | v=DMARC1; p=none',
      policy: 'unknown',
      effectivePolicy: undefined,
      aggregateMailtoTargets: [],
      aggregateWebTargets: [],
    });
    const invalid = diffScans(scan(), scan({ dmarc: broken }));
    expect(invalid.find((draft) => draft.code === 'dmarc_record_invalid')?.severity).toBe('CRITICAL');

    const repaired = diffScans(scan({ dmarc: broken }), scan());
    expect(repaired.map((draft) => draft.code)).toContain('dmarc_record_repaired');

    // An error with no record text is a failed lookup: unknown, never a change.
    const failedLookup = diffScans(scan(), scan({ dmarc: { ...broken, record: undefined } }));
    expect(failedLookup.map((draft) => draft.code)).not.toContain('dmarc_record_invalid');
  });
});

describe('SPF validity and old scans', () => {
  it('reports a second SPF record as critical', () => {
    const drafts = diffScans(
      scan(),
      scan({ spf: { status: 'error', record: 'v=spf1 -all | v=spf1 ~all', valid: false } }),
    );
    expect(drafts.find((draft) => draft.code === 'spf_record_invalid')?.severity).toBe('CRITICAL');
  });

  it('does not compare a pre-recursive lookup count with a recursive one', () => {
    const drafts = diffScans(
      scan({ spf: { lookupLimitExceeded: false, lookupCount: 4, lookupTree: undefined } }),
      scan({ spf: { lookupLimitExceeded: true, lookupCount: 12 } }),
    );
    expect(drafts.map((draft) => draft.code)).not.toContain('spf_lookup_limit_exceeded');
  });
});

describe('DMARC report addresses', () => {
  it('reports our address removed and added, including a client token address', () => {
    const removed = diffScans(
      scan({ dmarc: { aggregateMailtoTargets: ['dmarc-reports+abcdef012345@reports.dmarcharbor.com', 'agg@dmarcian.com'] } }),
      scan({ dmarc: { aggregateMailtoTargets: ['agg@dmarcian.com'] } }),
    );
    expect(removed.find((draft) => draft.code === 'dmarc_rua_ours_removed')?.severity).toBe('CRITICAL');

    const added = diffScans(
      scan({ dmarc: { aggregateMailtoTargets: ['agg@dmarcian.com'] } }),
      scan({ dmarc: { aggregateMailtoTargets: ['dmarc-reports+abcdef012345@reports.dmarcharbor.com', 'agg@dmarcian.com'] } }),
    );
    expect(added.find((draft) => draft.code === 'dmarc_rua_ours_added')?.severity).toBe('INFO');
  });

  it('reports a change in non-ours addresses with the added and removed lists', () => {
    const drafts = diffScans(
      scan({ dmarc: { aggregateMailtoTargets: ['a@dmarcian.com'] } }),
      scan({ dmarc: { aggregateMailtoTargets: ['b@easydmarc.us'] } }),
    );
    const draft = drafts.find((entry) => entry.code === 'dmarc_rua_changed');
    expect(draft?.summary).toContain('b@easydmarc.us');
    expect(draft?.summary).toContain('a@dmarcian.com');
    expect(draft?.severity).toBe('INFO');
  });

  it('does not report our own address as a non-ours change', () => {
    const drafts = diffScans(
      scan({ dmarc: { aggregateMailtoTargets: ['agg@dmarcian.com'] } }),
      scan({ dmarc: { aggregateMailtoTargets: [CLIENT_URI.replace('mailto:', ''), 'agg@dmarcian.com'] } }),
    );
    expect(drafts.map((draft) => draft.code)).toEqual(['dmarc_rua_ours_added']);
  });

  it('treats a missing rua array as unknown', () => {
    const previous = scan();
    (previous.dmarc as unknown as { aggregateMailtoTargets?: unknown }).aggregateMailtoTargets = undefined;
    const drafts = diffScans(previous, scan({ dmarc: { aggregateMailtoTargets: ['agg@dmarcian.com'] } }));
    expect(drafts.map((draft) => draft.code)).not.toContain('dmarc_rua_changed');
    expect(drafts.map((draft) => draft.code)).not.toContain('dmarc_rua_ours_removed');
  });
});

describe('SPF changes', () => {
  it('reports record removal, addition and change', () => {
    expect(
      diffScans(scan(), scan({ spf: { status: 'missing', record: undefined, valid: false } })).map((d) => d.code),
    ).toContain('spf_record_removed');
    expect(
      diffScans(scan({ spf: { status: 'missing', record: undefined, valid: false } }), scan()).map((d) => d.code),
    ).toContain('spf_record_added');
    expect(
      diffScans(scan({ spf: { record: 'v=spf1 -all' } }), scan({ spf: { record: 'v=spf1 include:_spf.google.com -all' } })).map((d) => d.code),
    ).toContain('spf_record_changed');
  });

  it('reports crossing the lookup limit in both directions', () => {
    const exceeded = diffScans(
      scan({ spf: { lookupLimitExceeded: false, lookupCount: 9 } }),
      scan({ spf: { lookupLimitExceeded: true, lookupCount: 11 } }),
    );
    expect(exceeded.find((d) => d.code === 'spf_lookup_limit_exceeded')?.severity).toBe('CRITICAL');
    expect(exceeded.find((d) => d.code === 'spf_lookup_limit_exceeded')?.summary).toContain('11');

    const cleared = diffScans(
      scan({ spf: { lookupLimitExceeded: true, lookupCount: 11 } }),
      scan({ spf: { lookupLimitExceeded: false, lookupCount: 8 } }),
    );
    expect(cleared.find((d) => d.code === 'spf_lookup_limit_cleared')?.severity).toBe('INFO');
  });

  it('reports a more permissive all qualifier, with a missing all treated as neutral', () => {
    const drafts = diffScans(scan({ spf: { record: 'v=spf1 -all' } }), scan({ spf: { record: 'v=spf1 ~all' } }));
    expect(drafts.find((d) => d.code === 'spf_all_weakened')?.summary).toContain('-all to ~all');

    const missing = diffScans(scan({ spf: { record: 'v=spf1 -all' } }), scan({ spf: { record: 'v=spf1 include:_spf.google.com' } }));
    expect(missing.find((d) => d.code === 'spf_all_weakened')?.summary).toContain('-all to ?all');
  });
});

describe('DKIM changes', () => {
  it('reports a selector removed only when it was checked and not skipped', () => {
    const removed = diffScans(
      scan({ dkim: { selectors: ['default', 'google'], checkedSelectors: ['default', 'google'] } }),
      scan({ dkim: { selectors: ['default'], checkedSelectors: ['default', 'google'], skippedSelectors: [] } }),
    );
    expect(removed.find((d) => d.code === 'dkim_selector_removed')?.severity).toBe('WARNING');

    const skipped = diffScans(
      scan({ dkim: { selectors: ['default', 'google'], checkedSelectors: ['default', 'google'] } }),
      scan({ dkim: { selectors: ['default'], checkedSelectors: ['default'], skippedSelectors: ['google'] } }),
    );
    expect(skipped.map((d) => d.code)).not.toContain('dkim_selector_removed');
  });

  it('words a revoked key as revoked', () => {
    const drafts = diffScans(
      scan({ dkim: { selectors: ['default', 'google'], checkedSelectors: ['default', 'google'] } }),
      scan({
        dkim: {
          selectors: ['default'],
          checkedSelectors: ['default', 'google'],
          revokedSelectors: ['google'],
        },
      }),
    );
    expect(drafts.find((d) => d.code === 'dkim_selector_removed')?.summary).toContain('revoked');
  });

  it('reports a selector added', () => {
    const drafts = diffScans(
      scan(),
      scan({ dkim: { selectors: ['default', 'resend'], checkedSelectors: ['default', 'resend'] } }),
    );
    expect(drafts.find((d) => d.code === 'dkim_selector_added')?.summary).toContain('resend');
  });

  it('treats missing checkedSelectors as unknown', () => {
    const previous = scan({ dkim: { selectors: ['default', 'google'] } });
    const current = scan({ dkim: { selectors: ['default'] } });
    (current.dkim as unknown as { checkedSelectors?: unknown }).checkedSelectors = undefined;
    const drafts = diffScans(previous, current);
    expect(drafts.map((d) => d.code)).not.toContain('dkim_selector_removed');
  });

  it('does not turn a failed DKIM lookup into a removal', () => {
    const drafts = diffScans(
      scan({ dkim: { selectors: ['default'], checkedSelectors: ['default'] } }),
      scan({
        dkim: {
          status: 'error',
          selectors: [],
          checkedSelectors: ['default'],
          records: {},
          error: 'One or more DKIM lookups failed.',
        },
      }),
    );

    expect(drafts.map((d) => d.code)).not.toContain('dkim_selector_removed');
  });
});

describe('MX changes', () => {
  it('reports MX removed and host changes', () => {
    expect(
      diffScans(scan(), scan({ mx: { status: 'missing', records: [] } })).find((d) => d.code === 'mx_removed')?.severity,
    ).toBe('WARNING');

    const changed = diffScans(
      scan(),
      scan({ mx: { records: [{ exchange: 'mx2.example.test', priority: 5 }] } }),
    );
    expect(changed.find((d) => d.code === 'mx_changed')?.summary).toContain('mx2.example.test');
  });

  it('does not turn a failed MX lookup into a removal', () => {
    const drafts = diffScans(
      scan(),
      scan({ mx: { status: 'error', records: [], error: 'resolver unavailable' } }),
    );

    expect(drafts.map((d) => d.code)).not.toContain('mx_removed');
    expect(drafts.map((d) => d.code)).not.toContain('mx_changed');
  });
});

describe('determinism and missing data', () => {
  it('orders drafts by the table order, whatever order the inputs changed in', () => {
    const drafts = diffScans(
      scan({
        dmarc: { policy: 'reject', effectivePolicy: 'reject', record: `v=DMARC1; p=reject; rua=${OUR_URI},mailto:old@dmarcian.com`, aggregateMailtoTargets: ['dmarc-reports@reports.dmarcharbor.com', 'old@dmarcian.com'] },
        spf: { record: 'v=spf1 -all', lookupLimitExceeded: false },
        dkim: { selectors: ['default', 'google'], checkedSelectors: ['default', 'google'] },
      }),
      scan({
        dmarc: { policy: 'none', effectivePolicy: 'none', record: `v=DMARC1; p=none; rua=mailto:new@easydmarc.us`, aggregateMailtoTargets: ['new@easydmarc.us'] },
        spf: { record: 'v=spf1 ~all', lookupLimitExceeded: true, lookupCount: 11 },
        dkim: { selectors: ['default'], checkedSelectors: ['default', 'google'] },
        mx: { records: [{ exchange: 'mx2.example.test', priority: 5 }] },
      }),
    );

    expect(drafts.map((draft) => draft.code)).toEqual([
      'dmarc_policy_weakened',
      'dmarc_rua_ours_removed',
      'dmarc_rua_changed',
      'spf_record_changed',
      'spf_lookup_limit_exceeded',
      'spf_all_weakened',
      'dkim_selector_removed',
      'mx_changed',
    ]);
  });

  it('produces nothing when an old scan did not store the field', () => {
    const previous = scan();
    (previous.spf as unknown as { lookupLimitExceeded?: unknown }).lookupLimitExceeded = undefined;
    (previous.dkim as unknown as { selectors?: unknown }).selectors = undefined;
    (previous.mx as unknown as { records?: unknown }).records = undefined;
    (previous.dmarc as unknown as { aggregateMailtoTargets?: unknown }).aggregateMailtoTargets = undefined;

    const drafts = diffScans(
      previous,
      scan({
        spf: { record: 'v=spf1 ~all', lookupLimitExceeded: true, lookupCount: 11 },
        dkim: { selectors: ['resend'], checkedSelectors: ['resend'] },
        mx: { records: [] },
        dmarc: { aggregateMailtoTargets: ['new@easydmarc.us'] },
      }),
    );

    expect(drafts.map((draft) => draft.code)).not.toContain('spf_lookup_limit_exceeded');
    expect(drafts.map((draft) => draft.code)).not.toContain('dkim_selector_removed');
    expect(drafts.map((draft) => draft.code)).not.toContain('mx_removed');
    expect(drafts.map((draft) => draft.code)).not.toContain('dmarc_rua_changed');
  });
});
