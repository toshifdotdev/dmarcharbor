import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAMES, hasSessionCookie, sessionCookieHeader } from '../lib/session-cookie.js';

/**
 * The session cookie the web forwards to the API.
 *
 * Better Auth names it `__Secure-better-auth.session_token` when its base URL
 * is https (production) and `better-auth.session_token` on plain http
 * (development, CI). Forwarding only the plain name signs every production
 * visitor out, so both are read, and each is forwarded under its own name.
 */

function jar(values: Record<string, string>) {
  return {
    get(name: string) {
      return name in values ? { value: values[name] } : undefined;
    },
  };
}

describe('sessionCookieHeader', () => {
  it('forwards the production cookie under its __Secure- name', () => {
    expect(sessionCookieHeader(jar({ '__Secure-better-auth.session_token': 'tok.sig' }))).toBe(
      '__Secure-better-auth.session_token=tok.sig',
    );
  });

  it('forwards the development cookie under its plain name', () => {
    expect(sessionCookieHeader(jar({ 'better-auth.session_token': 'tok.sig' }))).toBe(
      'better-auth.session_token=tok.sig',
    );
  });

  it('prefers the secure cookie when both are present', () => {
    expect(
      sessionCookieHeader(
        jar({ 'better-auth.session_token': 'stale', '__Secure-better-auth.session_token': 'live' }),
      ),
    ).toBe('__Secure-better-auth.session_token=live');
  });

  it('skips an empty value and returns null with no session', () => {
    expect(sessionCookieHeader(jar({ '__Secure-better-auth.session_token': '' }))).toBeNull();
    expect(sessionCookieHeader(jar({ 'harbor.workspace': 'ws_1' }))).toBeNull();
  });
});

describe('hasSessionCookie', () => {
  it('is true for either name and false for neither', () => {
    for (const name of SESSION_COOKIE_NAMES) expect(hasSessionCookie(jar({ [name]: 'x' }))).toBe(true);
    expect(hasSessionCookie(jar({}))).toBe(false);
  });
});
