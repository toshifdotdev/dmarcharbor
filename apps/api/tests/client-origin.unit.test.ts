import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { appOrigin, clientOrigin, clientOriginFor } from '../src/services/client-origin.js';

const branding = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock('../src/services/branding.service.js', () => ({
  resolveBranding: (organizationId: string) => branding.resolve(organizationId),
}));

/**
 * Every link an agency's client receives is built on this, so it decides
 * whether a client who has only ever seen the agency's domain is handed ours.
 */
describe('clientOrigin', () => {
  const originalAppUrl = env.APP_URL;

  beforeEach(() => {
    branding.resolve.mockReset();
  });

  afterEach(() => {
    env.APP_URL = originalAppUrl;
  });

  it('is the agency domain when branding presents one', async () => {
    branding.resolve.mockResolvedValue({ customDomain: 'reports.wistholm.example', customDomainLive: true, branded: true });

    expect(await clientOrigin('org_1')).toBe('https://reports.wistholm.example');
    expect(branding.resolve).toHaveBeenCalledWith('org_1');
  });

  it('is APP_URL without a trailing slash otherwise', async () => {
    env.APP_URL = 'https://app.harbor.example/';
    // resolveBranding leaves customDomain null when the plan lacks it or the
    // record is unverified, so null is the only case to handle here.
    branding.resolve.mockResolvedValue({ customDomain: null, customDomainLive: false, branded: true });

    expect(await clientOrigin('org_2')).toBe('https://app.harbor.example');
    expect(appOrigin()).toBe('https://app.harbor.example');
  });

  it('falls back to APP_URL when no branding could be read', () => {
    env.APP_URL = 'https://app.harbor.example';

    expect(clientOriginFor(null)).toBe('https://app.harbor.example');
    expect(clientOriginFor({ customDomain: 'portal.pellowyn.example', customDomainLive: true })).toBe(
      'https://portal.pellowyn.example',
    );
  });
});
