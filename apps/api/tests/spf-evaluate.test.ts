import { describe, expect, it } from 'vitest';
import { evaluateSpfLookups } from '../src/scanner/spf-evaluate.js';
import { scanDomain } from '../src/scanner/scanner.js';
import type { DnsReader, LookupResult, MxRecord } from '../src/scanner/types.js';

interface Zone {
  txt?: Record<string, string[] | 'error'>;
  mx?: Record<string, MxRecord[]>;
  address?: Record<string, string[]>;
}

/** A fake DNS. A name absent from the zone does not exist. */
function reader(zone: Zone, log: string[] = []): DnsReader {
  return {
    async resolveTxt(name): Promise<LookupResult<string[][]>> {
      log.push(`TXT ${name}`);
      const value = zone.txt?.[name];
      if (value === 'error') return { status: 'error', error: 'SERVFAIL' };
      return value ? { status: 'found', value: value.map((record) => [record]) } : { status: 'missing' };
    },
    async resolveMx(name) {
      log.push(`MX ${name}`);
      const value = zone.mx?.[name];
      return value ? { status: 'found', value } : { status: 'missing' };
    },
    async resolveAddress(name) {
      log.push(`A ${name}`);
      const value = zone.address?.[name];
      return value ? { status: 'found', value } : { status: 'missing' };
    },
  };
}

// Shaped like a large provider's SPF: one include that fans out to netblocks.
const provider = {
  '_spf.provider.test': ['v=spf1 include:_netblocks.provider.test include:_netblocks2.provider.test include:_netblocks3.provider.test ~all'],
  '_netblocks.provider.test': ['v=spf1 ip4:192.0.2.0/24 ~all'],
  '_netblocks2.provider.test': ['v=spf1 ip6:2001:db8::/32 ~all'],
  '_netblocks3.provider.test': ['v=spf1 ip4:198.51.100.0/24 ~all'],
};

describe('SPF lookup counting through includes (RFC 7208 4.6.4)', () => {
  it('counts what an include pulls in, not just the include itself', async () => {
    const result = await evaluateSpfLookups('example.test', 'v=spf1 include:_spf.provider.test -all', reader({ txt: provider }));

    // 1 for the include, 3 for the includes inside it.
    expect(result.lookupCount).toBe(4);
    expect(result.lookupLimitExceeded).toBe(false);
    expect(result.tree[0]!.lookups).toBe(4);
    expect(result.tree[0]!.children).toHaveLength(3);
    expect(result.complete).toBe(true);
  });

  it('finds a record over the limit that a top-level count reads as fine', async () => {
    const txt: Record<string, string[]> = { ...provider };
    for (const name of ['a', 'b', 'c']) {
      txt[`_spf.${name}.test`] = [`v=spf1 include:_spf.provider.test ~all`];
    }
    const record = 'v=spf1 include:_spf.a.test include:_spf.b.test include:_spf.c.test -all';

    const result = await evaluateSpfLookups('example.test', record, reader({ txt }));

    // Three top-level includes, each costing 1 + 4.
    expect(result.lookupCount).toBe(15);
    expect(result.lookupLimitExceeded).toBe(true);
  });

  it('counts a, mx, ptr, exists and redirect, and nothing for ip4, ip6 or all', async () => {
    const zone: Zone = {
      txt: { 'other.test': ['v=spf1 ip4:203.0.113.0/24 -all'] },
      mx: { 'example.test': [{ exchange: 'mx.example.test', priority: 10 }] },
      address: { 'example.test': ['192.0.2.1'], 'host.test': ['192.0.2.2'] },
    };
    const result = await evaluateSpfLookups(
      'example.test',
      'v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 a a:host.test mx ptr exists:%{i}.rbl.test redirect=other.test',
      reader(zone),
    );

    expect(result.lookupCount).toBe(6);
    expect(result.problems.join(' ')).toContain('ptr');
  });

  it('ignores redirect when the record also has "all" (RFC 7208 6.1)', async () => {
    const result = await evaluateSpfLookups('example.test', 'v=spf1 ip4:192.0.2.1 redirect=other.test -all', reader({}));
    expect(result.lookupCount).toBe(0);
    // ip4 and all cost nothing and are not listed; the redirect is.
    expect(result.tree[0]!.term).toBe('redirect=other.test');
    expect(result.tree[0]!.note).toContain('Ignored');
  });

  it('counts a void lookup for an include of a name that does not exist, and calls it a permanent error', async () => {
    const result = await evaluateSpfLookups('example.test', 'v=spf1 include:gone.test -all', reader({}));
    expect(result.voidLookupCount).toBe(1);
    expect(result.problems.join(' ')).toContain('gone.test does not exist');
  });

  it('flags more than two void lookups', async () => {
    const result = await evaluateSpfLookups(
      'example.test',
      'v=spf1 a:gone1.test a:gone2.test mx:gone3.test -all',
      reader({}),
    );
    expect(result.voidLookupCount).toBe(3);
    expect(result.voidLookupLimitExceeded).toBe(true);
  });

  it('calls an include with no SPF record, or two, a permanent error', async () => {
    const result = await evaluateSpfLookups(
      'example.test',
      'v=spf1 include:nospf.test include:twice.test -all',
      reader({ txt: { 'nospf.test': ['google-site-verification=abc'], 'twice.test': ['v=spf1 -all', 'v=spf1 ~all'] } }),
    );
    expect(result.problems.join(' ')).toContain('nospf.test publishes no SPF record');
    expect(result.problems.join(' ')).toContain('twice.test publishes 2 SPF records');
  });

  it('stops at a loop instead of following it forever', async () => {
    const result = await evaluateSpfLookups(
      'loop.test',
      'v=spf1 include:b.loop.test -all',
      reader({ txt: { 'b.loop.test': ['v=spf1 include:loop.test -all'] } }),
    );
    expect(result.problems.join(' ')).toContain('leads back to itself');
    expect(result.complete).toBe(true);
  });

  it('does not try to expand a macro, and says why', async () => {
    const result = await evaluateSpfLookups('example.test', 'v=spf1 include:%{ir}.%{v}._spf.mta.test -all', reader({}));
    expect(result.lookupCount).toBe(1);
    expect(result.tree[0]!.note).toContain('macro');
  });

  it('flags an mx term whose name has more than 10 MX records', async () => {
    const many = Array.from({ length: 11 }, (_, index) => ({ exchange: `mx${index}.example.test`, priority: index }));
    const result = await evaluateSpfLookups('example.test', 'v=spf1 mx -all', reader({ mx: { 'example.test': many } }));
    expect(result.problems.join(' ')).toContain('11 MX records');
  });

  it('stays within its query budget on a hostile record and says the count is a minimum', async () => {
    const txt: Record<string, string[]> = {};
    for (let index = 0; index < 60; index++) {
      txt[`n${index}.test`] = [`v=spf1 include:n${index + 1}.test -all`];
    }
    const log: string[] = [];
    const result = await evaluateSpfLookups('example.test', 'v=spf1 include:n0.test -all', reader({ txt }, log), {
      maxQueries: 15,
      maxDepth: 50,
    });
    expect(log.length).toBeLessThanOrEqual(15);
    expect(result.complete).toBe(false);
    expect(result.lookupLimitExceeded).toBe(true);
  });

  it('treats a DNS error inside an include as an incomplete count, not as a broken record', async () => {
    const result = await evaluateSpfLookups('example.test', 'v=spf1 include:flaky.test -all', reader({ txt: { 'flaky.test': 'error' } }));
    expect(result.complete).toBe(false);
    expect(result.problems).toEqual([]);
  });
});

describe('the scanner reports the counted total', () => {
  const zone = (spf: string): Zone => ({
    txt: {
      '_dmarc.example.test': ['v=DMARC1; p=none; rua=mailto:r@example.test'],
      'example.test': [spf],
      ...provider,
      '_spf.a.test': ['v=spf1 include:_spf.provider.test ~all'],
      '_spf.b.test': ['v=spf1 include:_spf.provider.test ~all'],
      '_spf.c.test': ['v=spf1 include:_spf.provider.test ~all'],
      'google._domainkey.example.test': ['v=DKIM1; k=rsa; p=MIGf'],
    },
    mx: { 'example.test': [{ exchange: 'mx.example.test', priority: 10 }] },
  });

  it('fails SPF and the score when the counted total is over 10', async () => {
    const result = await scanDomain(
      'example.test',
      reader(zone('v=spf1 include:_spf.a.test include:_spf.b.test include:_spf.c.test -all')),
    );
    expect(result.spf.lookupCount).toBe(15);
    expect(result.spf.lookupLimitExceeded).toBe(true);
    const issue = result.issues.find((entry) => entry.code === 'spf_lookup_limit');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('15 DNS lookups');
    expect(result.scoreBreakdown.factors.find((factor) => factor.code === 'spf_lookup_limit')?.points).toBe(-20);
  });

  it('warns at the edge of the limit, before one more service breaks it', async () => {
    // 5 (include a, which pulls in the provider) + 4 (the provider) + 1 (a) = 10.
    const result = await scanDomain('example.test', reader(zone('v=spf1 include:_spf.a.test include:_spf.provider.test a -all')));
    expect(result.spf.lookupCount).toBe(10);
    expect(result.spf.lookupLimitExceeded).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain('spf_lookup_near_limit');
    expect(result.issues.map((entry) => entry.code)).not.toContain('spf_lookup_limit');
  });
});
