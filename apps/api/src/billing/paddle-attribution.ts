import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Proof that a hosted checkout was created by us, for this workspace.
 *
 * Paddle.js runs in the browser with our public client token, and a hosted
 * checkout link (Paddle or Dodo Payments) can be opened by anyone with any
 * custom data or metadata they like, our workspace ids included. A webhook that
 * trusted `organizationId` in metadata for a subscription it had not seen would
 * let a stranger pay for a cheap plan in another workspace's name and replace
 * that workspace's subscription: its plan, its customer and its billing portal.
 * Our server puts this value beside the workspace id on every checkout it
 * creates; a value nobody can compute without our secret is what makes the id
 * worth believing.
 */
export type AttributionProvider = 'PADDLE' | 'DODO';

export function checkoutAttribution(organizationId: string, provider: AttributionProvider = 'PADDLE'): string {
  const prefix = provider === 'DODO' ? 'dodo-checkout' : 'paddle-checkout';
  return createHmac('sha256', env.BETTER_AUTH_SECRET).update(`${prefix}:${organizationId}`).digest('base64url');
}

/** Constant-time check of a presented attribution. */
export function checkoutAttributionMatches(
  organizationId: string,
  presented: unknown,
  provider: AttributionProvider = 'PADDLE',
): boolean {
  if (typeof presented !== 'string' || presented === '') {
    return false;
  }
  const expected = Buffer.from(checkoutAttribution(organizationId, provider), 'utf8');
  const given = Buffer.from(presented, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function paddleAttribution(organizationId: string): string {
  return checkoutAttribution(organizationId, 'PADDLE');
}

export function paddleAttributionMatches(organizationId: string, presented: unknown): boolean {
  return checkoutAttributionMatches(organizationId, presented, 'PADDLE');
}

export function dodoAttribution(organizationId: string): string {
  return checkoutAttribution(organizationId, 'DODO');
}

export function dodoAttributionMatches(organizationId: string, presented: unknown): boolean {
  return checkoutAttributionMatches(organizationId, presented, 'DODO');
}
