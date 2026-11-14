import { fromNodeHeaders } from 'better-auth/node';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { auth } from '../auth/auth.config.js';
import { workspaceIdFromPath, workspaceMfaRefusal } from './workspace-gates.js';

/**
 * Enforces a workspace's "require two-step verification" setting.
 *
 * A member who has neither an authenticator app nor an SSO session is refused
 * on that workspace's API. The alternative - hiding the controls in the browser
 * - would leave every route reachable to anyone who typed the URL or used the
 * API directly.
 *
 * This is the first layer. The workspace id is read from the path, because an
 * `app.use` middleware runs before the router that owns the params, and it is
 * decoded and matched without regard to case the way the router matches. The
 * permission middleware runs the same check again against the decoded route
 * parameter (workspace-gates.ts), which is what makes a spelling of the path
 * that this layer does not recognise unable to skip it. What was checked here
 * is recorded so that second check costs nothing in the normal case.
 *
 * Deliberately not applied to `/api/v1` (API keys are their own credential) or
 * to staff endpoints (the staff key is the credential there). Both paths lack a
 * workspace segment, so the first check skips them.
 */
export function requireWorkspaceMfa(): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const organizationId = workspaceIdFromPath(request.path);

    if (!organizationId) {
      // No workspace, or one the router will refuse to decode as well.
      next();
      return;
    }

    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      // Stored even when null so requireSession can reuse the answer instead of
      // reading the session twice on a refused or allowed workspace call.
      response.locals.sessionLookup = session;

      const refusal = await workspaceMfaRefusal(organizationId, session);
      if (refusal) {
        response.status(refusal.status).json(refusal.body);
        return;
      }
      response.locals.mfaCheckedFor = organizationId;
      next();
    } catch {
      // A workspace that cannot be read has no requirement to enforce. Treating
      // a lookup failure as "on" would lock every member out during a blip; the
      // route itself will fail if the database is truly unavailable.
      next();
    }
  };
}
