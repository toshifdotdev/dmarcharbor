import { describe, expect, it, vi } from 'vitest';
import {
  cymruOriginQuery,
  isNonPublicIp,
  lookupIpIntel,
  normaliseIpAddress,
  parseCymruAsnName,
  parseCymruOrigin,
} from '../src/services/senders/ip-intel.service.js';
import type { DnsReader, LookupResult, MxRecord } from '../src/scanner/types.js';

function reader(overrides: Partial<DnsReader> = {}): DnsReader {
  return {
    async resolveTxt(): Promise<LookupResult<string[][]>> {
      return { status: 'missing' };
    },
    async resolveMx(): Promise<LookupResult<MxRecord[]>> {
      return { status: 'missing' };
    },
    ...overrides,
  };
}

describe('IP intelligence lookups', () => {
  it('normalises IPv6 and builds the Cymru origin names', () => {
    expect(normaliseIpAddress('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(normaliseIpAddress('not-an-ip')).toBeNull();
    expect(cymruOriginQuery('1.2.3.4')).toBe('4.3.2.1.origin.asn.cymru.com');
    expect(cymruOriginQuery('2001:db8::1')).toMatch(/\.origin6\.asn\.cymru\.com$/);
    expect(cymruOriginQuery('2001:db8::1')?.startsWith('1.0.0.0')).toBe(true);
  });

  it('parses strict Cymru answers and rejects malformed ones', () => {
    expect(parseCymruOrigin('15169 | 8.8.8.0/24 | US | arin | 2023-12-28')).toBe(15169);
    expect(parseCymruOrigin('15169 13335 | 8.8.8.0/24 | US | arin | 2023-12-28')).toBe(15169);
    expect(parseCymruOrigin('not-an-asn | x')).toBeNull();
    expect(parseCymruOrigin('')).toBeNull();
    expect(parseCymruAsnName('15169 | US | arin | 2000-03-30 | GOOGLE, US')).toBe('GOOGLE, US');
    expect(parseCymruAsnName('15169 | US')).toBeNull();
  });

  it('skips private, loopback and documentation addresses', () => {
    expect(isNonPublicIp('10.0.0.1')).toBe(true);
    expect(isNonPublicIp('127.0.0.1')).toBe(true);
    expect(isNonPublicIp('192.0.2.10')).toBe(true);
    expect(isNonPublicIp('198.51.100.10')).toBe(true);
    expect(isNonPublicIp('203.0.113.10')).toBe(true);
    expect(isNonPublicIp('2001:db8::1')).toBe(true);
    expect(isNonPublicIp('8.8.8.8')).toBe(false);
    expect(isNonPublicIp('2001:4860:4860::8888')).toBe(false);
  });

  it('forward-confirms the PTR and reads the ASN name', async () => {
    const resolveTxt = vi.fn(async (name: string): Promise<LookupResult<string[][]>> => {
      if (name === '8.8.8.8.origin.asn.cymru.com') {
        return { status: 'found', value: [['15169 | 8.8.8.0/24 | US | arin | 2023-12-28']] };
      }
      if (name === 'AS15169.asn.cymru.com') {
        return { status: 'found', value: [['15169 | US | arin | 2000-03-30 | GOOGLE, US']] };
      }
      return { status: 'missing' };
    });
    const result = await lookupIpIntel(
      '8.8.8.8',
      reader({
        resolveTxt,
        resolvePtr: async () => ({ status: 'found', value: ['dns.google.'] }),
        resolveAddress: async () => ({ status: 'found', value: ['8.8.8.8', '2001:4860:4860::8888'] }),
      }),
      new Date('2026-10-28T00:00:00Z'),
    );

    expect(result.ptr).toBe('dns.google');
    expect(result.ptrConfirmed).toBe(true);
    expect(result.asn).toBe(15169);
    expect(result.asnName).toBe('GOOGLE, US');
    expect(result.status).toBe('OK');
    expect(result.expiresAt.toISOString()).toBe('2026-11-27T00:00:00.000Z');
  });

  it('keeps an unconfirmed PTR but does not confirm it', async () => {
    const result = await lookupIpIntel(
      '8.8.8.8',
      reader({
        resolvePtr: async () => ({ status: 'found', value: ['mail.example.'] }),
        resolveAddress: async () => ({ status: 'found', value: ['8.8.4.4'] }),
      }),
      new Date('2026-10-28T00:00:00Z'),
    );

    expect(result.ptr).toBe('mail.example');
    expect(result.ptrConfirmed).toBe(false);
    expect(result.status).toBe('PARTIAL');
  });

  it('never resolves a private address', async () => {
    const resolvePtr = vi.fn();
    const result = await lookupIpIntel(
      '192.168.1.10',
      reader({ resolvePtr }),
      new Date('2026-10-28T00:00:00Z'),
    );

    expect(result.status).toBe('PRIVATE');
    expect(resolvePtr).not.toHaveBeenCalled();
  });

  it('gives a failed lookup a one-day expiry', async () => {
    const result = await lookupIpIntel(
      '8.8.8.8',
      reader(),
      new Date('2026-10-28T00:00:00Z'),
    );

    expect(result.status).toBe('FAILED');
    expect(result.expiresAt.toISOString()).toBe('2026-10-29T00:00:00.000Z');
  });
});
