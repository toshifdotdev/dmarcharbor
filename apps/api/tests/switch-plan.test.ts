import { describe, expect, it } from 'vitest';
import type { DnsReader, LookupResult } from '../src/models/scan.model.js';
import { planDomainSwitch } from '../src/services/switch-kit/plan.js';
import { env } from '../src/config/env.js';

const DOMAIN = 'client.example.test';
const OUR = 'dmarc-reports+abcdef012345@reports.dmarcharbor.com';
const DMARC_HOST = `_dmarc.${DOMAIN}`;
const AUTH_HOST = `${DOMAIN}._report._dmarc.reports.dmarcharbor.com`;

function txt(...records: string[]): LookupResult<string[][]> {
  return { status: 'found', value: records.map((record) => [record]) };
}

function reader(input: {
  dmarc?: LookupResult<string[][]>;
  cname?: LookupResult<string[]>;
  authorization?: LookupResult<string[][]>;
}): DnsReader {
  return {
    async resolveTxt(name) {
      if (name === DMARC_HOST) {
        return input.dmarc ?? { status: 'missing' };
      }
      if (name === AUTH_HOST) {
        return input.authorization ?? { status: 'missing' };
      }
      return { status: 'missing' };
    },
    async resolveMx() {
      return { status: 'missing' };
    },
    async resolveCname(name) {
      if (name === DMARC_HOST) {
        return input.cname ?? { status: 'missing' };
      }
      return { status: 'missing' };
    },
  };
}

function plan(input: Parameters<typeof reader>[0]) {
  return planDomainSwitch({ domainName: DOMAIN, ourAddress: OUR, dns: reader(input) });
}

describe('planning a switch from what DNS shows', () => {
  it('generates a monitoring record when no record exists', async () => {
    const result = await plan({});

    expect(result.lookup).toBe('no_record');
    expect(result.currentRecord).toBeNull();
    expect(result.record).toEqual({
      host: DMARC_HOST,
      type: 'TXT',
      value: `v=DMARC1; p=none; rua=mailto:${OUR}`,
    });
    expect(result.incumbents).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toContain('authorization_missing');
  });

  it('refuses to choose between multiple DMARC records', async () => {
    const result = await plan({
      dmarc: txt('v=DMARC1; p=none', 'v=DMARC1; p=reject'),
    });

    expect(result.lookup).toBe('multiple_records');
    expect(result.record).toBeNull();
    expect(result.message).toContain('More than one');
  });

  it('reports a TXT record that is not DMARC as invalid', async () => {
    const result = await plan({ dmarc: txt('v=spf1 -all') });

    expect(result.lookup).toBe('invalid');
    expect(result.record).toBeNull();
  });

  it('plans from the one DMARC record when other TXT strings share the name', async () => {
    const result = await plan({
      dmarc: txt('google-site-verification=abc', 'v=DMARC1; p=reject; rua=mailto:agg@ag.dmarcian.com'),
    });

    expect(result.lookup).toBe('found');
    expect(result.currentRecord).toBe('v=DMARC1; p=reject; rua=mailto:agg@ag.dmarcian.com');
    expect(result.record?.value).toBe(`v=DMARC1; p=reject; rua=mailto:${OUR},mailto:agg@ag.dmarcian.com`);
    expect(result.primaryIncumbent?.vendor).toBe('dmarcian');
  });

  it('surfaces a CNAME and warns that it cannot coexist with the TXT record', async () => {
    const result = await plan({
      dmarc: txt('v=DMARC1; p=none; rua=mailto:agg@dmarcian.com'),
      cname: { status: 'found', value: ['dmarc.dmarcian.com'] },
    });

    expect(result.lookup).toBe('found');
    expect(result.cname).toBe('dmarc.dmarcian.com');
    const warning = result.warnings.find((entry) => entry.code === 'cname');
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('dmarc.dmarcian.com');
    expect(warning!.message).toContain('cannot coexist');
  });

  it('does not warn about a CNAME that points at our own hosted record', async () => {
    const previous = env.HOSTED_DNS_ZONE;
    env.HOSTED_DNS_ZONE = 'hosted.example.test';
    try {
      const result = await plan({
        dmarc: txt('v=DMARC1; p=none; rua=mailto:agg@dmarcian.com'),
        cname: { status: 'found', value: ['abcdefghijklmnop.hosted.example.test'] },
      });
      expect(result.hostedByUs).toBe(true);
      expect(result.cname).toBe('abcdefghijklmnop.hosted.example.test');
      expect(result.warnings.some((entry) => entry.code === 'cname')).toBe(false);
    } finally {
      env.HOSTED_DNS_ZONE = previous;
    }
  });

  it('reports a failed lookup with a short message, never the raw error', async () => {
    const result = await plan({ dmarc: { status: 'error', error: 'getaddrinfo ENOTFOUND resolver' } });

    expect(result.lookup).toBe('lookup_failed');
    expect(result.record).toBeNull();
    expect(result.message).toBe('The DNS lookup failed. Try again in a few minutes.');
    expect(result.message).not.toContain('ENOTFOUND');
  });

  it('detects a known incumbent and builds the dual record with ours first', async () => {
    const result = await plan({
      dmarc: txt(
        'v=DMARC1; p=none; rua=mailto:aggregate@ag.dmarcian.com; ruf=mailto:forensic@ag.dmarcian.com',
      ),
      authorization: txt('v=DMARC1'),
    });

    expect(result.lookup).toBe('found');
    expect(result.alreadyReportingToUs).toBe(false);
    expect(result.incumbents).toEqual([
      {
        vendor: 'dmarcian',
        label: 'dmarcian',
        host: 'ag.dmarcian.com',
        uri: 'mailto:aggregate@ag.dmarcian.com',
      },
    ]);
    expect(result.primaryIncumbent).toEqual({ vendor: 'dmarcian', label: 'dmarcian' });
    expect(result.incumbentAggregateTargets).toEqual(['mailto:aggregate@ag.dmarcian.com']);
    expect(result.incumbentForensicTargets).toEqual(['mailto:forensic@ag.dmarcian.com']);
    expect(result.record!.value).toContain(
      `rua=mailto:${OUR},mailto:aggregate@ag.dmarcian.com`,
    );
    expect(result.externalAuthorization).toBe('authorized');
  });

  it('treats an https rua target as an incumbent and takes its host', async () => {
    const result = await plan({
      dmarc: txt('v=DMARC1; p=reject; rua=https://reports.easydmarc.us/v1/abc'),
    });

    expect(result.incumbents).toEqual([
      {
        vendor: 'easydmarc',
        label: 'EasyDMARC',
        host: 'reports.easydmarc.us',
        uri: 'https://reports.easydmarc.us/v1/abc',
      },
    ]);
  });

  it('recognises a record that already reports to us', async () => {
    const result = await plan({
      dmarc: txt(`v=DMARC1; p=none; rua=mailto:${OUR}`),
    });

    expect(result.alreadyReportingToUs).toBe(true);
    expect(result.incumbents).toEqual([]);
    expect(result.primaryIncumbent).toBeNull();
  });

  it('reports external authorisation as missing when the wildcard record is absent', async () => {
    const result = await plan({ dmarc: txt('v=DMARC1; p=none') });

    expect(result.externalAuthorization).toBe('missing');
    expect(result.warnings.find((entry) => entry.code === 'authorization_missing')!.message).toContain(
      '*._report._dmarc.reports.dmarcharbor.com',
    );
  });

  it('reports external authorisation as error when the lookup fails', async () => {
    const result = await plan({
      dmarc: txt('v=DMARC1; p=none'),
      authorization: { status: 'error', error: 'timeout' },
    });

    expect(result.externalAuthorization).toBe('error');
    expect(result.warnings.some((entry) => entry.code === 'authorization_missing')).toBe(false);
  });
});
