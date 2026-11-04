import { microsoftEmailVerified, type MicrosoftEmailClaims } from './microsoft-email.js';

/** The part of the environment the providers are built from. */
export interface SocialProviderConfig {
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  MICROSOFT_CLIENT_ID?: string | undefined;
  MICROSOFT_CLIENT_SECRET?: string | undefined;
  MICROSOFT_TENANT_ID: string;
}

/**
 * Google and Microsoft sign-in, each only when both its id and secret are set.
 *
 * Both require a verified email before a session is made. With
 * `requireEmailVerification`, Better Auth sends the account a verification
 * link and answers `email_not_verified` instead of signing an unverified
 * account in; the sign-in page explains that.
 *
 * Google reports verification itself. Microsoft's own report is replaced by
 * `microsoftEmailVerified` (microsoft-email.ts), which trusts a personal
 * account or a tenant-verified email domain and nothing else. Because the map
 * runs last in the provider's user info, it also decides whether a Microsoft
 * sign-in may link to an existing account with the same email: Better Auth
 * links implicitly only when the provider's email is verified.
 */
export function socialProvidersFor(config: SocialProviderConfig) {
  return {
    ...(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: config.GOOGLE_CLIENT_ID,
            clientSecret: config.GOOGLE_CLIENT_SECRET,
            prompt: 'select_account' as const,
            requireEmailVerification: true,
          },
        }
      : {}),
    ...(config.MICROSOFT_CLIENT_ID && config.MICROSOFT_CLIENT_SECRET
      ? {
          microsoft: {
            clientId: config.MICROSOFT_CLIENT_ID,
            clientSecret: config.MICROSOFT_CLIENT_SECRET,
            tenantId: config.MICROSOFT_TENANT_ID,
            prompt: 'select_account' as const,
            requireEmailVerification: true,
            mapProfileToUser: (profile: MicrosoftEmailClaims) => ({ emailVerified: microsoftEmailVerified(profile) }),
          },
        }
      : {}),
  };
}
