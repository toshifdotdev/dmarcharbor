import { Router } from 'express';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import {
  DpaAcceptanceError,
  dpaAcceptanceFor,
  recordDpaAcceptance,
} from '../services/dpa-acceptance.service.js';

/**
 * Data Processing Agreement acceptance.
 *
 * Separate from entitlements even though it gates the workspace, because the two
 * answer different questions: an entitlement is what a plan pays for, an
 * acceptance is what an organisation agreed to.
 */
export const dpaRouter = Router();

/** What has been accepted, and whether what is on file is still the current version. */
dpaRouter.get(
  '/workspaces/:organizationId/dpa-acceptance',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  async (request, response) => {
    response.json(await dpaAcceptanceFor(request.params.organizationId as string));
  },
);

/**
 * Record acceptance.
 *
 * Both confirmations are required. The second is the one that matters: an employee
 * creating a workspace has not been authorised by their firm to accept a data
 * processing agreement on its behalf.
 */
dpaRouter.post(
  '/workspaces/:organizationId/dpa-acceptance',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  async (request, response) => {
    const body = request.body as {
      hasRead?: boolean;
      confirmsAuthority?: boolean;
    };

    try {
      const sessionUser = response.locals.session?.user as
        | { id?: string; email?: string }
        | undefined;

      response.json(
        await recordDpaAcceptance({
          organizationId: request.params.organizationId as string,
          actorUserId: sessionUser?.id ?? null,
          actorEmail: sessionUser?.email ?? 'unknown',
          hasRead: body.hasRead === true,
          confirmsAuthority: body.confirmsAuthority === true,
          ipAddress: request.ip ?? null,
        }),
      );
    } catch (error) {
      if (error instanceof DpaAcceptanceError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      throw error;
    }
  },
);

/** Kept separate: RFC 9116 requires this at the host root, not under /api. */
export const wellKnownRouter = Router();

wellKnownRouter.get('/.well-known/security.txt', (_request, response) => {
  const lines = [
    'Contact: mailto:security@dmarcharbor.com',
    'Expires: ' + new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    'Preferred-Languages: en',
    'Canonical: https://dmarcharbor.com/.well-known/security.txt',
    'Policy: https://dmarcharbor.com/legal/security',
  ];

  response.type('text/plain; charset=utf-8').send(`${lines.join('\n')}\n`);
});