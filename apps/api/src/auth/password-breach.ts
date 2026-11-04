import { createHash } from 'node:crypto';

/**
 * Have I Been Pwned's range API, for new passwords.
 *
 * Only the first five characters of the password's SHA-1 hash leave this
 * process (k-anonymity); the service answers with every suffix it holds under
 * that prefix, and the match is made here. `Add-Padding` asks it to pad the
 * answer with zero-count entries so the response size says nothing either.
 *
 * Better Auth ships a plugin for this, and it fails closed: when the service is
 * slow or down, every sign-up and password reset fails with a 500. This fails
 * open instead, with a log line, because a third-party outage must not stop
 * someone getting back into their account. The length rule still applies.
 *
 * @see https://haveibeenpwned.com/API/v3#PwnedPasswords
 */
export const PWNED_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 3_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The SHA-1 of a password as the range API uses it: upper-case hex, split after five characters. */
export function pwnedHashParts(password: string): { prefix: string; suffix: string } {
  const hash = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  return { prefix: hash.slice(0, 5), suffix: hash.slice(5) };
}

/** The count listed for a suffix in a range response, or zero when it is not listed. */
export function countInRange(body: string, suffix: string): number {
  const wanted = suffix.toUpperCase();
  for (const line of body.split(/\r?\n/)) {
    const [lineSuffix, count] = line.trim().split(':');
    if (lineSuffix?.toUpperCase() === wanted) {
      const parsed = Number(count);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
    }
  }
  return 0;
}

/**
 * How many breaches list this password, or null when it could not be checked
 * (network failure, timeout, an answer that was not a range list).
 */
export async function passwordBreachCount(password: string, fetchImpl: FetchLike = fetch): Promise<number | null> {
  const { prefix, suffix } = pwnedHashParts(password);
  try {
    const response = await fetchImpl(`${PWNED_RANGE_URL}${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'DMARC-Harbor-password-check' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[password-breach] range lookup answered ${response.status}; the password was not checked.`);
      return null;
    }
    return countInRange(await response.text(), suffix);
  } catch (error) {
    console.warn(`[password-breach] range lookup failed; the password was not checked: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
