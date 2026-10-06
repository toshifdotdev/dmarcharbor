/**
 * api-fetch.ts — the one place a call to the API is made from the web app.
 *
 * WHY THIS EXISTS
 *
 * Every caller used to call `fetch` directly, with no timeout and no AbortSignal.
 * That is invisible until the API is unreachable, at which point a server component
 * awaiting one of these has no deadline at all: the request hangs until undici gives
 * up on its own schedule, and the user watches a spinner on a page that will never
 * load. Observed exactly this while bringing the stack up - `/settings` and
 * `/settings/portal` sat for the better part of a minute with the API stopped, rather
 * than saying so.
 *
 * A timeout is not a nicety here. It is the difference between "the service is down,
 * here is what to do" and "this page is broken, forever, with no explanation".
 *
 * WHY NOT RETRY
 *
 * These are server components rendering a page. A retry makes the failure slower and
 * hides a real outage behind extra load. Writes are worse still: a retried POST that
 * succeeded the first time is a duplicate action, and the API is careful about that
 * (idempotency keys, conditional claims) precisely because it cannot undo them. If a
 * call times out, the caller decides whether repeating it is safe, and the default
 * everywhere is that it is not.
 *
 * The timeout is generous on purpose. The slowest thing this API does is build a
 * compliance pack PDF, and a report digest can walk a lot of rows. Cutting those off at
 * a second would turn a working feature into an intermittent failure, which is worse
 * than a slow page.
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.API_FETCH_TIMEOUT_MS ?? 15_000);

/** Longer for the calls that legitimately take a while. */
export const SLOW_API_TIMEOUT_MS = 45_000;

export class ApiTimeoutError extends Error {
  readonly path: string;
  readonly timeoutMs: number;

  constructor(path: string, timeoutMs: number) {
    super(
      `The API did not respond within ${Math.round(timeoutMs / 1000)}s. ` +
        "It may be starting up or overloaded. This is a problem with the service, not with your input.",
    );
    this.name = "ApiTimeoutError";
    this.path = path;
    this.timeoutMs = timeoutMs;
  }
}

export class ApiUnreachableError extends Error {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Could not reach the API at all (${detail}). ` +
        "It is probably not running. Check that the API process is up, then reload.",
    );
    this.name = "ApiUnreachableError";
    this.path = path;
    this.cause = cause;
  }
}

/**
 * fetch with a deadline, and an error that says which failure it was.
 *
 * The distinction is the point. A caller that catches `ApiTimeoutError` and a caller
 * that catches `ApiUnreachableError` can both fall back to something useful, and the
 * message reaches the operator instead of the browser console.
 *
 * `init.signal` is merged rather than replaced so a caller can still cancel for its
 * own reasons, such as a React render being discarded.
 */
export async function apiFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  /**
   * A caller who already aborted should stay aborted.
   *
   * Otherwise a caller passing its own signal would have it silently ignored, and a
   * request the caller had given up on would run to completion anyway.
   */
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } catch (cause) {
    /**
     * `AbortError` covers both our timeout and the caller's own abort, and they need
     * telling apart. Only our timer is ours to report.
     */
    if (cause instanceof Error && cause.name === "AbortError" && !signal?.aborted) {
      throw new ApiTimeoutError(url, timeoutMs);
    }
    throw new ApiUnreachableError(url, cause);
  } finally {
    clearTimeout(timer);
  }
}

/** The base every module was already computing for itself. */
export const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

/**
 * A message that is safe to show a user.
 *
 * Used by the error boundaries, which are rendered for an agency, so they must not
 * print a stack trace or an internal URL.
 */
export function describeApiFailure(error: unknown): string {
  if (error instanceof ApiTimeoutError || error instanceof ApiUnreachableError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong talking to the service.";
}