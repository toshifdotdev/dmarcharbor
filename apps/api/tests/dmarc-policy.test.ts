import { describe, expect, it } from 'vitest';
import { parseDmarcRecords, scanDomain } from '../src/scanner/scanner.js';
import type { DnsReader } from '../src/scanner/types.js';

const RUA = 'rua=mailto:reports@example.com';
const codes = (records: string[]) => (parseDmarcRecords(records.map((record) => [record])).notices ?? []).map((notice) => notice.code);

describe('which record is the policy (RFC 9989 4.10)', () => {
  it('ignores other TXT records at _dmarc instead of calling it a duplicate', () => {
    const result = parseDmarcRecords([['some-site-verification=abc'], [`v=DMARC1; p=reject; ${RUA}`]]);
    expect(result.status).toBe('found');
    expect(result.policy).toBe('reject');
  });

  it('discards every record when two DMARC records are published', () => {
    const result = parseDmarcRecords([[`v=DMARC1; p=reject; ${RUA}`], [`v=DMARC1; p=none; ${RUA}`]]);
    expect(result.status).toBe('error');
    expect(result.notices?.[0]?.code).toBe('dmarc_multiple_records');
  });

  it('treats a record whose version is not exactly v=DMARC1 as no policy', () => {
    for (const record of [`v=dmarc1; p=reject; ${RUA}`, `p=reject; v=DMARC1; ${RUA}`]) {
      const result = parseDmarcRecords([[record]]);
      expect(result.status, record).toBe('error');
      expect(result.notices?.[0]?.code, record).toBe('dmarc_version_invalid');
    }
  });
});

describe('policy tags (RFC 9989 4.7 and 4.10.1)', () => {
  it('reads a record with no p but a valid rua as p=none, and says so', () => {
    const result = parseDmarcRecords([[`v=DMARC1; ${RUA}`]]);
    expect(result.status).toBe('found');
    expect(result.policy).toBe('none');
    expect(result.notices?.[0]?.code).toBe('dmarc_policy_fallback');
  });

  it('reads an invalid sp or np as p=none when reports are requested', () => {
    expect(parseDmarcRecords([[`v=DMARC1; p=reject; np=block; ${RUA}`]]).policy).toBe('none');
    expect(parseDmarcRecords([[`v=DMARC1; p=reject; sp=strict; ${RUA}`]]).policy).toBe('none');
  });

  it('applies no DMARC to a record with no valid policy and no reports', () => {
    const result = parseDmarcRecords([['v=DMARC1; p=invalid']]);
    expect(result.status).toBe('error');
    expect(result.policy).toBe('unknown');
  });

  it('applies t=y one level softer', () => {
    const quarantine = parseDmarcRecords([[`v=DMARC1; p=quarantine; t=y; ${RUA}`]]);
    expect(quarantine.policy).toBe('quarantine');
    expect(quarantine.testing).toBe(true);
    expect(quarantine.effectivePolicy).toBe('none');

    expect(parseDmarcRecords([[`v=DMARC1; p=reject; t=y; ${RUA}`]]).effectivePolicy).toBe('quarantine');
    expect(parseDmarcRecords([[`v=DMARC1; p=reject; t=n; ${RUA}`]]).effectivePolicy).toBe('reject');
  });

  it('flags an invalid t value and t=y on p=none', () => {
    expect(codes([`v=DMARC1; p=reject; t=maybe; ${RUA}`])).toContain('dmarc_testing_invalid');
    expect(codes([`v=DMARC1; p=none; t=y; ${RUA}`])).toContain('dmarc_testing_without_policy');
  });
});

describe('retired tags (RFC 9989 9.3)', () => {
  it('warns that pct below 100 now means the whole policy at newer receivers', () => {
    const result = parseDmarcRecords([[`v=DMARC1; p=quarantine; pct=25; ${RUA}`]]);
    const notice = result.notices?.find((entry) => entry.code === 'dmarc_pct_historic');
    expect(notice?.severity).toBe('warning');
    expect(notice?.message).toContain('every failing message');
    expect(notice?.message).toContain('25%');
  });

  it('warns that pct=0 alone no longer means testing everywhere', () => {
    expect(codes([`v=DMARC1; p=reject; pct=0; ${RUA}`])).toContain('dmarc_pct_historic');
  });

  it('accepts pct=0 alongside t=y, the transition pair', () => {
    expect(codes([`v=DMARC1; p=reject; t=y; pct=0; ${RUA}`])).toEqual([]);
  });

  it('notes pct=100, rf and ri as removable', () => {
    expect(codes([`v=DMARC1; p=reject; pct=100; rf=afrf; ri=86400; ${RUA}`])).toEqual([
      'dmarc_historic_tag',
      'dmarc_historic_tag',
      'dmarc_historic_tag',
    ]);
  });
});

describe('psd (RFC 9989 5.2)', () => {
  it('warns about psd=y on an organisation domain and accepts psd=n', () => {
    expect(codes([`v=DMARC1; p=reject; psd=y; ${RUA}`])).toContain('dmarc_psd_yes');
    expect(codes([`v=DMARC1; p=reject; psd=n; ${RUA}`])).toEqual([]);
    expect(codes([`v=DMARC1; p=reject; psd=x; ${RUA}`])).toContain('dmarc_psd_invalid');
  });
});

describe('the scan and score use what receivers apply', () => {
  const reader = (dmarc: string): DnsReader => ({
    async resolveTxt(name) {
      if (name === '_dmarc.example.test') return { status: 'found', value: [[dmarc]] };
      if (name === 'example.test') return { status: 'found', value: [['v=spf1 ip4:192.0.2.1 -all']] };
      if (name === 'google._domainkey.example.test') return { status: 'found', value: [['v=DKIM1; p=MIGf']] };
      return { status: 'missing' };
    },
    async resolveMx() {
      return { status: 'found', value: [{ exchange: 'mx.example.test', priority: 10 }] };
    },
  });

  it('scores p=quarantine with t=y as monitoring, because receivers apply none', async () => {
    const result = await scanDomain('example.test', reader(`v=DMARC1; p=quarantine; t=y; ${RUA}`));
    expect(result.scoreBreakdown.factors.map((factor) => factor.code)).toContain('dmarc_monitor_only');
    expect(result.issues.find((issue) => issue.code === 'dmarc_monitor_only')?.title).toBe('DMARC is in testing mode');
  });

  it('scores p=reject with t=y as enforcing, because receivers apply quarantine', async () => {
    const result = await scanDomain('example.test', reader(`v=DMARC1; p=reject; t=y; ${RUA}`));
    expect(result.scoreBreakdown.factors.map((factor) => factor.code)).not.toContain('dmarc_monitor_only');
  });

  it('surfaces the pct warning as a scan finding', async () => {
    const result = await scanDomain('example.test', reader(`v=DMARC1; p=reject; pct=10; ${RUA}`));
    expect(result.issues.map((issue) => issue.code)).toContain('dmarc_pct_historic');
  });
});
