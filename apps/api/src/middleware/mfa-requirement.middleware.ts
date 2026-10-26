import { fromNodeHeaders } from 'better-auth/node';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { auth } from '../auth/auth.config.js';
import { prisma } from '../database/prisma.js';

/**
 * Workspace id out of a request.
 *
 * Read from the path, not `request.params`: an `app.use` middleware runs before
 * the router that owns the params. The DPA gate uses the same approach for the
 * same reason, and both must see the id the route is about to match.
 */
const WORKSPACE_PATH = /\/workspaces\/([^/]+)/;

/**
 * Enforces a workspace's "require two-step verification" setting.
 *
 * A member who has neither an authenticator app nor an SSO session is refused
 * on that workspace's API. The alternative - hiding the controls in the browser
 * - would leave every route reachable to anyone who typed the URL or used the
 * API directly.
 *
 * Deliberately not applied to `/api/v1` (API keys are their own credential) or
 * to staff endpoints (the staff key is the credential there). Both paths lack a
 * workspace segment, so the first check skips them.
 */
export function requireWorkspaceMfa(): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const organizationId = WORKSPACE_PATH.exec(request.path)?.[1];

    if (!organizationId) {
      next();
      return;
    }

    try {
      // One primary-key read keeps the setting free for the workspaces that do
      // not use it. The session is only read when the setting is on.
      const organization = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { name: true, requireMfa: true },
      });

      if (!organization?.requireMfa) {
        next();
        return;
      }

      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      // Stored even when null so requireSession can reuse the answer instead of
      // reading the session twice on a refused or allowed workspace call.
      response.locals.sessionLookup = session;

      if (!session) {
        // The route's own middleware answers 401. Refusing here would turn an
        // unauthenticated request into a misleading MFA error.
        next();
        return;
      }

      const member = await prisma.member.findUnique({
        where: { organizationId_userId: { organizationId, userId: session.user.id } },
        select: { role: true },
      });

      if (!member) {
        // Not a member: the permission middleware owns that answer.
        next();
        return;
      }

      if (member.role === 'portal') {
        // Client contacts are not agency staff and are never asked to enrol.
        next();
        return;
      }

      if (session.user.twoFactorEnabled || session.session.authMethod === 'sso') {
        next();
        return;
      }

      response.status(403).json({
        error: {
          code: 'MFA_REQUIRED',
          message: `${organization.name} requires two-step verification. Turn it on for your account to continue.`,
          workspaceName: organization.name,
          setupUrl: '/account/security',
        },
      });
    } catch {
      // A workspace that cannot be read has no requirement to enforce. Treating
      // a lookup failure as "on" would lock every member out during a blip; the
      // route itself will fail if the database is truly unavailable.
      next();
    }
  };
}
