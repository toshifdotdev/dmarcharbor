import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import {
  buildMtaStsPolicy,
  hostedMtaStsNamePattern,
  mtaStsEnforceMinMaxAge,
  mtaStsMaxMaxAge,
  mtaStsMinMaxAge,
  mtaStsTxtValue,
  nextPolicyId,
  validateMtaStsPolicyInput,
} from '../src/services/hosted-dns/hosted-mta-sts.service.js';
import { hostedBimiNamePattern } from '../src/services/hosted-dns/hosted-bimi.service.js';
import { hostedDmarcNamePattern } from '../src/services/hosted-dns/hosted-dmarc.service.js';
import { hostedSpfNamePattern } from '../src/services/hosted-dns/managed-spf.service.js';
import { mxCoveredBy, parseMtaStsPolicy } from '../src/scanner/transport-records.js';

/**
 * The rules that decide what a hosted policy says, without a database.
 *
 * The most important assertion in this file is the first one: the body we
 * serve has to be accepted by the same parser the scanner uses to judge a
 * customer's policy. If those two ever disagree, a domain we host would be
 * reported as broken by our own scan.
 */

const hosts = ['mx1.example.com', 'mx2.example.com'];

describe('the policy we serve', () => {
  it('is accepted by the scanner parser', () => {
    const body = buildMtaStsPolicy({ mode: 'enforce', mx: hosts, maxAge: 604_800 });
    const parsed = parseMtaStsPolicy(body, 'text/plain');

    expect(parsed.problems).toEqual([]);
    expect(parsed.contentTypeProblem).toBeNull();
    expect(parsed.valid).toBe(true);
    expect(parsed.mode).toBe('enforce');
    expect(parsed.maxAge).toBe(604_800);
    expect(parsed.mx).toEqual(hosts);
  });

  it('uses CRLF line endings and one mx line per pattern', () => {
    const body = buildMtaStsPolicy({ mode: 'testing', mx: hosts, maxAge: 86_400 });

    expect(body).toBe(
      'version: STSv1\r\nmode: testing\r\nmx: mx1.example.com\r\nmx: mx2.example.com\r\nmax_age: 86400\r\n',
    );
    expect(body.split('\r\n').filter(Boolean)).toHaveLength(5);
  });

  it('covers every MX host the domain had at start', () => {
    const body = buildMtaStsPolicy({ mode: 'testing', mx: hosts, maxAge: 86_400 });
    const parsed = parseMtaStsPolicy(body, 'text/plain');

    for (const host of hosts) {
      expect(mxCoveredBy(host, parsed.mx ?? []), host).toBe(true);
    }
  });

  it('publishes a none policy with no mx lines', () => {
    const body = buildMtaStsPolicy({ mode: 'none', mx: [], maxAge: 86_400 });
    const parsed = parseMtaStsPolicy(body, 'text/plain');

    expect(parsed.valid).toBe(true);
    expect(parsed.mode).toBe('none');
    expect(body).not.toContain('mx:');
  });

  it('publishes the id in the TXT, never the policy itself', () => {
    expect(mtaStsTxtValue('20261104120000ab')).toBe('v=STSv1; id=20261104120000ab');
  });
});

describe('policy ids', () => {
  it('is 1 to 32 alphanumerics, as the TXT parser requires', () => {
    const id = nextPolicyId(new Date('2026-11-04T12:34:56.000Z'));

    expect(id).toMatch(/^[A-Za-z0-9]{1,32}$/);
    expect(id.startsWith('20261104123456')).toBe(true);
  });

  it('changes between two changes in the same second', () => {
    const now = new Date('2026-11-04T12:34:56.000Z');
    const ids = new Set(Array.from({ length: 20 }, () => nextPolicyId(now)));

    // Two random characters give 1,296 combinations; twenty draws colliding is
    // possible but would make the id useless as a cache-buster.
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe('policy validation', () => {
  const valid = { mode: 'testing', mx: ['mx1.example.com'], maxAge: mtaStsMinMaxAge };

  it('accepts a normal testing policy and normalises the hosts', () => {
    const result = validateMtaStsPolicyInput({
      mode: 'testing',
      mx: ['  MX1.Example.com. ', '*.mail.example.com'],
      maxAge: 86_400,
    });

    expect(result.mx).toEqual(['mx1.example.com', '*.mail.example.com']);
  });

  it('refuses mode none, which only release publishes', () => {
    expect(() => validateMtaStsPolicyInput({ ...valid, mode: 'none' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_POLICY' }),
    );
  });

  it('refuses a host that is not a hostname or wildcard', () => {
    for (const host of ['mx1', 'http://mx1.example.com', 'mx1.example.com/path', '*']) {
      expect(() => validateMtaStsPolicyInput({ ...valid, mx: [host] }), host).toThrowError(
        expect.objectContaining({ code: 'INVALID_POLICY' }),
      );
    }
  });

  it('refuses an empty list or more than ten hosts', () => {
    expect(() => validateMtaStsPolicyInput({ ...valid, mx: [] })).toThrowError(
      expect.objectContaining({ code: 'INVALID_POLICY' }),
    );
    const eleven = Array.from({ length: 11 }, (_, index) => `mx${index}.example.com`);
    expect(() => validateMtaStsPolicyInput({ ...valid, mx: eleven })).toThrowError(
      expect.objectContaining({ code: 'INVALID_POLICY' }),
    );
  });

  it('holds max_age inside the RFC range', () => {
    expect(() => validateMtaStsPolicyInput({ ...valid, maxAge: 3600 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_POLICY' }),
    );
    expect(() => validateMtaStsPolicyInput({ ...valid, maxAge: mtaStsMaxMaxAge + 1 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_POLICY' }),
    );
  });

  it('refuses an enforcing policy shorter than a week', () => {
    expect(() =>
      validateMtaStsPolicyInput({ mode: 'enforce', mx: ['mx1.example.com'], maxAge: 86_400 }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_POLICY' }));

    expect(
      validateMtaStsPolicyInput({ mode: 'enforce', mx: ['mx1.example.com'], maxAge: mtaStsEnforceMinMaxAge })
        .maxAge,
    ).toBe(mtaStsEnforceMinMaxAge);
  });
});

describe('hosted DNS sweep patterns', () => {
  const zone = 'hosted.test';
  const token = 'abcdefghijklmnop';

  it('matches only its own name', () => {
    expect(hostedMtaStsNamePattern(zone).test(`${token}._mta-sts.${zone}`)).toBe(true);
    expect(hostedMtaStsNamePattern(zone).test(`${token}.bimi.${zone}`)).toBe(false);
    expect(hostedMtaStsNamePattern(zone).test(`${token}.spf.${zone}`)).toBe(false);
    expect(hostedMtaStsNamePattern(zone).test(`${token}.${zone}`)).toBe(false);
  });

  it('is not matched by the other three sweeps', () => {
    const name = `${token}._mta-sts.${zone}`;
    expect(hostedDmarcNamePattern(zone).test(name)).toBe(false);
    expect(hostedSpfNamePattern(zone).test(name)).toBe(false);
    expect(hostedBimiNamePattern(zone).test(name)).toBe(false);
  });

  it('keeps a label that merely starts like a token out', () => {
    expect(hostedMtaStsNamePattern(zone).test(`${token}x_mta-sts.${zone}`)).toBe(false);
  });
});

describe('configuration guards', () => {
  it('exposes the defaults the cost model depends on', () => {
    // 100 free custom hostnames; the operator opts in to paying.
    expect(env.HOSTED_MTA_STS_HOSTNAME_LIMIT).toBeGreaterThanOrEqual(1);
    expect(env.HOSTED_MTA_STS_HOSTNAME_LIMIT).toBeLessThanOrEqual(50_000);
  });
});
