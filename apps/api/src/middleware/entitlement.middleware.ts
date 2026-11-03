import type { NextFunction, Request, Response } from 'express';
import { EntitlementError, assertFeature, assertQuota } from '../services/entitlements/entitlement.service.js';
import type { EntitlementKey, QuotaKey } from '../services/entitlements/plan-catalog.js';

function send(response: Response, error: EntitlementError): void {
  response.status(402).json({
    error: {
      code: error.code,
      message: error.message,
      ...error.details,
    },
  });
}

export function requireFeature(feature: EntitlementKey) {
  return async (_request: Request, response: Response, next: NextFunction): Promise<void> => {
    const organizationId = response.locals.organizationId as string | undefined;

    if (!organizationId) {
      send(response, new EntitlementError('FEATURE_NOT_IN_PLAN', 'Workspace context is required.', { feature }));
      return;
    }

    try {
      await assertFeature(organizationId, feature);
      next();
    } catch (error) {
      if (error instanceof EntitlementError) {
        send(response, error);
        return;
      }
      throw error;
    }
  };
}

/**
 * `requireFeature`, except for a request that only switches something off.
 *
 * Pausing something kept from a paid plan has to work on every plan, the same
 * way removing it does: a workspace that downgraded must always be able to stop
 * a destination or a digest it set up, and only starting it again, or changing
 * it, is the paid feature. The path cannot tell those apart, only the body can,
 * so the caller names which requests are the "off" ones.
 *
 * The webhook controller makes the same distinction in its own code; this is
 * the route-level form for the routes whose controller does not.
 */
export function requireFeatureUnless(feature: EntitlementKey, exempt: (request: Request) => boolean) {
  const gate = requireFeature(feature);
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (exempt(request)) {
      next();
      return;
    }
    await gate(request, response, next);
  };
}

/**
 * True for a body that turns something off and asks for nothing else.
 *
 * `{ enabled: false }` and nothing beside it. A body that pauses and edits in
 * the same request is an edit, and an edit is the paid feature.
 */
export function onlyDisables(request: Request): boolean {
  const body = request.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }
  return body.enabled === false && Object.keys(body).every((key) => key === 'enabled');
}

export function requireQuota(quota: QuotaKey, requested = 1) {
  return async (_request: Request, response: Response, next: NextFunction): Promise<void> => {
    const organizationId = response.locals.organizationId as string | undefined;

    if (!organizationId) {
      send(response, new EntitlementError('PLAN_LIMIT_REACHED', 'Workspace context is required.', { quota }));
      return;
    }

    try {
      await assertQuota(organizationId, quota, requested);
      next();
    } catch (error) {
      if (error instanceof EntitlementError) {
        send(response, error);
        return;
      }
      throw error;
    }
  };
}
