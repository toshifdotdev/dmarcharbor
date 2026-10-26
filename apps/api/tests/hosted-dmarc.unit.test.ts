import { describe, expect, it, vi } from 'vitest';
import { env, assertHostedDnsConfig } from '../src/config/env.js';
import { createCloudflareClient } from '../src/services/dns-automation/cloudflare.client.js';
import {
  effectiveLevel,
  isOurHostedTarget,
  randomHostedToken,
  uniqueHostedToken,
} from '../src/services/hosted-dns/hosted-dmarc.service.js';

const zone = 'hosted.example.test';

describe('hosted DMARC tokens', () => {
  it('generates 16 lowercase base32 characters', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(randomHostedToken()).toMatch(/^[a-z2-7]{16}$/);
    }
  });

  it('retries a token that already exists', async () => {
    const generated = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
    let index = 0;
    const exists = vi.fn(async (token: string) => token === 'aaaaaaaaaaaaaaaa');

    const token = await uniqueHostedToken(exists, () => generated[index++]!);

    expect(token).toBe('bbbbbbbbbbbbbbbb');
    expect(index).toBe(2);
  });
});

describe('hosted target recognition', () => {
  it('accepts only exactly one 16-character base32 label in our zone', () => {
    env.HOSTED_DNS_ZONE = zone;
    const token = 'abcdefghijklmnop';

    expect(isOurHostedTarget(`${token}.${zone}`)).toBe(true);
    expect(isOurHostedTarget(`${token}.${zone}.`)).toBe(true);
    expect(isOurHostedTarget(`${token.toUpperCase()}.${zone}`)).toBe(true);
    expect(isOurHostedTarget(`${'a'.repeat(17)}.${zone}`)).toBe(false);
    expect(isOurHostedTarget(`${'a'.repeat(15)}.${zone}`)).toBe(false);
    expect(isOurHostedTarget(`${token}.other.test`)).toBe(false);
    expect(isOurHostedTarget(zone)).toBe(false);
    expect(isOurHostedTarget(null)).toBe(false);
  });
});

describe('hosted policy strength', () => {
  it('treats testing as one level softer, exactly as the scanner does', () => {
    expect(effectiveLevel({ p: 'none', testing: false, np: null })).toBe(0);
    expect(effectiveLevel({ p: 'quarantine', testing: false, np: null })).toBe(1);
    expect(effectiveLevel({ p: 'reject', testing: false, np: null })).toBe(2);
    expect(effectiveLevel({ p: 'quarantine', testing: true, np: null })).toBe(0);
    expect(effectiveLevel({ p: 'reject', testing: true, np: null })).toBe(1);
    expect(effectiveLevel({ p: 'none', testing: true, np: null })).toBe(0);
  });
});

describe('Cloudflare zone TXT pagination', () => {
  it('reads result_info and asks for the next page by number', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: [
            { id: 'rec-1', name: 'abc.hosted.example.test', content: 'v=DMARC1; p=none', ttl: 1, comment: 'x' },
          ],
          result_info: { page: 1, total_pages: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = createCloudflareClient({
      token: ['cf', 'hosted', 'test'].join('-'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const page = await client.listZoneTxtRecords('zone-1', 2);

    expect(page.totalPages).toBe(2);
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({ id: 'rec-1', content: 'v=DMARC1; p=none' });
    expect(urls[0]).toContain('type=TXT');
    expect(urls[0]).toContain('per_page=100');
    expect(urls[0]).toContain('page=2');
  });
});

describe('hosted DNS configuration', () => {
  it('refuses a partial set and accepts all or none', () => {
    expect(() => assertHostedDnsConfig({ zone })).toThrow(/configured together/);
    expect(() => assertHostedDnsConfig({ token: 'token' })).toThrow(/configured together/);
    expect(() => assertHostedDnsConfig({ zoneId: 'a'.repeat(32) })).toThrow(/configured together/);
    expect(() => assertHostedDnsConfig({ zone, token: 'token', zoneId: 'a'.repeat(32) })).not.toThrow();
    expect(() => assertHostedDnsConfig({})).not.toThrow();
  });
});
