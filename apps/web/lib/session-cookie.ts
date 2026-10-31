/**
 * session-cookie.ts — the Better Auth session cookie, under either of its names.
 *
 * Better Auth prefixes its cookies with `__Secure-` whenever its base URL is
 * https, so in production the session cookie is
 * `__Secure-better-auth.session_token`, and only on plain-http development
 * hosts is it `better-auth.session_token`. Every server-side API call here used
 * to forward the unprefixed name only, which never exists in production: every
 * signed-in page would have read the visitor as signed out. Both names are
 * read, the secure one first, and the cookie is forwarded under the name it
 * had, which is the name the API looks for.
 *
 * No Next imports, so the proxy, the server helpers and the tests share it.
 */

export const SESSION_COOKIE_NAMES = ["__Secure-better-auth.session_token", "better-auth.session_token"] as const;

interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/** `name=value` for the session cookie, ready for a Cookie header, or null. */
export function sessionCookieHeader(jar: CookieReader): string | null {
  for (const name of SESSION_COOKIE_NAMES) {
    const cookie = jar.get(name);
    if (cookie?.value) return `${name}=${cookie.value}`;
  }
  return null;
}

/** True when either session cookie is present. */
export function hasSessionCookie(jar: CookieReader): boolean {
  return sessionCookieHeader(jar) !== null;
}
