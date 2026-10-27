import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import {
  HostedBimiError,
  hostedBimiNamePattern,
  hostedBimiValue,
  parsePemChain,
  validateBimiCertificate,
} from '../src/services/hosted-dns/hosted-bimi.service.js';
import { hostedDmarcNamePattern } from '../src/services/hosted-dns/hosted-dmarc.service.js';
import { hostedSpfNamePattern } from '../src/services/hosted-dns/managed-spf.service.js';
import { certificateFor } from './helpers/certificate.js';

/**
 * The rules that decide what a BIMI record says and what a certificate may be,
 * with no database and no network. Every fixture certificate is generated at
 * runtime — see tests/helpers/certificate.ts for why.
 */

/** A PEM header, assembled rather than written out, so no key block is committed. */
const privateKeyHeader = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');

const originalOrigin = env.HOSTED_BIMI_ORIGIN;

beforeEach(() => {
  env.HOSTED_BIMI_ORIGIN = 'https://bimi.test';
});

afterEach(() => {
  env.HOSTED_BIMI_ORIGIN = originalOrigin;
});

const logoSha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const certSha = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

describe('hosted BIMI record value', () => {
  it('publishes the logo and the certificate when both exist', () => {
    const value = hostedBimiValue({
      token: 'aaaaaaaaaaaaaaaa',
      logoSha256: logoSha,
      certificateSha256: certSha,
      certificateExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    expect(value).toBe(
      'v=BIMI1; l=https://bimi.test/bimi/aaaaaaaaaaaaaaaa/0123456789ab.svg; a=https://bimi.test/bimi/aaaaaaaaaaaaaaaa/fedcba987654.pem',
    );
  });

  it('publishes a= empty when there is no certificate', () => {
    const value = hostedBimiValue({ token: 'aaaaaaaaaaaaaaaa', logoSha256: logoSha });

    expect(value).toBe('v=BIMI1; l=https://bimi.test/bimi/aaaaaaaaaaaaaaaa/0123456789ab.svg; a=');
  });

  it('publishes a= empty when the certificate has expired', () => {
    const value = hostedBimiValue({
      token: 'aaaaaaaaaaaaaaaa',
      logoSha256: logoSha,
      certificateSha256: certSha,
      certificateExpiresAt: new Date(Date.now() - 1000),
    });

    expect(value).toContain('a=');
    expect(value).not.toContain('.pem');
  });

  it('treats a certificate expiring exactly now as expired', () => {
    const now = new Date('2026-11-03T12:00:00.000Z');
    const value = hostedBimiValue({
      token: 'aaaaaaaaaaaaaaaa',
      logoSha256: logoSha,
      certificateSha256: certSha,
      certificateExpiresAt: now,
      now,
    });

    expect(value.endsWith('a=')).toBe(true);
  });

  it('trims a trailing slash from the origin rather than publishing a double slash', () => {
    env.HOSTED_BIMI_ORIGIN = 'https://bimi.test/';
    const value = hostedBimiValue({ token: 'aaaaaaaaaaaaaaaa', logoSha256: logoSha });

    expect(value).toContain('l=https://bimi.test/bimi/');
    expect(value).not.toContain('//bimi/');
  });
});

describe('hosted DNS sweep patterns', () => {
  const zone = 'hosted.test';
  const token = 'abcdefghijklmnop';

  it('matches each feature only at its own name', () => {
    expect(hostedDmarcNamePattern(zone).test(`${token}.${zone}`)).toBe(true);
    expect(hostedSpfNamePattern(zone).test(`${token}.spf.${zone}`)).toBe(true);
    expect(hostedBimiNamePattern(zone).test(`${token}.bimi.${zone}`)).toBe(true);
  });

  it('never lets the DMARC or SPF sweep claim a BIMI name', () => {
    const bimi = `${token}.bimi.${zone}`;
    expect(hostedDmarcNamePattern(zone).test(bimi)).toBe(false);
    expect(hostedSpfNamePattern(zone).test(bimi)).toBe(false);
  });

  it('never lets the BIMI sweep claim a DMARC or SPF name', () => {
    expect(hostedBimiNamePattern(zone).test(`${token}.${zone}`)).toBe(false);
    expect(hostedBimiNamePattern(zone).test(`${token}.spf.${zone}`)).toBe(false);
    expect(hostedBimiNamePattern(zone).test(`${token}-2.spf.${zone}`)).toBe(false);
  });

  it('keeps a label that merely starts like a token out of every sweep', () => {
    // A token is exactly 16 characters, so a longer label is not one of ours.
    expect(hostedDmarcNamePattern(zone).test(`${token}bimi.${zone}`)).toBe(false);
    expect(hostedBimiNamePattern(zone).test(`${token}bimi.${zone}`)).toBe(false);
  });
});

describe('BIMI certificate parsing', () => {
  it('reads a chain and takes the first certificate as the leaf', () => {
    const leaf = certificateFor({ commonName: 'example.com' });
    const intermediate = certificateFor({ commonName: 'Test Intermediate', names: ['intermediate.test'] });

    const parsed = parsePemChain(Buffer.from(leaf + intermediate, 'utf8'));
    expect(parsed.chain).toHaveLength(2);
    expect(parsed.leaf.subjectAltName).toContain('example.com');
  });

  it('accepts a valid certificate and reports its facts', () => {
    const validated = validateBimiCertificate({
      bytes: Buffer.from(certificateFor({ organisation: 'Example Ltd' }), 'utf8'),
      domainName: 'example.com',
    });

    expect(validated.names).toContain('example.com');
    expect(validated.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(validated.subject).toBe('Example Ltd');
    expect(validated.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validated.isMarkCertificate).toBe(false);
  });

  it('detects the mark certificate extended key usage', () => {
    const validated = validateBimiCertificate({
      bytes: Buffer.from(certificateFor({ markCertificate: true }), 'utf8'),
      domainName: 'example.com',
    });

    expect(validated.isMarkCertificate).toBe(true);
  });

  it('refuses a file that contains a private key', () => {
    const bytes = Buffer.from(`${privateKeyHeader}\nAAAA\n`, 'utf8');
    expect(() => parsePemChain(bytes)).toThrowError(
      expect.objectContaining({ code: 'BIMI_CERT_HAS_PRIVATE_KEY' }),
    );

    try {
      parsePemChain(bytes);
    } catch (error) {
      expect((error as HostedBimiError).message).toContain('never share the private key');
    }
  });

  it('refuses an expired certificate', () => {
    const now = Date.now();
    const bytes = Buffer.from(
      certificateFor({
        notBefore: new Date(now - 400 * 24 * 60 * 60 * 1000),
        notAfter: new Date(now - 30 * 24 * 60 * 60 * 1000),
      }),
      'utf8',
    );

    expect(() => validateBimiCertificate({ bytes, domainName: 'example.com' })).toThrowError(
      expect.objectContaining({ code: 'BIMI_CERT_EXPIRED' }),
    );
  });

  it('refuses a certificate that is not valid yet', () => {
    const now = Date.now();
    const bytes = Buffer.from(
      certificateFor({
        notBefore: new Date(now + 7 * 24 * 60 * 60 * 1000),
        notAfter: new Date(now + 300 * 24 * 60 * 60 * 1000),
      }),
      'utf8',
    );

    expect(() => validateBimiCertificate({ bytes, domainName: 'example.com' })).toThrowError(
      expect.objectContaining({ code: 'BIMI_CERT_NOT_YET_VALID' }),
    );
  });

  it('refuses a certificate that names another domain', () => {
    const bytes = Buffer.from(certificateFor({ names: ['other.example'] }), 'utf8');

    expect(() => validateBimiCertificate({ bytes, domainName: 'example.com' })).toThrowError(
      expect.objectContaining({ code: 'BIMI_CERT_WRONG_DOMAIN' }),
    );
  });

  it('accepts a certificate for the organisational domain of a subdomain', () => {
    const bytes = Buffer.from(certificateFor({ names: ['example.com'] }), 'utf8');

    const validated = validateBimiCertificate({ bytes, domainName: 'mail.example.com' });
    expect(validated.names).toContain('example.com');
  });

  it('refuses trailing junk after the last block', () => {
    const bytes = Buffer.from(`${certificateFor()}\nthis line was not meant to be here\n`, 'utf8');

    expect(() => parsePemChain(bytes)).toThrowError(
      expect.objectContaining({ code: 'BIMI_CERT_INVALID' }),
    );
  });

  it('refuses a body with no certificate block at all', () => {
    expect(() => parsePemChain(Buffer.from('not a certificate', 'utf8'))).toThrowError(
      expect.objectContaining({ code: 'BIMI_CERT_INVALID' }),
    );
  });
});
