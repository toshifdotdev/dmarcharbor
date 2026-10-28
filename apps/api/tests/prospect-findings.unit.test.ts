import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../src/models/scan.model.js';
import { assessProspect } from '../src/services/prospect/prospect-findings.js';

/**
 * What a prospect reads. Each case is a domain state an MSP meets every week,
 * and the assertion is on the sentence a non-technical reader gets.
 */

function scan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    domain: 'acme.com',
    scannedAt: '2026-11-26T10:00:00.000Z',
    status: 'healthy',
    score: 90,
    scoreBreakdown: { base: 100, final: 90, factors: [] },
    dmarc: {
      status: 'found',
      record: 'v=DMARC1; p=reject; rua=mailto:d@acme.com',
      policy: 'reject',
      tags: { p: 'reject' },
      hasAggregateReports: true,
      hasForensicReports: false,
      aggregateMailtoTargets: ['d@acme.com'],
      aggregateWebTargets: [],
    },
    spf: { status: 'found', record: 'v=spf1 include:_spf.google.com -all', valid: true, lookupCount: 3 },
    dkim: { status: 'found', selectors: ['google'], checkedSelectors: ['google', 'selector1'], records: {} },
    mx: { status: 'found', records: [{ exchange: 'aspmx.l.google.com', priority: 1 }] },
    issues: [],
    recommendations: [],
    ...overrides,
  };
}

function finding(result: ReturnType<typeof assessProspect>, key: string) {
  return result.findings.find((entry) => entry.key === key);
}

describe('prospect assessment', () => {
  it('calls a domain with no DMARC high risk and says what a criminal can do', () => {
    const result = assessProspect(
      scan({
        dmarc: {
          status: 'missing',
          policy: 'unknown',
          tags: {},
          hasAggregateReports: false,
          hasForensicReports: false,
          aggregateMailtoTargets: [],
          aggregateWebTargets: [],
        },
      }),
    );
    expect(result.level).toBe('high');
    expect(result.headline).toBe('acme.com can be impersonated by email today.');
    const spoof = finding(result, 'spoofing')!;
    expect(spoof.status).toBe('risk');
    expect(spoof.headline).toBe('Anyone can send email that claims to be from acme.com.');
    expect(spoof.detail).toContain('accounts@acme.com');
    // No reporting finding without a record to report on; the inbox rules name what is missing.
    expect(finding(result, 'reporting')).toBeUndefined();
    expect(finding(result, 'inbox-rules')!.detail).toContain('DMARC');
    // Worst first.
    expect(result.findings[0]!.status).toBe('risk');
  });

  it('treats p=none as not blocking, and flags missing reports', () => {
    const result = assessProspect(
      scan({
        dmarc: {
          status: 'found',
          record: 'v=DMARC1; p=none',
          policy: 'none',
          tags: { p: 'none' },
          hasAggregateReports: false,
          hasForensicReports: false,
          aggregateMailtoTargets: [],
          aggregateWebTargets: [],
        },
      }),
    );
    expect(result.level).toBe('high');
    expect(finding(result, 'spoofing')!.headline).toContain('is not blocked');
    expect(finding(result, 'reporting')!.status).toBe('warn');
  });

  it('is medium at quarantine, and low only when everything is in place', () => {
    const quarantine = assessProspect(
      scan({
        dmarc: { ...scan().dmarc, policy: 'quarantine', record: 'v=DMARC1; p=quarantine; rua=mailto:d@acme.com' },
      }),
    );
    expect(quarantine.level).toBe('medium');
    expect(finding(quarantine, 'spoofing')!.headline).toContain('sent to spam, not refused');

    const healthy = assessProspect(scan());
    expect(healthy.level).toBe('low');
    expect(healthy.headline).toBe('acme.com is well protected against email impersonation.');
    expect(healthy.findings.every((entry) => entry.status === 'good')).toBe(true);
  });

  it('never claims DKIM is absent, only that the common names had no key', () => {
    const result = assessProspect(scan({ dkim: { status: 'missing', selectors: [], checkedSelectors: ['a', 'b', 'c'], records: {} } }));
    const signing = finding(result, 'signing')!;
    expect(signing.status).toBe('warn');
    expect(signing.detail).toContain('not proof there are none');
    expect(signing.detail).toContain('checked 3');
    expect(result.level).toBe('medium');
  });

  it('explains an SPF record over the lookup limit as a real failure', () => {
    const result = assessProspect(
      scan({ spf: { status: 'found', record: 'v=spf1 ...', valid: true, lookupCount: 14, lookupLimitExceeded: true } }),
    );
    const spf = finding(result, 'senders')!;
    expect(spf.status).toBe('risk');
    expect(spf.detail).toContain('14 DNS lookups');
    expect(finding(result, 'inbox-rules')!.detail).toContain('SPF');
  });

  it('makes no claim when a lookup failed', () => {
    const result = assessProspect(
      scan({
        dmarc: {
          status: 'error',
          policy: 'unknown',
          tags: {},
          hasAggregateReports: false,
          hasForensicReports: false,
          aggregateMailtoTargets: [],
          aggregateWebTargets: [],
          error: 'SERVFAIL',
        },
      }),
    );
    expect(finding(result, 'spoofing')!.status).toBe('unknown');
    expect(finding(result, 'spoofing')!.detail).toContain('makes no claim');
    expect(result.level).toBe('medium');
  });

  it('notes a domain that receives no mail and how to lock it down', () => {
    const result = assessProspect(scan({ mx: { status: 'missing', records: [] } }));
    expect(finding(result, 'receiving')!.fix).toContain('v=spf1 -all');
  });
});
