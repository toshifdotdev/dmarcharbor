import { describe, expect, it } from 'vitest';
import { parseDmarcRecords, parseSpfRecords, scanDomain } from '../src/scanner/scanner.js';
import type { DnsReader, MxRecord } from '../src/scanner/types.js';
import type { HttpsGetResult, HttpsGetter } from '../src/scanner/https-get.js';

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
        'sfs1._domainkey.mail.test': [[KEY]],
        'sfs2._domainkey.mail.test': [[KEY]],
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
        'google._domainkey.mail.test': [[KEY]],
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
        'mail2026._domainkey.mail.test': [[KEY]],
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

describe('DKIM lookup name (RFC 6376 3.6.2.1)', () => {
  const KEY = 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQ==';
  const base = {
    '_dmarc.mail.test': [['v=DMARC1; p=none']],
    'mail.test': [['v=spf1 ip4:1.2.3.4 ~all']],
  };

  it('queries <selector>._domainkey.<domain>', async () => {
    const queried: string[] = [];
    const reader = createReader({ ...base, 'google._domainkey.mail.test': [[KEY]] }, []);
    const spy: DnsReader = {
      ...reader,
      async resolveTxt(name) {
        queried.push(name);
        return reader.resolveTxt(name);
      },
    };

    const result = await scanDomain('mail.test', spy);

    expect(result.dkim.selectors).toContain('google');
    expect(queried).toContain('google._domainkey.mail.test');
    expect(queried.some((name) => name.startsWith('_domainkey.'))).toBe(false);
  });

  it('does not find a key published only at the reversed name the scanner used to query', async () => {
    const result = await scanDomain('mail.test', createReader({ ...base, '_domainkey.google.mail.test': [[KEY]] }, []));
    expect(result.dkim.status).toBe('missing');
  });

  it('does not count a revoked key (empty p=) as DKIM', async () => {
    const result = await scanDomain('mail.test', createReader({ ...base, 'google._domainkey.mail.test': [['v=DKIM1; p=']] }, []));
    expect(result.dkim.status).toBe('missing');
    expect(result.dkim.revokedSelectors).toEqual(['google']);
  });

  it('ignores a TXT record at a selector name that is not a key', async () => {
    const result = await scanDomain(
      'mail.test',
      createReader({ ...base, 'google._domainkey.mail.test': [['some-verification=abc']] }, []),
    );
    expect(result.dkim.status).toBe('missing');
  });
});

describe('scanDomain', () => {
  it('returns a useful preview without making a live DNS call', async () => {
    const reader = createReader(
      {
        '_dmarc.example.com': [['v=DMARC1; p=none; rua=mailto:reports@example.com']],
        'example.com': [['v=spf1 include:_spf.resend.com ~all']],
        'resend._domainkey.example.com': [['v=DKIM1; k=rsa; p=public-key']],
        '_spf.resend.com': [['v=spf1 ip4:192.0.2.0/24 ~all']],
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
        'resend._domainkey.example.com': [['v=DKIM1; k=rsa; p=public-key']],
        '_spf.resend.com': [['v=spf1 ip4:192.0.2.0/24 ~all']],
      },
      [{ exchange: 'mx1.example.com', priority: 10 }],
    );

    const result = await scanDomain('example.com', reader);

    expect(result.status).toBe('healthy');
    expect(result.score).toBe(100);
    expect(result.scoreBreakdown.factors).toEqual([]);
  });
});

describe('MTA-STS, TLS-RPT and BIMI in the scan', () => {
  const KEY = 'v=DKIM1; k=rsa; p=public-key';
  const baseRecords: Record<string, string[][]> = {
    '_dmarc.mail.test': [['v=DMARC1; p=reject; rua=mailto:reports@example.test']],
    'mail.test': [['v=spf1 ip4:1.2.3.4 -all']],
    'google._domainkey.mail.test': [[KEY]],
  };
  const mx = [{ exchange: 'mx1.mail.test', priority: 10 }];

  function fakeGetter(responses: Record<string, HttpsGetResult> = {}) {
    const calls: string[] = [];
    const getter: HttpsGetter = {
      async get(url) {
        calls.push(url);
        return (
          responses[url] ?? {
            status: 'error',
            failure: 'network',
            detail: 'Unexpected fetch in this test.',
          }
        );
      },
    };
    return { getter, calls };
  }

  function ok(contentType: string, body: string): HttpsGetResult {
    return { status: 'ok', statusCode: 200, contentType, body: Buffer.from(body) };
  }

  it('leaves status, score and issues unchanged when none of the three is published', async () => {
    const { getter, calls } = fakeGetter();
    const result = await scanDomain('mail.test', createReader(baseRecords, mx), { https: getter });

    expect(result.status).toBe('healthy');
    expect(result.score).toBe(100);
    expect(result.issues).toEqual([]);
    expect(result.mtaSts?.status).toBe('missing');
    expect(result.tlsRpt?.status).toBe('missing');
    expect(result.bimi?.status).toBe('missing');
    expect(calls).toEqual([]);
  });

  it('reports an uncovered MX host as an error in enforce mode and a warning in testing', async () => {
    const records = {
      ...baseRecords,
      '_mta-sts.mail.test': [['v=STSv1; id=abc123']],
    };
    const url = 'https://mta-sts.mail.test/.well-known/mta-sts.txt';
    const enforce = fakeGetter({
      [url]: ok('text/plain', 'version: STSv1\nmode: enforce\nmx: mx2.mail.test\nmax_age: 604800\n'),
    });
    const enforceResult = await scanDomain('mail.test', createReader(records, mx), { https: enforce.getter });
    const enforceIssue = enforceResult.issues.find((issue) => issue.code === 'mta_sts_mx_not_covered');
    expect(enforceIssue?.severity).toBe('error');
    expect(enforceIssue?.message).toContain('mx1.mail.test');
    expect(enforceIssue?.message).toContain('refuse to deliver');

    const testing = fakeGetter({
      [url]: ok('text/plain', 'version: STSv1\nmode: testing\nmx: mx2.mail.test\nmax_age: 604800\n'),
    });
    const testingResult = await scanDomain('mail.test', createReader(records, mx), { https: testing.getter });
    expect(testingResult.issues.find((issue) => issue.code === 'mta_sts_mx_not_covered')?.severity).toBe('warning');
  });

  it('reports a policy fetch TLS failure as unavailable with the detail', async () => {
    const records = {
      ...baseRecords,
      '_mta-sts.mail.test': [['v=STSv1; id=abc123']],
    };
    const url = 'https://mta-sts.mail.test/.well-known/mta-sts.txt';
    const { getter } = fakeGetter({
      [url]: {
        status: 'error',
        failure: 'tls',
        detail: 'The certificate is not valid for mta-sts.mail.test.',
      },
    });

    const result = await scanDomain('mail.test', createReader(records, mx), { https: getter });
    expect(result.mtaSts?.policy?.status).toBe('unavailable');
    const issue = result.issues.find((entry) => entry.code === 'mta_sts_policy_unavailable');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('certificate');
    expect(issue?.message).toContain('deliver as if there were none');
  });

  it('reports BIMI without enforced DMARC and leaves a declined record alone', async () => {
    const pNone = {
      ...baseRecords,
      '_dmarc.mail.test': [['v=DMARC1; p=none; rua=mailto:reports@example.test']],
      'default._bimi.mail.test': [['v=BIMI1; l=https://example.test/logo.svg']],
    };
    const logoUrl = 'https://example.test/logo.svg';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps"><title>Logo</title></svg>';
    const enabled = fakeGetter({ [logoUrl]: ok('image/svg+xml', svg) });
    const result = await scanDomain('mail.test', createReader(pNone, mx), { https: enabled.getter });
    expect(result.issues.find((issue) => issue.code === 'bimi_dmarc_not_enforced')?.severity).toBe('warning');
    expect(result.bimi?.logo?.status).toBe('fetched');

    const declined = {
      ...baseRecords,
      'default._bimi.mail.test': [['v=BIMI1; l=']],
    };
    const never = fakeGetter();
    const declinedResult = await scanDomain('mail.test', createReader(declined, mx), { https: never.getter });
    expect(declinedResult.bimi?.declined).toBe(true);
    expect(declinedResult.issues.some((issue) => issue.code.startsWith('bimi_'))).toBe(false);
    expect(never.calls).toEqual([]);
  });

  it('does not warn a subdomain that inherits both BIMI and DMARC from its parent', async () => {
    const records = {
      '_dmarc.mail.test': [['v=DMARC1; p=reject; rua=mailto:reports@example.test']],
      'default._bimi.mail.test': [['v=BIMI1; l=https://example.test/logo.svg']],
    };
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps"><title>Logo</title></svg>';
    const { getter } = fakeGetter({ 'https://example.test/logo.svg': ok('image/svg+xml', svg) });
    const result = await scanDomain('news.mail.test', createReader(records, mx), { https: getter });

    expect(result.bimi?.inheritedFrom).toBe('mail.test');
    expect(result.bimi?.dmarc.dependsOnParent).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'bimi_dmarc_not_enforced')).toBe(false);
  });

  it('places new issues after every existing finding', async () => {
    const records = {
      ...baseRecords,
      '_dmarc.mail.test': [['v=DMARC1; p=none']],
      '_mta-sts.mail.test': [['v=STSv1;']],
    };
    const { getter } = fakeGetter();
    const result = await scanDomain('mail.test', createReader(records, mx), { https: getter });

    const existingIndex = result.issues.findIndex((issue) => issue.code === 'dmarc_monitor_only');
    const transportIndex = result.issues.findIndex((issue) => issue.code === 'mta_sts_record_invalid');
    expect(existingIndex).toBeGreaterThanOrEqual(0);
    expect(transportIndex).toBeGreaterThan(existingIndex);
    expect(result.issues.at(-1)?.code).toBe('mta_sts_record_invalid');
  });
});
