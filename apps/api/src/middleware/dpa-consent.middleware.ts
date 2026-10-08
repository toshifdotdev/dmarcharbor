import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { dpaAcceptanceFor } from '../services/dpa-acceptance.service.js';

/**
 * Workspace id out of a request.
 *
 * `request.params` is not readable from an `app.use` middleware, because a
 * route's params are populated by the router that matches it and that runs
 * afterwards. `response.locals.organizationId` is set by
 * `requireOrganizationPermission` inside the router, and so is also later.
 *
 * The path is the one thing ahead of both, and it carries the same identifier the
 * router is about to match on, so matching it here gives the same workspace the
 * route would. Guarding on it also means the middleware is inert for every
 * non-workspace path, which is what keeps a single global mount safe.
 */
const WORKSPACE_PATH = /\/workspaces\/([^/]+)/;

/**
 * The route that reports the acceptance state has to answer, not refuse.
 *
 * It is what the interface reads to decide whether to show the banner, and it is
 * also how the version gap is discovered at all. Refusing it with the condition
 * it exists to report would hide the very thing that needs surfacing, and would
 * leave a client seeing a 409 with no way to learn which version is on file.
 */
const ACCEPTANCE_PATH = /^\/workspaces\/[^/]+\/dpa-acceptance\/?$/;

function workspaceIdFrom(request: Request): string | null {
  if (ACCEPTANCE_PATH.test(request.path)) {
    return null;
  }
  const matched = WORKSPACE_PATH.exec(request.path);
  return matched?.[1] ?? null;
}

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
 * Mounted once, ahead of the workspace routers, and it is safe there only
 * because it reads the path rather than `request.params` - which an `app.use`
 * cannot see - and because it is inert for any path without a workspace in it.
 * It refuses every workspace-scoped request whose acceptance names an older
 * version, writes included, which is what makes it enforcement rather than
 * reporting.
 *
 * `dpaRouter` is mounted after it so the route that records the acceptance stays
 * reachable. Mounting it before instead would refuse the one route able to clear
 * the very condition it is complaining about.
 */
export function requireCurrentDpa(): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const organizationId = workspaceIdFrom(request);

    if (!organizationId) {
      next();
      return;
    }

    try {
      const acceptance = await dpaAcceptanceFor(organizationId);

      if (acceptance.requiresReconsent) {
        response.status(409).json({
          error: {
            code: 'DPA_RECONSENT_REQUIRED',
            message: 'The Data Processing Agreement has changed and needs to be accepted again.',
            dpaUrl: acceptance.dpaUrl,
            acceptedVersion: acceptance.version,
            currentVersion: acceptance.currentVersion,
          },
        });
        return;
      }

      response.locals.dpaAcceptance = acceptance;
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
