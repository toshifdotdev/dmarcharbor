import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../utils/api-error.js';

/**
 * The last handler, and the one that was missing.
 *
 * Without it, an unexpected error went to Express's own finalhandler: a
 * `text/plain "Internal Server Error"` instead of this API's
 * `{ error: { code, message } }` envelope, and no log line beyond the request
 * status line that the request-context middleware already writes. A tenant
 * reporting "the clients page is broken" left nothing in the logs to act on,
 * and every `/api/v1` integration broke on a 500 because it could not parse the
 * body.
 *
 * Mounted after every router, including the last three, which the previous
 * arrangement skipped: `portalErrorHandler` sat above `apiV1Router`,
 * `domainScanRouter` and `scanRouter`, so errors raised inside those never
 * reached even that one.
 *
 * The detail is deliberately not in the response. A Prisma driver error carries
 * the host, port and database name, and a statement fragment under some
 * failures, which is exactly what the production guards in config/env.ts exist to
 * keep off the wire. It is logged with the request id instead, so the one line
 * that identifies the tenant's request is the line that carries the reason.
 */
/**
 * The status a thrown error should be answered with.
 *
 * `body-parser` and `raw-body` throw errors that describe the CLIENT's mistake,
 * not ours, and they carry that on the object: `entity.parse.failed` for
 * malformed JSON, `entity.too.large` for an oversized body. Both set
 * `statusCode: 400`/`413` and `expose: true`.
 *
 * Answering those with a 500 is a real defect, and it was the one found while
 * testing `POST /api/v1/clients`. A client that sends unquoted JSON keys gets
 * `INTERNAL` — which reads as our bug rather than theirs, makes error-rate
 * monitoring useless because every malformed request counts as a server
 * failure, and is reachable without any credential at all, so an unauthenticated
 * caller can generate 500s at will.
 *
 * `expose` is the gate, and it is exactly what Express's own `finalhandler`
 * reads: a library that sets it has declared the message safe to send. Anything
 * without it stays a 500, which keeps a Prisma driver error — host, port,
 * database name, statement fragment — off the wire.
 *
 * The status is clamped to the 4xx range even when exposed. A 5xx carrying
 * `expose: true` would put a server-side detail on the wire, which is the
 * opposite of what the flag is for.
 */
export function statusForThrown(error: unknown): number {
  const candidate = error as {
    expose?: boolean;
    statusCode?: unknown;
    status?: unknown;
  } | null;

  if (!candidate || candidate.expose !== true) return 500;

  const raw = typeof candidate.statusCode === 'number'
    ? candidate.statusCode
    : typeof candidate.status === 'number'
      ? candidate.status
      : undefined;

  if (raw === undefined) return 500;
  if (raw < 400 || raw > 499) return 500;
  return Math.trunc(raw);
}

/**
 * The message for an exposed 4xx.
 *
 * `body-parser`'s own message is specific and safe — "Expected property name or
 * '}' in JSON at position 1" — and it is what a client needs to fix their
 * payload. It is preferred over a generic one where it exists, because
 * "invalid request" sends them looking for a bug in our code.
 */
export function messageForThrown(error: unknown): string {
  const candidate = error as { message?: unknown } | null;
  const message = typeof candidate?.message === 'string' ? candidate.message.trim() : '';
  return message.length > 0 && message.length <= 300 ? message : 'The request could not be parsed.';
}

export function globalErrorHandler(
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  // A response already started cannot be reshaped; handing it to Express lets the
  // socket be torn down cleanly rather than throwing a second error on the way out.
  if (response.headersSent) {
    next(error);
    return;
  }

  const requestId = response.locals.requestId as string | undefined;
  const label = requestId ? `[error] ${requestId}` : '[error]';

  console.error(`${label} ${request.method} ${request.originalUrl} threw:`, error);

  // Router-level 404s are handled by an explicit catch-all before this, so
  // reaching here always means an error, not a missing route.
  const status = statusForThrown(error);
  sendError(
    response,
    status,
    status === 500 ? 'The request could not be completed.' : messageForThrown(error),
  );
}
