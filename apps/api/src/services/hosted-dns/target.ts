import { env } from '../../config/env.js';

const tokenPattern = /^[a-z2-7]{16}$/;
export const hostedTokenAlphabet = 'abcdefghijklmnopqrstuvwxyz234567';

export function isHostedToken(value: string): boolean {
  return tokenPattern.test(value);
}

/** The name the customer's CNAME points at. */
export function recordName(token: string): string {
  return `${token}.${env.HOSTED_DNS_ZONE ?? ''}`;
}

/**
 * True when a CNAME target is exactly one of our token names in our zone.
 *
 * Pure and env-only, so the switch planner can ask without importing the
 * service (which would close a cycle through the scanner and switch code).
 */
export function isOurHostedTarget(cname: string | null | undefined): boolean {
  const zone = env.HOSTED_DNS_ZONE;
  if (!zone || !cname) {
    return false;
  }
  const target = cname.trim().toLowerCase().replace(/\.+$/, '');
  const suffix = `.${zone}`;
  if (!target.endsWith(suffix)) {
    return false;
  }
  return tokenPattern.test(target.slice(0, -suffix.length));
}
