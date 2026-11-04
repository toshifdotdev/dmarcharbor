import { describe, expect, it } from 'vitest';
import { MICROSOFT_CONSUMER_TENANT_ID, microsoftEmailVerified } from '../src/auth/microsoft-email.js';
import { socialProvidersFor } from '../src/auth/social-providers.js';

const workTenant = 'b1c2d3e4-0000-4000-8000-000000000001';

describe('Microsoft email verification', () => {
  it('trusts a personal Microsoft account', () => {
    expect(microsoftEmailVerified({ tid: MICROSOFT_CONSUMER_TENANT_ID, email: 'someone@outlook.com' })).toBe(true);
  });

  it('trusts a work account only when its tenant verified the email domain', () => {
    expect(microsoftEmailVerified({ tid: workTenant, email: 'it@pellowyn.example', xms_edov: true })).toBe(true);
    expect(microsoftEmailVerified({ tid: workTenant, email: 'it@pellowyn.example', xms_edov: 'true' })).toBe(true);
    expect(microsoftEmailVerified({ tid: workTenant, email: 'it@pellowyn.example', xms_edov: false })).toBe(false);
  });

  it('never trusts the email claim alone for a work account (nOAuth)', () => {
    // No xms_edov: the tenant may have typed any address onto the user.
    expect(microsoftEmailVerified({ tid: workTenant, email: 'owner@victim.example' })).toBe(false);
    // A tenant-controlled email_verified claim is ignored too.
    expect(
      microsoftEmailVerified({ tid: workTenant, email: 'owner@victim.example', email_verified: true } as never),
    ).toBe(false);
  });

  it('is false without an email, whatever the tenant', () => {
    expect(microsoftEmailVerified({ tid: MICROSOFT_CONSUMER_TENANT_ID })).toBe(false);
    expect(microsoftEmailVerified({ tid: MICROSOFT_CONSUMER_TENANT_ID, email: '  ' })).toBe(false);
  });
});

describe('social providers', () => {
  const config = {
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    MICROSOFT_CLIENT_ID: 'microsoft-id',
    MICROSOFT_CLIENT_SECRET: 'microsoft-secret',
    MICROSOFT_TENANT_ID: 'common',
  };

  it('requires a verified email from both providers', () => {
    const providers = socialProvidersFor(config);
    expect(providers.google?.requireEmailVerification).toBe(true);
    expect(providers.microsoft?.requireEmailVerification).toBe(true);
  });

  it("replaces Microsoft's own verification with the tenant rule", () => {
    const map = socialProvidersFor(config).microsoft!.mapProfileToUser;
    expect(map({ tid: MICROSOFT_CONSUMER_TENANT_ID, email: 'someone@outlook.com' })).toEqual({ emailVerified: true });
    expect(map({ tid: workTenant, email: 'owner@victim.example' })).toEqual({ emailVerified: false });
  });

  it('leaves out a provider whose id or secret is missing', () => {
    const providers = socialProvidersFor({ ...config, MICROSOFT_CLIENT_SECRET: undefined, GOOGLE_CLIENT_ID: undefined });
    expect(Object.keys(providers)).toEqual([]);
  });
});
