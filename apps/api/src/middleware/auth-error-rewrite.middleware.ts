import type { NextFunction, Request, Response } from 'express';

/**
 * auth-error-rewrite.ts — what Better Auth's own failures say.
 *
 * Better Auth 1.7.6 has no `onAPIError` hook, so its validation failures reach
 * the browser as its internal strings. Two of them are on the sign-up form:
 *
 *   [body.email] Invalid email address
 *   [body.name] Invalid input: expected string, received undefined
 *
 * The first leaks the request-body path, the second is Zod's generator
 * phrasing. Both are rendered verbatim, because they arrive as `message` in the
 * JSON body and that is what every form shows.
 *
 * WHY THIS PATCHES `write` AND `end`, AND NOT `json`.
 *
 * Three attempts were made and the first two are recorded here because each
 * one looked right and quietly did nothing:
 *
 * 1. Wrapping `res.json` — never called. `better-call`'s node adapter, which is
 *    what `toNodeHandler` compiles to, sets headers with `setHeader`, calls
 *    `writeHead(status)`, then streams the body. Its tests all passed.
 * 2. Patching `res.end` — also missed, because the adapter streams the body
 *    through `res.write(chunk)` in a loop and calls `res.end()` with no
 *    argument at all.
 * 3. Patching `res.write`, which is where the body actually goes.
 *
 * All three are patched below: `write` for the streaming path the library uses,
 * `end` for the one-shot `end(body)` form that a hand-written handler uses.
 *
 * Both are restored with `delete` so the prototype method is looked up again
 * rather than shadowed by a bound copy, and both are restored after an async
 * handler has settled rather than when its call returns — the adapter is async,
 * and a `finally` around the call removes the patch before the response is
 * written, which is a failure no synchronous test can see.
 *
 * Three things it deliberately does NOT do:
 *
 * 1. It never rewrites a better-auth message that is already prose. "Invalid
 *    email or password" is the anti-enumeration answer and must stay exactly as
 *    it is, because the wrong-password path and the unknown-account path give
 *    the same sentence on purpose.
 * 2. It never adds detail. A refusal that says nothing, in order not to
 *    disclose whether an address exists, must keep saying nothing.
 * 3. It never touches a status code, a header, or a body that is not JSON.
 */

/** The messages we restate, and what they become. */
const REWRITES: Array<{ match: RegExp; say: string }> = [
  {
    // A malformed email, on sign-up and on any other email-bearing form.
    match: /^\[body\.email\]\s*Invalid email address\.?$/i,
    say: 'Enter an email address we can send to.',
  },
  {
    // A field that is missing entirely. The body path is dropped: the operator
    // is looking at the field, not at the request body.
    match: /^\[body\.(\w+)\]\s*Invalid input: expected (\w+), received (\w+)/i,
    say: 'Fill in this field.',
  },
  {
    // A field that failed its own check with no readable reason.
    match: /^\[body\.(\w+)\]\s*(.+)$/i,
    say: 'Check this field and try again.',
  },
];

/** The replacement for a message, or null when it is not ours to restate. */
function rewriteMessage(message: string): string | null {
  const trimmed = message.trim();
  for (const rule of REWRITES) {
    if (rule.match.test(trimmed)) return rule.say;
  }
  return null;
}

/**
 * Rewrites the message inside a JSON payload, leaving everything else alone.
 *
 * Returns the payload unchanged when it is not JSON, when it has no `message`
 * string, or when the message is not one of the patterns above. The last of
 * those is the important one: a better-auth sentence that is already prose must
 * survive byte-for-byte.
 */
function rewriteBody(raw: string): string {
  if (!raw.trimStart().startsWith('{')) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }

  if (!parsed || typeof parsed !== 'object') return raw;
  const message = (parsed as Record<string, unknown>).message;
  if (typeof message !== 'string') return raw;

  const replacement = rewriteMessage(message);
  if (!replacement) return raw;

  (parsed as Record<string, unknown>).message = replacement;
  return JSON.stringify(parsed);
}

/**
 * A write chunk as text, or null when it is not text we should look at.
 *
 * The body arrives as a `Uint8Array`, NOT a Node `Buffer`. `Buffer.isBuffer` is
 * false for a plain `Uint8Array` — a Buffer is a `Uint8Array` subclass, but the
 * reverse is not true — so a check for Buffer alone silently passes the body
 * through untouched, which is how this wrapper failed for a third time while
 * every unit test, which wrote strings, still passed.
 *
 * Any `ArrayBufferView` is accepted and decoded as UTF-8. That covers Buffer,
 * Uint8Array, and the other typed arrays, and it is the same decoding
 * `better-call` itself relies on when it hands the body to the stream.
 */
function chunkToString(chunk: unknown): string | null {
  if (typeof chunk === 'string') return chunk;

  if (ArrayBuffer.isView(chunk)) {
    const view = chunk as ArrayBufferView;
    try {
      return new TextDecoder('utf-8').decode(view);
    } catch {
      return null;
    }
  }

  if (chunk instanceof ArrayBuffer) {
    try {
      return new TextDecoder('utf-8').decode(new Uint8Array(chunk));
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Wraps the Better Auth handler so its JSON error bodies carry readable
 * messages, by patching the writes the library actually performs.
 */
export function withReadableAuthErrors(
  handler: (request: Request, response: Response, next: NextFunction) => void,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);
    let done = false;

    // Returns the body to write, rewriting it at most once. `done` guards
    // against a chunk that already went out being parsed a second time, which
    // would be a body written twice.
    const bodyToWrite = (chunk: unknown): unknown => {
      if (done) return chunk;
      const raw = chunkToString(chunk);
      if (raw === null) return chunk;
      const rewritten = rewriteBody(raw);
      if (rewritten === raw) return chunk;
      console.log('[auth-rewrite] rewriting body');
      done = true;
      return rewritten;
    };

    response.write = ((chunk: unknown, ...rest: unknown[]) =>
      (originalWrite as (c: unknown, ...r: unknown[]) => boolean)(bodyToWrite(chunk), ...rest)) as Response['write'];

    response.end = ((chunk?: unknown, ...rest: unknown[]) =>
      (originalEnd as (c: unknown, ...r: unknown[]) => unknown)(bodyToWrite(chunk), ...rest)) as Response['end'];

    const restore = () => {
      delete (response as unknown as Record<string, unknown>).write;
      delete (response as unknown as Record<string, unknown>).end;
    };

    let outcome: unknown;
    try {
      outcome = handler(request, response, next);
    } catch (error) {
      restore();
      throw error;
    }

    if (outcome && typeof (outcome as Promise<unknown>).then === 'function') {
      // Rejections stay unhandled: swallowing them would hide an auth failure.
      (outcome as Promise<unknown>).then(restore, restore);
      // Returned so a caller that wants to await the response can. Express
      // ignores a route handler's return value, so this changes nothing there.
      return outcome as unknown as void;
    }

    restore();
    return undefined;
  };
}
