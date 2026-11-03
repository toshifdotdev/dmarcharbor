import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * canonicalOrigin and isOwnPublicHost over a mocked request: the headers the
 * proxy stamps (brand state, host kind) and the Host a request arrives with,
 * with SITE_URL set and unset.
 */

let current: Record<string, string> | null = {};

vi.mock('next/headers', () => ({
  headers: async () => {
    if (current === null) throw new Error('no request store');
    return new Headers(current);
  },
}));

const { canonicalOrigin, currentHostKind, isOwnPublicHost } = await import('../lib/site-origin');

function request(host: string, extra: Record<string, string> = {}) {
  current = { host, 'x-forwarded-proto': 'https', ...extra };
}

const AGENCY_BRAND = JSON.stringify({ workspaceName: 'Wistholm IT' });

beforeEach(() => {
  current = {};
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('with SITE_URL set', () => {
  beforeEach(() => {
    vi.stubEnv('SITE_URL', 'https://dmarcharbor.com');
  });

  it('our own hostname is own, and canonical is SITE_URL', async () => {
    request('dmarcharbor.com');
    expect(await isOwnPublicHost()).toBe(true);
    expect(await canonicalOrigin()).toBe('https://dmarcharbor.com');
  });

  it('www. and app. duplicates are not own, and still name SITE_URL as canonical', async () => {
    for (const host of ['www.dmarcharbor.com', 'app.dmarcharbor.com']) {
      request(host, { 'x-harbor-host-state': 'miss' });
      expect(await isOwnPublicHost(), host).toBe(false);
      expect(await canonicalOrigin(), host).toBe('https://dmarcharbor.com');
    }
  });

  it('an unverified or unknown host is other, canonical SITE_URL', async () => {
    for (const state of ['unverified', 'miss']) {
      request('pointed.example', { 'x-harbor-host-state': state });
      expect(await currentHostKind()).toBe('other');
      expect(await canonicalOrigin()).toBe('https://dmarcharbor.com');
    }
  });

  it("a verified agency domain is agency, and canonical is the agency's own origin", async () => {
    request('portal.wistholm.example', { 'x-harbor-host-state': 'verified', 'x-harbor-brand': AGENCY_BRAND });
    expect(await currentHostKind()).toBe('agency');
    expect(await isOwnPublicHost()).toBe(false);
    expect(await canonicalOrigin()).toBe('https://portal.wistholm.example');
  });

  it('reads X-Forwarded-Host before Host, as the canonical origin does', async () => {
    request('localhost:3100', { 'x-forwarded-host': 'dmarcharbor.com' });
    expect(await isOwnPublicHost()).toBe(true);
  });

  it("trusts the proxy's stamp over its own reading, so meta and header agree", async () => {
    request('dmarcharbor.com', { 'x-harbor-host-kind': 'other' });
    expect(await isOwnPublicHost()).toBe(false);
  });

  it('with no request at all (a static render), the canonical host is assumed', async () => {
    current = null;
    expect(await isOwnPublicHost()).toBe(true);
    expect(await canonicalOrigin()).toBe('https://dmarcharbor.com');
  });
});

describe('with SITE_URL unset', () => {
  beforeEach(() => {
    vi.stubEnv('SITE_URL', '');
  });

  it('our app-local hosts (state default) are own, canonical the request origin', async () => {
    current = { host: 'localhost:3100' };
    expect(await isOwnPublicHost()).toBe(true);
    expect(await canonicalOrigin()).toBe('http://localhost:3100');
  });

  it('an unverified or unknown host is never own', async () => {
    for (const state of ['unverified', 'miss']) {
      request('pointed.example', { 'x-harbor-host-state': state });
      expect(await isOwnPublicHost(), state).toBe(false);
      expect(await canonicalOrigin(), state).toBe('https://pointed.example');
    }
  });

  it("a verified agency domain is agency, canonical its own origin", async () => {
    request('portal.wistholm.example', { 'x-harbor-host-state': 'verified', 'x-harbor-brand': AGENCY_BRAND });
    expect(await currentHostKind()).toBe('agency');
    expect(await canonicalOrigin()).toBe('https://portal.wistholm.example');
  });
});
