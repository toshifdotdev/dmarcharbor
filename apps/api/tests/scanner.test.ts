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

describe('DKIM discovery through the scanner', () => {
  const KEY = 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQ==';

  it('finds a selector the SPF record named, even one no convention list would have guessed', async () => {
    // The whole point. A customer on Salesforce publishes sfi, sfs1 and sfs2.
    // The old fixed list contained none of them, so this reported "no DKIM" on a
    // domain with three working keys.
    const reader = createReader(
      {
        '_dmarc.mail.test': [['v=DMARC1; p=none']],
        'mail.test': [['v=spf1 include:_spf.salesforce.com ~all']],
        '_domainkey.sfs1.mail.test': [[KEY]],
        '_domainkey.sfs2.mail.test': [[KEY]],
      },
      [{ exchange: 'mx1.mail.test', priority: 10 }],
    );

    const result = await scanDomain('mail.test', reader);

    expect(result.dkim.status).toBe('found');
    expect(result.dkim.selectors.sort()).toEqual(['sfs1', 'sfs2']);
    expect(result.dkim.records.sfs1).toBe(KEY);
    expect(result.dkim.discoveredVia?.sfs1).toBe('spf:_spf.salesforce.com');
  });

  it('attributes a conventionally found selector to the convention', async () => {
    const reader = createReader(
      {
        '_dmarc.mail.test': [['v=DMARC1; p=none']],
        'mail.test': [['v=spf1 ip4:1.2.3.4 ~all']],
        '_domainkey.google.mail.test': [[KEY]],
      },
      [{ exchange: 'mx1.mail.test', priority: 10 }],
    );

    const result = await scanDomain('mail.test', reader);

    expect(result.dkim.status).toBe('found');
    expect(result.dkim.discoveredVia?.google).toBe('convention');
  });

  it('reports honestly when a custom selector is not named anywhere we can see', async () => {
    // mail2026 was never guessable and is not in the SPF record. Reporting
    // "missing" is the truthful answer, and the message has to say so rather
    // than implying we checked everything.
    const reader = createReader(
      {
        '_dmarc.mail.test': [['v=DMARC1; p=none']],
        'mail.test': [['v=spf1 ip4:1.2.3.4 ~all']],
        '_domainkey.mail2026.mail.test': [[KEY]],
      },
      [{ exchange: 'mx1.mail.test', priority: 10 }],
    );

    const result = await scanDomain('mail.test', reader);

    // Still missed, and that is the known limit of DNS-only discovery. The point
    // is that we say we checked a bounded set rather than claiming certainty.
    expect(result.dkim.status).toBe('missing');
    expect(result.dkim.checkedSelectors.length).toBeGreaterThan(0);
    const issue = result.issues.find((entry) => entry.code === 'dkim_missing');
    expect(issue?.message).toContain('selectors checked');
  });

  it('does not claim an error when the lookups simply found nothing', async () => {
    const reader = createReader(
      {
        '_dmarc.mail.test': [['v=DMARC1; p=none']],
        'mail.test': [['v=spf1 ip4:1.2.3.4 ~all']],
      },
      [{ exchange: 'mx1.mail.test', priority: 10 }],
    );

    const result = await scanDomain('mail.test', reader);

    // A scan that ran and found nothing is a more useful answer than one that
    // could not run, and they are different states.
    expect(result.dkim.status).toBe('missing');
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
