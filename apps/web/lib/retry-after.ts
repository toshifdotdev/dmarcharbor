/**
 * retry-after.ts — how long a rate-limited caller should wait, in words.
 *
 * The API's limiter sends `Retry-After` (seconds until its window resets) on
 * every 429, and Better Auth's own limiter sends the same figure as
 * `X-Retry-After`. Either can be missing, so every sentence here has a
 * no-figure form that still says to wait: a 429 is never a permanent refusal,
 * and nothing built from this may read like one.
 */

/** Seconds from a `Retry-After` value (delta-seconds or an HTTP date), or null. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let seconds: number;
  if (/^\d+$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return null;
    seconds = Math.ceil((at - now) / 1000);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  // A day is the longest wait any limiter here uses; anything beyond is noise.
  return Math.min(seconds, 86_400);
}

/** The wait read off a response's headers, whichever limiter answered. */
export function retryAfterFrom(headers: Headers): number | null {
  return parseRetryAfter(headers.get("retry-after")) ?? parseRetryAfter(headers.get("x-retry-after"));
}

/**
 * "Wait a minute, then try again." and its longer forms. Rounded up, because
 * telling someone to come back before the window resets only earns a second
 * refusal.
 */
export function retryAfterText(seconds: number | null | undefined, then: string = "try again"): string {
  if (!seconds || seconds <= 60) return `Wait a minute, then ${then}.`;
  if (seconds < 3600) {
    const minutes = Math.ceil(seconds / 60);
    return `Wait about ${minutes} minutes, then ${then}.`;
  }
  const hours = Math.ceil(seconds / 3600);
  return hours === 1 ? `Wait about an hour, then ${then}.` : `Wait about ${hours} hours, then ${then}.`;
}
