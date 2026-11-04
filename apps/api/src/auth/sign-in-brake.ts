import { createHash } from 'node:crypto';
import { rateLimitStoreFor } from '../middleware/postgres-rate-limit-store.js';

/**
 * The per-account brake on wrong passwords.
 *
 * The IP limiter (20 auth requests a minute per address) stops one machine
 * hammering the form, and does nothing about a guesser who spreads attempts
 * across many addresses. This counts wrong passwords per account instead:
 * after `SIGN_IN_FAILURE_LIMIT` within `SIGN_IN_FAILURE_WINDOW_MS`, password
 * sign-in for that address pauses for `SIGN_IN_PAUSE_MS`, then clears on its
 * own. It is a cooldown, not a lockout: nobody has to unlock anything, a
 * password reset still works during it, and the owner is told when it starts.
 *
 * Counted per address whether or not an account exists, so the answer to
 * "is this address paused" says nothing about who has an account.
 *
 * Stored in the shared rate-limit table under a hash of the address, so the
 * table never holds the addresses people typed.
 */
export const SIGN_IN_FAILURE_LIMIT = 10;
export const SIGN_IN_FAILURE_WINDOW_MS = 15 * 60_000;
export const SIGN_IN_PAUSE_MS = 15 * 60_000;

const store = rateLimitStoreFor('sign-in-failure');

/** The bucket key for an address: trimmed, lower-cased and hashed. */
export function signInBrakeKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export type SignInPause = { paused: false } | { paused: true; retryAfterSeconds: number };

/** Whether password sign-in for this address is paused now, and for how much longer. */
export async function signInPause(email: string, now = Date.now()): Promise<SignInPause> {
  try {
    const bucket = await store.peek(signInBrakeKey(email));
    if (!bucket || bucket.hits < SIGN_IN_FAILURE_LIMIT) {
      return { paused: false };
    }
    return { paused: true, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt.getTime() - now) / 1000)) };
  } catch (error) {
    // A brake, not a gate: a counter outage must not stop everyone signing in.
    console.warn(`[sign-in-brake] could not read the failure count: ${error instanceof Error ? error.message : String(error)}`);
    return { paused: false };
  }
}

export interface SignInFailure {
  failures: number;
  /** True for the one failure that starts the pause, so it is reported once. */
  pausedNow: boolean;
}

/** Counts one wrong password for this address, and starts the pause on the failure that reaches the limit. */
export async function recordSignInFailure(email: string, now = Date.now()): Promise<SignInFailure | null> {
  const key = signInBrakeKey(email);
  try {
    const { totalHits } = await store.incrementWithWindow(key, now + SIGN_IN_FAILURE_WINDOW_MS);
    const pausedNow = totalHits === SIGN_IN_FAILURE_LIMIT;
    if (pausedNow) {
      // The pause runs its full length from now, not from whenever the first
      // of the ten happened to start the window.
      await store.extendTo(key, new Date(now + SIGN_IN_PAUSE_MS));
    }
    return { failures: totalHits, pausedNow };
  } catch (error) {
    console.warn(`[sign-in-brake] could not count a failed sign-in: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** A correct password clears the count, so ordinary typos never add up across days. */
export async function clearSignInFailures(email: string): Promise<void> {
  try {
    await store.resetKey(signInBrakeKey(email));
  } catch (error) {
    console.warn(`[sign-in-brake] could not clear the failure count: ${error instanceof Error ? error.message : String(error)}`);
  }
}
