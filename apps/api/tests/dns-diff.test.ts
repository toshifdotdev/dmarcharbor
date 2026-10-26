import { describe, expect, it } from 'vitest';
import type { BimiResult, DkimResult, DmarcResult, MtaStsResult, MxResult, ScanResult, SpfResult, TlsRptResult } from '../src/scanner/types.js';
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

function mta(overrides: Partial<MtaStsResult> = {}): MtaStsResult {
  return {
    status: 'found',
    record: 'v=STSv1; id=abc',
    id: 'abc',
    policy: {
      url: 'https://mta-sts.example.test/.well-known/mta-sts.txt',
      status: 'fetched',
      mode: 'enforce',
      maxAge: 604800,
      mx: ['mx.example.test'],
      problems: [],
    },
    mxCoverage: [{ host: 'mx.example.test', covered: true }],
    ...overrides,
  };
}

function tls(overrides: Partial<TlsRptResult> = {}): TlsRptResult {
  return {
    status: 'found',
    record: 'v=TLSRPTv1; rua=mailto:tls@example.test',
    valid: true,
    mailtoTargets: ['mailto:tls@example.test'],
    httpsTargets: [],
    problems: [],
    ...overrides,
  };
}

function bimi(overrides: Partial<BimiResult> = {}): BimiResult {
  return {
    status: 'found',
    record: 'v=BIMI1; l=https://example.test/logo.svg',
    logoUrl: 'https://example.test/logo.svg',
    authorityUrl: null,
    declined: false,
    problems: [],
    dmarc: { qualifies: true, reasons: [] },
    logo: null,
    ...overrides,
  };
}

function scan(overrides: { dmarc?: Partial<DmarcResult>; spf?: Partial<SpfResult>; dkim?: Partial<DkimResult>; mx?: Partial<MxResult>; mtaSts?: MtaStsResult; tlsRpt?: TlsRptResult; bimi?: BimiResult } = {}): ScanResult {
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
    ...(overrides.mtaSts ? { mtaSts: overrides.mtaSts } : {}),
    ...(overrides.tlsRpt ? { tlsRpt: overrides.tlsRpt } : {}),
    ...(overrides.bimi ? { bimi: overrides.bimi } : {}),
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


describe('transport record changes', () => {
  it('reports MTA-STS removal, addition, mode changes and a policy becoming invalid', () => {
    const removed = diffScans(scan({ mtaSts: mta() }), scan({ mtaSts: mta({ status: 'missing', record: undefined, id: undefined, policy: null, mxCoverage: undefined }) }));
    expect(removed.find((draft) => draft.code === 'mta_sts_removed')?.kind).toBe('MTA_STS');

    const added = diffScans(scan({ mtaSts: mta({ status: 'missing', record: undefined, id: undefined, policy: null, mxCoverage: undefined }) }), scan({ mtaSts: mta() }));
    expect(added.find((draft) => draft.code === 'mta_sts_added')?.severity).toBe('INFO');

    const weakened = diffScans(
      scan({ mtaSts: mta() }),
      scan({ mtaSts: mta({ policy: { ...mta().policy!, mode: 'testing' } }) }),
    );
    expect(weakened.find((draft) => draft.code === 'mta_sts_mode_weakened')?.severity).toBe('WARNING');

    const strengthened = diffScans(
      scan({ mtaSts: mta({ policy: { ...mta().policy!, mode: 'testing' } }) }),
      scan({ mtaSts: mta() }),
    );
    expect(strengthened.find((draft) => draft.code === 'mta_sts_mode_strengthened')?.severity).toBe('INFO');

    const broken = diffScans(
      scan({ mtaSts: mta() }),
      scan({ mtaSts: mta({ policy: { ...mta().policy!, status: 'invalid', problems: ['mode must be enforce'] } }) }),
    );
    expect(broken.find((draft) => draft.code === 'mta_sts_policy_broken')?.severity).toBe('WARNING');
  });

  it('does not call an unavailable policy a break, or compare a lookup error', () => {
    const unavailableBefore = diffScans(
      scan({ mtaSts: mta({ policy: { ...mta().policy!, status: 'unavailable', detail: 'TLS failed', problems: [] } }) }),
      scan({ mtaSts: mta({ policy: { ...mta().policy!, status: 'invalid', problems: ['bad'] } }) }),
    );
    expect(unavailableBefore.map((draft) => draft.code)).not.toContain('mta_sts_policy_broken');

    const fetchedThenUnavailable = diffScans(
      scan({ mtaSts: mta() }),
      scan({ mtaSts: mta({ policy: { ...mta().policy!, status: 'unavailable', detail: 'TLS failed', problems: [] } }) }),
    );
    expect(fetchedThenUnavailable.map((draft) => draft.code)).not.toContain('mta_sts_policy_broken');

    const errored = diffScans(
      scan({ mtaSts: mta({ status: 'error', policy: null, record: undefined }) }),
      scan({ mtaSts: mta() }),
    );
    expect(errored.filter((draft) => draft.code.startsWith('mta_sts_'))).toEqual([]);
  });

  it('reports TLS-RPT removal, addition and changed reporting addresses', () => {
    const removed = diffScans(scan({ tlsRpt: tls() }), scan({ tlsRpt: tls({ status: 'missing', record: undefined, valid: false, mailtoTargets: [] }) }));
    expect(removed.find((draft) => draft.code === 'tls_rpt_removed')?.kind).toBe('TLS_RPT');

    const added = diffScans(scan({ tlsRpt: tls({ status: 'missing', record: undefined, valid: false, mailtoTargets: [] }) }), scan({ tlsRpt: tls() }));
    expect(added.find((draft) => draft.code === 'tls_rpt_added')?.severity).toBe('INFO');

    const changed = diffScans(
      scan({ tlsRpt: tls() }),
      scan({ tlsRpt: tls({ mailtoTargets: ['mailto:new@example.test'], httpsTargets: ['https://tls.example.test/report'] }) }),
    );
    expect(changed.find((draft) => draft.code === 'tls_rpt_changed')?.severity).toBe('INFO');
  });

  it('reports BIMI removal, addition and a logo change, ignoring inherited records', () => {
    const removed = diffScans(scan({ bimi: bimi() }), scan({ bimi: bimi({ status: 'missing', record: undefined, logoUrl: null }) }));
    expect(removed.find((draft) => draft.code === 'bimi_removed')?.kind).toBe('BIMI');

    const inheritedMissing = diffScans(
      scan({ bimi: bimi({ inheritedFrom: 'example.test' }) }),
      scan({ bimi: bimi({ status: 'missing', record: undefined, logoUrl: null }) }),
    );
    expect(inheritedMissing.map((draft) => draft.code)).not.toContain('bimi_removed');

    const added = diffScans(scan({ bimi: bimi({ status: 'missing', record: undefined, logoUrl: null }) }), scan({ bimi: bimi() }));
    expect(added.find((draft) => draft.code === 'bimi_added')?.severity).toBe('INFO');

    const inheritedAdded = diffScans(
      scan({ bimi: bimi({ status: 'missing', record: undefined, logoUrl: null }) }),
      scan({ bimi: bimi({ inheritedFrom: 'example.test' }) }),
    );
    expect(inheritedAdded.find((draft) => draft.code === 'bimi_added')?.kind).toBe('BIMI');

    const changed = diffScans(scan({ bimi: bimi() }), scan({ bimi: bimi({ logoUrl: 'https://example.test/new.svg' }) }));
    expect(changed.find((draft) => draft.code === 'bimi_changed')?.severity).toBe('INFO');
  });

  it('produces no transport change when an old scan did not store the fields', () => {
    const drafts = diffScans(scan(), scan({ mtaSts: mta(), tlsRpt: tls(), bimi: bimi() }));
    expect(drafts.filter((draft) => ['MTA_STS', 'TLS_RPT', 'BIMI'].includes(draft.kind))).toEqual([]);
  });
});
