import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { presentsStaffKey } from './staff.middleware.js';
import { isDpaAcceptancePath, workspaceDpaRefusal, workspaceIdFromPath } from './workspace-gates.js';

/**
 * Refuses a workspace operating under a superseded agreement.
 *
 * `dpaAcceptanceFor` already computed `requiresReconsent`, and nothing read it.
 * That is not a cosmetic gap: the only thing standing between the business and
 * a data processing agreement it published without anyone agreeing to it was a
 * field on a record the API served and nobody was required to look at. When the
 * agreement's substance changes, every workspace that accepted the old one is
 * out of date, and they stayed out of date for good.
 *
 * This is the first layer, mounted once ahead of the workspace routers. It
 * reads the workspace from the path (decoded, without regard to case, as the
 * router matches it), because `request.params` is not visible to an `app.use`.
 * The permission middleware repeats the check against the route's own decoded
 * parameter, which also covers the routers mounted ahead of this one.
 *
 * Two kinds of request pass regardless: the route that records the new
 * acceptance (refusing it would make the condition impossible to clear), and
 * support's staff-key routes, which act on a workspace on its behalf (a refund
 * must not wait for the customer to re-accept an agreement).
 */
export function requireCurrentDpa(): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (isDpaAcceptancePath(request.path) || presentsStaffKey(request)) {
      next();
      return;
    }

    const organizationId = workspaceIdFromPath(request.path);
    if (!organizationId) {
      next();
      return;
    }

    try {
      const refusal = await workspaceDpaRefusal(organizationId);
      if (refusal) {
        response.status(refusal.status).json(refusal.body);
        return;
      }

      response.locals.dpaCheckedFor = organizationId;
      next();
    } catch {
      // A workspace that cannot be read has no acceptance to check, and that is
      // the organisation permission middleware's call to make rather than this
      // one's: treating a missing row as a superseded agreement would turn a typo
      // in a path into a contract dispute.
      next();
    }
  };
}
