import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const requestIdPattern = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Removes bearer credentials from a URL before it is written to the log stream.
 *
 * Two routes carry a live secret in the URL itself, and every view of either one
 * would otherwise write that secret to disk on every hit:
 *
 *   - `/api/reports/share/<token>`, valid up to 365 days
 *   - `/api/exports/<id>/download?token=<token>`, valid 7 days
 *
 * Log aggregation is usually a wider blast radius than the application itself:
 * whoever can read the log store can then open the customer's report with a
 * credential that is still valid, and neither the workspace nor the recipient
 * ever learns it was read. The token is replaced with a marker so an operator
 * can still see that a share was hit and correlate the request id, without the
 * log becoming the leak.
 *
 * A public Trust Center slug is deliberately left alone. It is not a secret: it
 * is the customer's published address, intended to be shared, and redacting it
 * would remove the only way to trace a complaint about that page.
 */
export function redactUrlSecrets(originalUrl: string): string {
  // Query credentials, in any casing, before the query string is even split.
  const queryRedacted = originalUrl.replace(/([?&](?:token|access_token|download_token)=)[^&#]*/gi, '$1[redacted]');

  // Path credentials: the segment following a `share` segment.
  return queryRedacted.replace(/(\/share\/)[^/?#]+/gi, '$1[redacted]');
}

export function resolveRequestId(header: string | undefined): string {
  if (header && requestIdPattern.test(header)) {
    return header;
  }

  return randomUUID();
}

export function requestContext(request: Request, response: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  const requestId = resolveRequestId(request.header('x-request-id'));

  response.locals.requestId = requestId;
  response.setHeader('X-Request-Id', requestId);

  response.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const line = [
      `[request] ${requestId}`,
      request.method,
      redactUrlSecrets(request.originalUrl),
      String(response.statusCode),
      `${durationMs.toFixed(1)}ms`,
    ].join(' ');

    if (response.statusCode >= 500) {
      console.error(line);
      return;
    }

    if (response.statusCode >= 400) {
      console.warn(line);
      return;
    }

    console.info(line);
  });

  next();
}
