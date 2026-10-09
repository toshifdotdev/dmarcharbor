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
  sendError(response, 500, 'The request could not be completed.');
}
