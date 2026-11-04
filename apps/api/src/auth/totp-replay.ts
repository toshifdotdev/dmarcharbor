import { rateLimitStoreFor } from '../middleware/postgres-rate-limit-store.js';

/**
 * One use per authenticator code.
 *
 * The two-factor plugin accepts the code for the current 30-second step and
 * one step either side, and remembers nothing about codes it has accepted. So
 * a code read over someone's shoulder, or captured by a phishing page, signed
 * in a second time for up to a minute and a half. RFC 6238 section 5.2 says a
 * verifier must not accept the second attempt of a code after the first
 * succeeded.
 *
 * A code is claimed before the plugin checks it, with one atomic insert, so
 * two requests racing with the same code cannot both pass. A claim on a code
 * that turns out to be wrong is released afterwards, so a typo costs nothing.
 *
 * Claims live in the shared rate-limit table and expire after `CLAIM_MS`,
 * longer than any code stays valid (three steps of 30 seconds), and the
 * retention sweep removes them.
 */
const CLAIM_MS = 120_000;

const store = rateLimitStoreFor('totp-used');

/** Only a six-digit code is ever claimed; anything else is refused by the plugin anyway. */
export function claimableCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  return /^\d{6}$/.test(trimmed) ? trimmed : null;
}

function claimKey(userId: string, code: string): string {
  return `${userId}:${code}`;
}

/** True when this is the first use of the code for this user. */
export async function claimTotpCode(userId: string, code: string, now = Date.now()): Promise<boolean> {
  try {
    const { totalHits } = await store.incrementWithWindow(claimKey(userId, code), now + CLAIM_MS);
    return totalHits === 1;
  } catch (error) {
    // The plugin still checks the code itself; only the replay check is lost.
    console.warn(`[totp-replay] could not record a code: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

/** Frees a claim on a code the plugin refused, so the right code typed next still works. */
export async function releaseTotpCode(userId: string, code: string): Promise<void> {
  try {
    await store.resetKey(claimKey(userId, code));
  } catch (error) {
    console.warn(`[totp-replay] could not release a code: ${error instanceof Error ? error.message : String(error)}`);
  }
}
