import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { touchApiKey, verifyApiKey, type ApiScope } from '../services/api-key.service.js';
import { EntitlementError, assertFeature } from '../services/entitlements/entitlement.service.js';

export class ApiAuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiAuthError';
    this.status = status;
    this.code = code;
  }
}

function presentedKey(request: Request): string | null {
  const header = request.header('authorization');
  if (!header) {
    return null;
  }
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') {
    return null;
  }
  return value.trim();
}

/**
 * The workspace is taken from the key rather than the path on purpose. A
 * separate identifier would let an integration point a valid key at another
 * workspace path, and that class of bug is worth designing out.
 */
export function requireApiKey(scope: ApiScope = 'read') {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const presented = presentedKey(request);

    if (!presented) {
      response.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Provide an API key in the Authorization header as a bearer token.',
        },
      });
      return;
    }

    const key = await verifyApiKey(presented);

    if (!key) {
      response.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'That API key is invalid, revoked or expired.' },
      });
      return;
    }

    if (!key.scopes.includes(scope)) {
      response.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `This key is scoped to ${key.scopes.join(' and ')} and cannot perform that action.`,
        },
      });
      return;
    }

    // Checked on every request, not only when the key is issued. A key minted
    // on a paid plan stays cryptographically valid forever, so without this a
    // workspace that downgrades would keep the full API indefinitely.
    try {
      await assertFeature(key.organizationId, 'api.access');
    } catch (error) {
      if (error instanceof EntitlementError) {
        response.status(error.status).json({
          error: { code: error.code, message: error.message, ...error.details },
        });
        return;
      }
      throw error;
    }

    response.locals.organizationId = key.organizationId;
    response.locals.apiKeyId = key.id;
    response.locals.apiKeyScopes = key.scopes;

    await touchApiKey(key.id, request.ip ?? null);
    next();
  };
}

export function apiKeyFingerprint(request: Request): string {
  const organizationId = String(response_locals_organization(request) ?? '');
  const body = JSON.stringify(request.body ?? {});
  return createHash('sha256').update(`${organizationId}:${request.method}:${request.originalUrl}:${body}`).digest('hex');
}

function response_locals_organization(request: Request): unknown {
  return (request.res?.locals as { organizationId?: string } | undefined)?.organizationId;
}

export function idempotencyKeyFrom(request: Request): string | undefined {
  const header = request.header('idempotency-key');
  return header?.trim() || undefined;
}
