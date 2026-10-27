import { describe, expect, it } from 'vitest';
import { parseSpfTerms, spfAllQualifier } from '../src/services/hosted-dns/spf/terms.js';
import { formatCidr, mergeNetworks, parseCidr } from '../src/services/hosted-dns/spf/networks.js';
import { flattenSources } from '../src/services/hosted-dns/spf/flatten.js';
import { buildSpfChain } from '../src/services/hosted-dns/spf/chain.js';
import { apexPointsAtUs, sourcesFromRecord } from '../src/services/hosted-dns/spf/apex.js';
import type { DnsReader, LookupResult, MxRecord } from '../src/scanner/types.js';

const token = 'abcdefghijklmnop';
const zone = 'spf.example.test';

class FakeReader implements DnsReader {
  txt = new Map<string, string[]>();
  txtErrors = new Set<string>();
  addresses = new Map<string, string[]>();
  addressErrors = new Set<string>();
  mx = new Map<string, MxRecord[]>();
  mxErrors = new Set<string>();

  async resolveTxt(name: string): Promise<LookupResult<string[][]>> {
    if (this.txtErrors.has(name)) return { status: 'error', error: 'resolver unavailable' };
    const record = this.txt.get(name);
    return record === undefined ? { status: 'missing' } : { status: 'found', value: record.map((value) => [value]) };
  }

  async resolveMx(name: string): Promise<LookupResult<MxRecord[]>> {
    if (this.mxErrors.has(name)) return { status: 'error', error: 'resolver unavailable' };
    const records = this.mx.get(name);
    return records === undefined ? { status: 'missing' } : { status: 'found', value: records };
  }

  async resolveAddress(name: string): Promise<LookupResult<string[]>> {
    if (this.addressErrors.has(name)) return { status: 'error', error: 'resolver unavailable' };
    const records = this.addresses.get(name);
    return records === undefined ? { status: 'missing' } : { status: 'found', value: records };
  }
}

describe('parseSpfTerms', () => {
  it('reads qualifiers, dual CIDR and modifiers, and refuses an unknown mechanism', () => {
    const terms = parseSpfTerms(
      'v=spf1 +include:_spf.google.com -ip4:203.0.113.0/24 ~a:mail.example/24//64 ?mx/24 redirect=x.example exp=y.example foo=bar',
    );
    expect(terms[0]).toMatchObject({
      kind: 'mechanism',
      qualifier: '+',
      name: 'include',
      value: '_spf.google.com',
    });
    expect(terms[1]).toMatchObject({ qualifier: '-', name: 'ip4', value: '203.0.113.0/24' });
    expect(terms[2]).toMatchObject({ qualifier: '~', name: 'a', value: 'mail.example/24//64' });
    expect(terms[3]).toMatchObject({ qualifier: '?', name: 'mx', value: '/24' });
    expect(terms[4]).toMatchObject({ kind: 'modifier', name: 'redirect', value: 'x.example' });
    expect(terms[5]).toMatchObject({ kind: 'modifier', name: 'exp', value: 'y.example' });
    expect(terms[6]).toMatchObject({ kind: 'modifier', name: 'foo', value: 'bar' });
    expect(() => parseSpfTerms('v=spf1 flavor:vanilla')).toThrow(/Unknown SPF mechanism/);
  });

  it('keeps a v6-only CIDR and reads the all qualifier', () => {
    const terms = parseSpfTerms('v=spf1 a//64 ~all');
    expect(terms[0]).toMatchObject({ name: 'a', value: '//64' });
    expect(spfAllQualifier('v=spf1 a//64 ~all')).toBe('~all');
    expect(spfAllQualifier('v=spf1 ip4:203.0.113.0/24')).toBe('?all');
  });
});

describe('network maths', () => {
  it('deduplicates, drops contained networks and keeps families apart', () => {
    expect(mergeNetworks(['203.0.113.0/24', '203.0.113.0/24'])).toEqual(['203.0.113.0/24']);
    expect(mergeNetworks(['203.0.113.0/24', '203.0.113.128/25', '198.51.100.0/24'])).toEqual([
      '203.0.113.0/24',
      '198.51.100.0/24',
    ]);
    expect(mergeNetworks(['203.0.113.0/24', '2001:db8::/32'])).toEqual([
      '203.0.113.0/24',
      '2001:db8::/32',
    ]);
  });

  it('formats /32 bare, compresses IPv6 and masks the network bits', () => {
    const v4 = parseCidr('203.0.113.5/32', 4)!;
    expect(formatCidr(v4)).toBe('203.0.113.5');
    const v6 = parseCidr('2001:0db8:0000:0000:0000:0000:0000:0000/32', 6)!;
    expect(formatCidr(v6)).toBe('2001:db8::/32');
    const host = parseCidr('2001:db8::1/128', 6)!;
    expect(formatCidr(host)).toBe('2001:db8::1');
    expect(formatCidr(parseCidr('203.0.113.255/24', 4)!)).toBe('203.0.113.0/24');
  });
});

describe('bare a and mx inside an included record', () => {
  it('resolve the include target, never the customer domain', async () => {
    const reader = new FakeReader();
    reader.txt.set('_spf.esp.example', ['v=spf1 a mx -all']);
    reader.addresses.set('_spf.esp.example', ['8.8.4.4']);
    reader.mx.set('_spf.esp.example', [{ exchange: 'mx.esp.example', priority: 10 }]);
    reader.addresses.set('mx.esp.example', ['8.8.8.8']);
    // The customer's own addresses must not leak into the provider's source.
    reader.addresses.set('customer.example', ['1.1.1.1']);
    reader.mx.set('customer.example', [{ exchange: 'mail.customer.example', priority: 10 }]);
    reader.addresses.set('mail.customer.example', ['1.0.0.1']);

    const [outcome] = await flattenSources([{ kind: 'include', value: '_spf.esp.example' }], reader, {
      customerDomain: 'customer.example',
      isUnusableNetwork: () => false,
    });

    expect(outcome).toMatchObject({ mode: 'flattened' });
    expect(outcome!.networks.sort()).toEqual(['8.8.4.4', '8.8.8.8']);
  });

  it('resolve the customer domain for a bare a or mx the person entered', async () => {
    const reader = new FakeReader();
    reader.addresses.set('customer.example', ['1.1.1.1']);

    const [outcome] = await flattenSources([{ kind: 'a', value: '' }], reader, {
      customerDomain: 'customer.example',
      isUnusableNetwork: () => false,
    });

    expect(outcome).toMatchObject({ mode: 'flattened', networks: ['1.1.1.1'] });
  });
});

describe('flattenSources', () => {
  it('flattens a nested include tree', async () => {
    const reader = new FakeReader();
    reader.txt.set('a.test', ['v=spf1 include:b.test ip4:203.0.113.4 -all']);
    reader.txt.set('b.test', ['v=spf1 ip4:198.51.100.0/24 -all']);
    const [outcome] = await flattenSources([{ kind: 'include', value: 'a.test' }], reader);
    expect(outcome!.mode).toBe('flattened');
    expect(outcome!.networks.sort()).toEqual(['198.51.100.0/24', '203.0.113.4'].sort());
    expect(outcome!.lookups).toBe(0);
  });

  it('resolves a and mx with a CIDR per family', async () => {
    const reader = new FakeReader();
    reader.addresses.set('mail.example.test', ['203.0.113.5', '2001:db8::5']);
    reader.addresses.set('mx1.example.test', ['198.51.100.9']);
    reader.mx.set('example.test', [{ exchange: 'mx1.example.test', priority: 10 }]);
    const outcomes = await flattenSources(
      [
        { kind: 'a', value: 'mail.example.test/24//64' },
        { kind: 'mx', value: 'example.test/24' },
      ],
      reader,
    );
    expect(outcomes[0]!.networks.sort()).toEqual(['2001:db8::/64', '203.0.113.0/24'].sort());
    expect(outcomes[1]!.networks).toEqual(['198.51.100.0/24']);
  });

  it('passes through a non-pass mechanism and counts its lookups', async () => {
    const reader = new FakeReader();
    reader.txt.set('strict.test', ['v=spf1 -ip4:1.2.3.4 ip4:1.2.3.0/24 -all']);
    const [outcome] = await flattenSources([{ kind: 'include', value: 'strict.test' }], reader);
    expect(outcome!.mode).toBe('passthrough');
    expect(outcome!.lookups).toBe(1);
    expect(outcome!.reason).toContain('-ip4');
  });

  it('passes through exists and macros', async () => {
    const reader = new FakeReader();
    reader.txt.set('exists.test', ['v=spf1 exists:%{i}.exists.test -all']);
    const [exists] = await flattenSources([{ kind: 'include', value: 'exists.test' }], reader);
    expect(exists!.mode).toBe('passthrough');
    expect(exists!.lookups).toBe(2);

    const [macro] = await flattenSources([{ kind: 'include', value: '%{d}.example.test' }], reader);
    expect(macro!.mode).toBe('passthrough');
    expect(macro!.reason).toContain('macro');
  });

  it('refuses +all and an overly broad ip4', async () => {
    const reader = new FakeReader();
    reader.txt.set('wide.test', ['v=spf1 +all']);
    const [wide] = await flattenSources([{ kind: 'include', value: 'wide.test' }], reader);
    expect(wide!.mode).toBe('refused');
    expect(wide!.reason).toBe('This source authorises most of the internet.');

    const [broad] = await flattenSources([{ kind: 'ip4', value: '0.0.0.0/1' }], reader);
    expect(broad!.mode).toBe('refused');
    expect(broad!.reason).toBe('This source authorises most of the internet.');
  });

  it('refuses private user addresses unless the test seam allows them', async () => {
    const reader = new FakeReader();
    const [outcome] = await flattenSources([{ kind: 'ip4', value: '10.0.0.0/24' }], reader);
    expect(outcome!.mode).toBe('refused');
    expect(outcome!.reason).toContain('Private addresses');
    const [allowed] = await flattenSources([{ kind: 'ip4', value: '203.0.113.5' }], reader, {
      isUnusableNetwork: () => false,
    });
    expect(allowed!.mode).toBe('flattened');
    expect(allowed!.networks).toEqual(['203.0.113.5']);
  });

  it('reports loops and too-deep chains as errors', async () => {
    const reader = new FakeReader();
    reader.txt.set('a.test', ['v=spf1 include:b.test -all']);
    reader.txt.set('b.test', ['v=spf1 include:a.test -all']);
    const [loop] = await flattenSources([{ kind: 'include', value: 'a.test' }], reader);
    expect(loop!.mode).toBe('error');
    expect(loop!.reason).toContain('leads back to itself');

    for (let index = 0; index < 12; index += 1) {
      reader.txt.set(`d${index}.test`, [`v=spf1 include:d${index + 1}.test -all`]);
    }
    reader.txt.set('d12.test', ['v=spf1 ip4:203.0.113.1 -all']);
    const [deep] = await flattenSources([{ kind: 'include', value: 'd0.test' }], reader);
    expect(deep!.mode).toBe('error');
    expect(deep!.reason).toContain('deeper than 10');
  });

  it('reports a DNS error and a missing target as errors', async () => {
    const reader = new FakeReader();
    reader.txtErrors.add('broken.test');
    const [broken] = await flattenSources([{ kind: 'include', value: 'broken.test' }], reader);
    expect(broken!.mode).toBe('error');
    expect(broken!.reason).toContain('could not be read');

    const [missing] = await flattenSources([{ kind: 'include', value: 'missing.test' }], reader);
    expect(missing!.mode).toBe('error');
    expect(missing!.reason).toContain('does not exist');
  });

  it('honours the query budget', async () => {
    const reader = new FakeReader();
    reader.txt.set('a.test', ['v=spf1 include:b.test -all']);
    reader.txt.set('b.test', ['v=spf1 ip4:203.0.113.1 -all']);
    const [outcome] = await flattenSources([{ kind: 'include', value: 'a.test' }], reader, {
      maxQueries: 1,
    });
    expect(outcome!.mode).toBe('error');
    expect(outcome!.reason).toBe('Not finished within the lookup budget.');
  });
});

describe('buildSpfChain', () => {
  it('builds one part and ends it with the qualifier', () => {
    const result = buildSpfChain({
      token,
      zone,
      allQualifier: '-all',
      networks: ['203.0.113.0/24'],
      passthrough: [],
    });
    expect('parts' in result).toBe(true);
    if (!('parts' in result)) return;
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]!.name).toBe(`${token}.spf.${zone}`);
    expect(result.parts[0]!.content).toBe('v=spf1 203.0.113.0/24 -all');
    expect(result.lookupCount).toBe(1);
  });

  it('splits into continuations no longer than 450 characters without an all', () => {
    const networks = Array.from({ length: 40 }, (_, index) => `203.0.${index}.0/24`);
    const result = buildSpfChain({
      token,
      zone,
      allQualifier: '~all',
      networks,
      passthrough: [],
    });
    expect('parts' in result).toBe(true);
    if (!('parts' in result)) return;
    expect(result.parts.length).toBeGreaterThan(1);
    expect(result.lookupCount).toBe(1 + (result.parts.length - 1));
    for (const part of result.parts) {
      expect(part.content.length).toBeLessThanOrEqual(450);
    }
    expect(result.parts[0]!.content.endsWith('~all')).toBe(true);
    for (const part of result.parts.slice(1)) {
      expect(part.content).not.toMatch(/\ball\b/);
    }
  });

  it('counts passthrough lookups and refuses too many', () => {
    const result = buildSpfChain({
      token,
      zone,
      allQualifier: '-all',
      networks: [],
      passthrough: Array.from({ length: 10 }, (_, index) => `include:p${index}.test`),
    });
    expect(result).toMatchObject({ error: 'TOO_MANY_LOOKUPS', lookupCount: 11 });
  });

  it('refuses a record that needs more than nine parts', () => {
    const networks = [
      ...Array.from({ length: 256 }, (_, index) => `172.16.${index}.0/24`),
      ...Array.from({ length: 44 }, (_, index) => `10.0.${index}.0/24`),
    ];
    const result = buildSpfChain({
      token,
      zone,
      allQualifier: '-all',
      networks,
      passthrough: [],
    });
    expect(result).toMatchObject({ error: 'TOO_MANY_PARTS' });
  });
});

describe('the apex record', () => {
  it('recognises only exactly one redirect to our entry', () => {
    expect(apexPointsAtUs([`v=spf1 redirect=${token}.spf.${zone}`], token, zone)).toBe(true);
    expect(apexPointsAtUs([`v=spf1 -all redirect=${token.toUpperCase()}.spf.${zone}.`], token, zone)).toBe(true);
    expect(apexPointsAtUs([`v=spf1 include:x.test redirect=${token}.spf.${zone}`], token, zone)).toBe(false);
    expect(
      apexPointsAtUs([`v=spf1 redirect=${token}.spf.${zone}`, 'v=spf1 -all'], token, zone),
    ).toBe(false);
    expect(apexPointsAtUs([`v=spf1 redirect=${token}.spf.other.test`], token, zone)).toBe(false);
  });

  it('imports the record conservatively', () => {
    const imported = sourcesFromRecord(
      'v=spf1 include:_spf.google.com ip4:203.0.113.5 a mx ptr ?all',
      'example.test',
    );
    expect(imported.error).toBeNull();
    expect(imported.sources).toEqual([
      { kind: 'include', value: '_spf.google.com' },
      { kind: 'ip4', value: '203.0.113.5' },
      { kind: 'a', value: 'example.test' },
      { kind: 'mx', value: 'example.test' },
    ]);
    expect(imported.notes).toContain('ptr is deprecated; it was not carried over');
    expect(imported.allQualifier).toBe('~all');

    const refused = sourcesFromRecord('v=spf1 exists:foo.test -all', 'example.test');
    expect(refused.error).toContain('exists');

    const redirectWithAll = sourcesFromRecord('v=spf1 redirect=x.test -all', 'example.test');
    expect(redirectWithAll.sources).toEqual([]);
    expect(redirectWithAll.notes.join(' ')).toContain('redirect is ignored');

    const redirectOnly = sourcesFromRecord('v=spf1 redirect=x.test', 'example.test');
    expect(redirectOnly.sources).toEqual([{ kind: 'include', value: 'x.test' }]);
    expect(redirectOnly.allQualifier).toBe('~all');
    expect(redirectOnly.notes.join(' ')).toContain('no all qualifier');

    expect(sourcesFromRecord('v=spf1 ip4:203.0.113.1 -all', 'example.test').allQualifier).toBe('-all');
  });
});
