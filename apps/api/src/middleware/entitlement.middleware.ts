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
