import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../src/models/scan.model.js';
import { historySummary, readPosture, shareText } from '../src/services/trust/client-evidence.js';

/**
 * The readings the Trust Center and the evidence pack print about a domain.
 *
 * What is pinned here is honesty, not wording: a domain with no check is not a
 * pass, an optional standard that is absent is not a failure, a weak policy is
 * not called enforced, and a report address is only "to monitoring" when it is
 * actually ours.
 */

const ours = (uri: string) => uri.toLowerCase().includes('@reports.example');

function base(): ScanResult {
  return {
    domain: 'haskerley-law.example',
    scannedAt: '2026-12-01T06:00:00.000Z',
    status: 'healthy',
    score: 95,
    scoreBreakdown: { base: 100, final: 95, factors: [] },
    dmarc: {
      status: 'found',
      record: 'v=DMARC1; p=reject; rua=mailto:dmarc+abcdefabcdef@reports.example',
      policy: 'reject',
      tags: { v: 'DMARC1', p: 'reject', rua: 'mailto:dmarc+abcdefabcdef@reports.example' },
      hasAggregateReports: true,
      hasForensicReports: false,
      aggregateMailtoTargets: ['mailto:dmarc+abcdefabcdef@reports.example'],
      aggregateWebTargets: [],
    },
    spf: { status: 'found', record: 'v=spf1 include:_spf.google.com -all', valid: true, lookupCount: 4 },
    dkim: { status: 'found', selectors: ['google'], checkedSelectors: ['google', 'selector1'], records: {} },
    mx: { status: 'found', records: [] },
    mtaSts: {
      status: 'found',
      record: 'v=STSv1; id=2026',
      policy: { url: 'https://mta-sts.haskerley-law.example/.well-known/mta-sts.txt', status: 'fetched', mode: 'enforce', problems: [] },
    },
    tlsRpt: { status: 'found', record: 'v=TLSRPTv1; rua=mailto:tls@reports.example', valid: true, mailtoTargets: ['mailto:tls@reports.example'], httpsTargets: [], problems: [] },
    bimi: {
      status: 'missing',
      logoUrl: null,
      authorityUrl: null,
      declined: false,
      problems: [],
      dmarc: { qualifies: true, reasons: [] },
      logo: null,
    },
    issues: [],
    recommendations: [],
  };
}

describe('domain posture readings', () => {
  it('reads an enforced, fully reported domain as passing, and an absent BIMI as not published', () => {
    const reading = readPosture(base(), new Date('2026-12-01T06:00:00.000Z'), ours);
    expect(reading.checkedAt).toBe('2026-12-01T06:00:00.000Z');
    expect(reading.dmarc).toMatchObject({ state: 'pass', word: 'p=reject', policy: 'reject', level: 2, reporting: 'this-service' });
    expect(reading.spf).toMatchObject({ state: 'pass', word: 'Valid' });
    expect(reading.spf.detail).toContain('4 of 10 lookups');
    expect(reading.dkim).toMatchObject({ state: 'pass', selectors: ['google'] });
    expect(reading.mtaSts).toMatchObject({ state: 'pass', word: 'enforce' });
    expect(reading.tlsRpt.state).toBe('pass');
    expect(reading.bimi).toMatchObject({ state: 'absent', word: 'Not published' });
  });

  it('never reads a domain without a check as a pass', () => {
    const reading = readPosture(null, null, ours);
    for (const check of [reading.dmarc, reading.spf, reading.dkim, reading.mtaSts, reading.tlsRpt, reading.bimi]) {
      expect(check.state).toBe('unchecked');
      expect(check.word).toBe('Not checked yet');
    }
    expect(reading.dmarc.reporting).toBe('unknown');
    expect(reading.checkedAt).toBeNull();
  });

  it('calls p=none monitoring only, and testing or a partial pct short of enforced', () => {
    const none = base();
    none.dmarc = { ...none.dmarc, policy: 'none', tags: { ...none.dmarc.tags, p: 'none' } };
    expect(readPosture(none, null, ours).dmarc).toMatchObject({ state: 'warn', word: 'p=none', level: 0 });

    const testing = base();
    testing.dmarc = { ...testing.dmarc, testing: true };
    const t = readPosture(testing, null, ours).dmarc;
    expect(t.state).toBe('warn');
    expect(t.detail).toContain('quarantine');

    const partial = base();
    partial.dmarc = { ...partial.dmarc, tags: { ...partial.dmarc.tags, pct: '50' } };
    const p = readPosture(partial, null, ours).dmarc;
    expect(p.state).toBe('warn');
    expect(p.detail).toContain('50%');
  });

  it('marks a missing DMARC or SPF record as failing, and an SPF over its lookup limit too', () => {
    const missing = base();
    missing.dmarc = { ...missing.dmarc, status: 'missing', record: undefined, policy: 'unknown', aggregateMailtoTargets: [] };
    missing.spf = { status: 'missing', valid: false, lookupCount: 0 };
    const reading = readPosture(missing, null, ours);
    expect(reading.dmarc).toMatchObject({ state: 'fail', word: 'No record', reporting: 'none', level: null });
    expect(reading.spf).toMatchObject({ state: 'fail', word: 'No record' });

    const over = base();
    over.spf = { ...over.spf, lookupCount: 13, lookupLimitExceeded: true };
    expect(readPosture(over, null, ours).spf).toMatchObject({ state: 'fail', word: 'Over 10 lookups' });
  });

  it('only says reports go to monitoring when the address is ours', () => {
    const elsewhere = base();
    elsewhere.dmarc = { ...elsewhere.dmarc, aggregateMailtoTargets: ['mailto:dmarc@vendor.example'] };
    expect(readPosture(elsewhere, null, ours).dmarc.reporting).toBe('elsewhere');

    const none = base();
    none.dmarc = { ...none.dmarc, aggregateMailtoTargets: [], tags: { v: 'DMARC1', p: 'reject' } };
    expect(readPosture(none, null, ours).dmarc.reporting).toBe('none');
  });

  it('reads a check made before the transport checks existed as not checked, not absent', () => {
    const old = base();
    delete old.mtaSts;
    delete old.tlsRpt;
    delete old.bimi;
    const reading = readPosture(old, null, ours);
    expect(reading.mtaSts.state).toBe('unchecked');
    expect(reading.tlsRpt.state).toBe('unchecked');
    expect(reading.bimi.state).toBe('unchecked');
  });

  it('restates the two history lines written in the monitor voice', () => {
    expect(historySummary('dmarc_rua_ours_removed', 'Our report address was removed from rua.')).not.toContain('Our');
    expect(historySummary('dmarc_policy_strengthened', 'The DMARC policy strengthened from p=none to p=quarantine.')).toBe(
      'The DMARC policy strengthened from p=none to p=quarantine.',
    );
  });

  it('never rounds a pass rate up to 100% and gives no rate for no mail', () => {
    expect(shareText(999, 1000)).toBe('99.9%');
    expect(shareText(9999, 10000)).toBe('99.9%');
    expect(shareText(10, 10)).toBe('100%');
    expect(shareText(0, 0)).toBe('Nil');
  });
});
