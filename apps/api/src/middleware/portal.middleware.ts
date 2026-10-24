import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../database/prisma.js';
import { EntitlementError, resolveEntitlements } from '../services/entitlements/entitlement.service.js';
import { resolvePortalGrantsForEmail } from '../services/portal.service.js';

export class PortalAccessError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PortalAccessError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Turns the two error types the portal surface raises into responses. Mounted
 * globally, because a gated portal or a plan limit has to answer the same way
 * whether it was reached from a browser session or the API.
 */
export function portalErrorHandler(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  if (error instanceof PortalAccessError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, ...error.details } });
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
    // The choices travel with the refusal, so the contact can pick one rather
    // than being told to pass an identifier they have never seen.
    const rows = await prisma.organization.findMany({
      where: { id: { in: [...organizations].filter(Boolean) } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    next(
      new PortalAccessError(
        400,
        'CHOOSE_WORKSPACE',
        'This account has access through more than one provider. Choose which one to open.',
        {
          workspaces: rows.map((org) => ({
            organizationId: org.id,
            name: org.name,
            clients: grants.filter((grant) => grant.organizationId === org.id).map((grant) => grant.clientName),
          })),
        },
      ),
    );
    return;
  }

  if (requested && !organizations.has(requested)) {
    next(new PortalAccessError(403, 'FORBIDDEN', 'This account has not been given access to a client report in that workspace.'));
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

  /**
   * The plan is checked on every read, not only when a grant is created.
   *
   * It used to be checked only at grant time, so a workspace that dropped to a
   * plan without the portal kept serving every contact it had already invited.
   * Now the portal pauses instead: the grants are kept (nothing to set up again
   * after an upgrade, and the agency can still list and revoke them), and the
   * contact is told the report is paused. The contact is the agency's client,
   * not our customer, so the answer names the provider and never the plan.
   */
  const entitlements = await resolveEntitlements(organizationId);
  if (!entitlements.features['portal.client']) {
    const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
    next(
      new PortalAccessError(
        403,
        'PORTAL_PAUSED',
        `${organization?.name ?? 'Your provider'} has paused this report. Your access is kept, and the report comes back when they turn it on again.`,
        { workspaceName: organization?.name ?? null },
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
