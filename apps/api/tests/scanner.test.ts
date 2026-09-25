import { describe, expect, it } from 'vitest';
import { parseDmarcRecords, parseSpfRecords, scanDomain } from '../src/scanner/scanner.js';
import type { DnsReader, MxRecord } from '../src/scanner/types.js';

function createReader(records: Record<string, string[][]>, mx: MxRecord[]): DnsReader {
  return {
    async resolveTxt(name: string) {
      return records[name] ? { status: 'found', value: records[name] } : { status: 'missing' };
    },
    async resolveMx() {
      return { status: 'found', value: mx };
    },
  };
}

describe('DMARC and SPF parsing', () => {
  it('parses a valid DMARC policy and reporting address', () => {
    const result = parseDmarcRecords([['v=DMARC1; p=reject; rua=mailto:reports@example.com']]);

    expect(result.status).toBe('found');
    expect(result.policy).toBe('reject');
    expect(result.hasAggregateReports).toBe(true);
  });

  it('marks an invalid DMARC record as an error', () => {
    const result = parseDmarcRecords([['v=DMARC1; p=invalid']]);

    expect(result.status).toBe('error');
    expect(result.policy).toBe('unknown');
  });

  it('counts SPF mechanisms that require DNS lookups', () => {
    const result = parseSpfRecords([['v=spf1 include:_spf.google.com include:_spf.resend.com a mx ~all']]);

    expect(result.status).toBe('found');
    expect(result.valid).toBe(true);
    expect(result.lookupCount).toBe(4);
  });
});

describe('scanDomain', () => {
  it('returns a useful preview without making a live DNS call', async () => {
    const reader = createReader(
      {
        '_dmarc.example.com': [['v=DMARC1; p=none; rua=mailto:reports@example.com']],
        'example.com': [['v=spf1 include:_spf.resend.com ~all']],
        '_domainkey.resend.example.com': [['v=DKIM1; k=rsa; p=public-key']],
      },
      [{ exchange: 'mx1.example.com', priority: 10 }],
    );

    const result = await scanDomain('Example.com', reader);

    expect(result.domain).toBe('example.com');
    expect(result.dmarc.policy).toBe('none');
    expect(result.spf.lookupCount).toBe(1);
    expect(result.dkim.selectors).toContain('resend');
    expect(result.status).toBe('needs_attention');
    expect(result.scoreBreakdown.base).toBe(100);
    expect(result.scoreBreakdown.final).toBe(result.score);
    expect(result.scoreBreakdown.factors.some((factor) => factor.code === 'dmarc_monitor_only')).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'dmarc_monitor_only')).toBe(true);
  });

  it('returns a perfect score when the checked records are healthy', async () => {
    const reader = createReader(
      {
        '_dmarc.example.com': [['v=DMARC1; p=reject; rua=mailto:reports@example.com']],
        'example.com': [['v=spf1 include:_spf.resend.com ~all']],
        '_domainkey.resend.example.com': [['v=DKIM1; k=rsa; p=public-key']],
      },
      [{ exchange: 'mx1.example.com', priority: 10 }],
    );

    const result = await scanDomain('example.com', reader);

    expect(result.status).toBe('healthy');
    expect(result.score).toBe(100);
    expect(result.scoreBreakdown.factors).toEqual([]);
  });
});
