import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const requestIdPattern = /^[A-Za-z0-9_-]{8,64}$/;

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
      request.originalUrl,
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
