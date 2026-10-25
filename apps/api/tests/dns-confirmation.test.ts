import { describe, expect, it, vi } from 'vitest';
import type { DnsReader, ScanResult } from '../src/scanner/types.js';
import { confirmDnsRemovals } from '../src/services/monitoring/dns-removal-confirmation.js';
import { diffScans } from '../src/services/monitoring/dns-diff.js';

function scan(input: { dmarcMissing?: boolean; spfMissing?: boolean } = {}): ScanResult {
  return {
    domain: 'example.test',
    scannedAt: '2026-10-26T12:00:00.000Z',
    status: 'healthy',
    score: 100,
    scoreBreakdown: { base: 100, final: 100, factors: [] },
    dmarc: input.dmarcMissing
      ? {
          status: 'missing',
          policy: 'unknown',
          tags: {},
          hasAggregateReports: false,
          hasForensicReports: false,
          aggregateMailtoTargets: [],
          aggregateWebTargets: [],
        }
      : {
          status: 'found',
          record: 'v=DMARC1; p=none; rua=mailto:dmarc-reports@reports.dmarcharbor.com',
          policy: 'none',
          tags: { p: 'none' },
          hasAggregateReports: true,
          hasForensicReports: false,
          aggregateMailtoTargets: ['dmarc-reports@reports.dmarcharbor.com'],
          aggregateWebTargets: [],
        },
    spf: input.spfMissing
      ? { status: 'missing', valid: false, lookupCount: 0 }
      : { status: 'found', record: 'v=spf1 -all', valid: true, lookupCount: 0 },
    dkim: { status: 'missing', selectors: [], checkedSelectors: [], records: {} },
    mx: { status: 'missing', records: [] },
    issues: [],
    recommendations: [],
  };
}

function reader(result: { status: 'found' | 'missing' | 'error'; value?: string[][] }): DnsReader {
  return {
    resolveTxt: vi.fn(async () => result),
    resolveMx: vi.fn(async () => ({ status: 'missing' as const })),
  };
}

describe('removal confirmation', () => {
  it('does not re-read anything when nothing was removed', async () => {
    const dns = reader({ status: 'missing' });
    const confirmation = await confirmDnsRemovals({
      domainName: 'example.test',
      previous: scan(),
      current: scan(),
      reader: dns,
      waitMs: 0,
    });

    expect(confirmation).toEqual({ confirmed: true, affected: [] });
    expect(dns.resolveTxt).not.toHaveBeenCalled();
  });

  it('confirms a DMARC removal when the name still answers missing', async () => {
    const dns = reader({ status: 'missing' });
    const previous = scan();
    const current = scan({ dmarcMissing: true });

    expect(diffScans(previous, current).map((draft) => draft.code)).toContain('dmarc_record_removed');

    const confirmation = await confirmDnsRemovals({
      domainName: 'example.test',
      previous,
      current,
      reader: dns,
      waitMs: 0,
    });

    expect(confirmation).toEqual({ confirmed: true, affected: ['_dmarc.example.test'] });
    expect(dns.resolveTxt).toHaveBeenCalledWith('_dmarc.example.test');
  });

  it('does not store a removal when the record reappears', async () => {
    const dns = reader({ status: 'found', value: [['v=DMARC1; p=none']] });
    const confirmation = await confirmDnsRemovals({
      domainName: 'example.test',
      previous: scan(),
      current: scan({ dmarcMissing: true }),
      reader: dns,
      waitMs: 0,
    });

    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.affected).toEqual(['_dmarc.example.test']);
  });

  it('does not store a removal when the second lookup errors', async () => {
    const confirmation = await confirmDnsRemovals({
      domainName: 'example.test',
      previous: scan(),
      current: scan({ dmarcMissing: true }),
      reader: reader({ status: 'error' }),
      waitMs: 0,
    });

    expect(confirmation.confirmed).toBe(false);
  });

  it('re-reads the apex for an SPF removal', async () => {
    const dns = reader({ status: 'missing' });
    const previous = scan();
    const current = scan({ spfMissing: true });

    const confirmation = await confirmDnsRemovals({
      domainName: 'example.test',
      previous,
      current,
      reader: dns,
      waitMs: 0,
    });

    expect(confirmation).toEqual({ confirmed: true, affected: ['example.test'] });
    expect(dns.resolveTxt).toHaveBeenCalledWith('example.test');
  });

  it('re-reads both names when DMARC and SPF were both removed', async () => {
    const dns = reader({ status: 'missing' });
    const confirmation = await confirmDnsRemovals({
      domainName: 'example.test',
      previous: scan(),
      current: scan({ dmarcMissing: true, spfMissing: true }),
      reader: dns,
      waitMs: 0,
    });

    expect(confirmation.confirmed).toBe(true);
    expect([...(dns.resolveTxt as ReturnType<typeof vi.fn>).mock.calls].map((call) => call[0]).sort()).toEqual([
      '_dmarc.example.test',
      'example.test',
    ]);
  });
});
