import type { NextFunction, Request, Response } from 'express';
import { EntitlementError } from '../services/entitlements/entitlement.service.js';
import { resolvePortalGrantsForEmail } from '../services/portal.service.js';

export class PortalAccessError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PortalAccessError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Turns the two error types the portal surface raises into responses. Mounted
 * globally, because a gated portal or a plan limit has to answer the same way
 * whether it was reached from a browser session or the API.
 */
export function portalErrorHandler(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  if (error instanceof PortalAccessError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }

  if (error instanceof EntitlementError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, ...error.details } });
    return;
  }

  next(error);
}

/**
 * Establishes the portal scope for a signed in client contact.
 *
 * A portal request carries no workspace in the path, because the contact does
 * not know or need to name the agency. The workspace and the clients they may
 * see are both resolved from the grants held for their email address. A contact
 * is not a member of the agency workspace, so every staff route already refuses
 * them and the portal is the only surface reachable.
 *
 * The client list is computed once here and every portal query filters by it, so
 * there is no route into the portal that skips the check and no way for a
 * contact to widen their own view by guessing an identifier.
 */
export async function requirePortalScope(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const user = response.locals.session?.user;

  if (!user?.email) {
    next(new PortalAccessError(401, 'UNAUTHORIZED', 'Sign in to view your report.'));
    return;
  }

  const grants = await resolvePortalGrantsForEmail(user.email);

  if (grants.length === 0) {
    next(
      new PortalAccessError(
        403,
        'FORBIDDEN',
        'This account has not been given access to a client report. Ask your provider for an invitation.',
      ),
    );
    return;
  }

  const organizations = new Set(grants.map((grant) => grant.organizationId ?? ''));
  const requested = typeof request.query.organizationId === 'string' ? request.query.organizationId : undefined;

  if (organizations.size > 1 && !requested) {
    next(
      new PortalAccessError(
        400,
        'INVALID_REQUEST',
        'This account has access in more than one workspace. Pass organizationId to say which one.',
      ),
    );
    return;
  }

  const organizationId = requested ?? grants[0]!.organizationId ?? '';
  const scoped = grants.filter((grant) => grant.organizationId === organizationId);
  const clientIds = [...new Set(scoped.map((grant) => grant.clientId))];

  if (clientIds.length === 0) {
    next(
      new PortalAccessError(
        403,
        'FORBIDDEN',
        'This account has not been given access to a client report in that workspace.',
      ),
    );
    return;
  }

  response.locals.organizationId = organizationId;
  response.locals.portalClientIds = clientIds;
  response.locals.portalGrants = scoped;
  next();
}

export function portalClientFilter(response: Response): { id: { in: string[] } } {
  return { id: { in: (response.locals.portalClientIds as string[]) ?? [] } };
}
