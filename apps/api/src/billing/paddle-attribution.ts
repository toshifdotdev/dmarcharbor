import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Proof that a Paddle checkout was created by us, for this workspace.
 *
 * Paddle.js runs in the browser with our public client token, and anyone can
 * open a checkout with it and put any `custom_data` they like on it, our
 * workspace ids included. The webhook trusted `custom_data.organizationId` for
 * a subscription it had not seen, so a stranger could pay for a cheap plan in
 * another workspace's name and replace that workspace's subscription: its plan,
 * its customer and its billing portal. Our server puts this value beside the
 * workspace id on every checkout it creates; a value nobody can compute without
 * our secret is what makes the id worth believing.
 */
export function paddleAttribution(organizationId: string): string {
  return createHmac('sha256', env.BETTER_AUTH_SECRET).update(`paddle-checkout:${organizationId}`).digest('base64url');
}

/** Constant-time check of a presented attribution. */
export function paddleAttributionMatches(organizationId: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented === '') {
    return false;
  }
  const expected = Buffer.from(paddleAttribution(organizationId), 'utf8');
  const given = Buffer.from(presented, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
