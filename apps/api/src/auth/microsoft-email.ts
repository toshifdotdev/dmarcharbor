/**
 * Whether a Microsoft sign-in proves the person owns the email it reports.
 *
 * Microsoft's `email` claim is whatever the account's tenant says it is. In a
 * work or school tenant an administrator can set any address on a user,
 * including one at a domain the tenant never proved it owns, so trusting the
 * claim on its own lets a stranger's tenant sign in as, or link to, someone
 * else's account. That is the "nOAuth" flaw Microsoft documents.
 *
 * Two cases are trusted, and nothing else:
 * - A personal Microsoft account, which always carries the fixed consumer
 *   tenant id. Microsoft confirms the address when the account is created.
 * - A work or school account whose token says the email's domain is verified
 *   by its tenant (`xms_edov: true`). The claim is optional: it is only sent
 *   once it is added to the app registration's token configuration, and an
 *   account without it is treated as unverified and asked to confirm the
 *   address by email.
 *
 * `email_verified` and the `verified_*_email` lists that Better Auth falls back
 * on are deliberately ignored, because a tenant controls them too.
 *
 * @see https://learn.microsoft.com/en-us/entra/identity-platform/migrate-off-email-claim-authorization
 */
export const MICROSOFT_CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

export interface MicrosoftEmailClaims {
  tid?: unknown;
  xms_edov?: unknown;
  email?: unknown;
}

export function microsoftEmailVerified(claims: MicrosoftEmailClaims): boolean {
  if (typeof claims.email !== 'string' || claims.email.trim() === '') {
    return false;
  }
  if (claims.tid === MICROSOFT_CONSUMER_TENANT_ID) {
    return true;
  }
  // Microsoft documents the claim as a boolean; some tokens carry it as a string.
  return claims.xms_edov === true || claims.xms_edov === 'true' || claims.xms_edov === 1;
}
