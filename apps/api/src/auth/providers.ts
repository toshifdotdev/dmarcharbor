import { env } from '../config/env.js';

/**
 * Which sign-in methods this deployment actually offers.
 *
 * The social providers are conditional on an OAuth application being
 * registered, so the set of buttons differs between a laptop and production.
 * Hardcoding them in the UI means either dead buttons in development or missing
 * ones in production, and a build that shows a button leading nowhere is a build
 * that lies about what it can do.
 *
 * Deliberately unauthenticated. It is read by the sign-in page, which is the one
 * screen nobody can reach while signed in, so requiring a session would make it
 * useless for its only purpose.
 *
 * Only ever returns whether a provider is configured. No client id, no
 * authorisation URL, nothing that could be turned into a token.
 */

export interface ProviderCredentials {
  googleClientId?: string;
  googleClientSecret?: string;
  microsoftClientId?: string;
  microsoftClientSecret?: string;
}

export interface ProviderAvailability {
  password: boolean;
  google: boolean;
  microsoft: boolean;
}

/**
 * Pure, so the conditional behaviour can be tested without mutating the
 * environment. Callers with no arguments get the real configuration.
 */
export function resolveProviderAvailability(credentials: ProviderCredentials): ProviderAvailability {
  return {
    // Password sign-in has no external dependency, so it is always offered.
    // Email verification is required in the auth config rather than being
    // configurable, so this cannot go false.
    password: true,
    google: Boolean(credentials.googleClientId && credentials.googleClientSecret),
    microsoft: Boolean(credentials.microsoftClientId && credentials.microsoftClientSecret),
  };
}

export function authProviderAvailability(): ProviderAvailability {
  return resolveProviderAvailability({
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    microsoftClientId: env.MICROSOFT_CLIENT_ID,
    microsoftClientSecret: env.MICROSOFT_CLIENT_SECRET,
  });
}