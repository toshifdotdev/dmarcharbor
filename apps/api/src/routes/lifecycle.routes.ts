import { Router, type Request, type Response } from 'express';
import { deleteClient, deleteDomain, deleteWorkspace, summariseWorkspace } from '../services/lifecycle-deletion.service.js';
import { prisma } from '../database/prisma.js';
import { managedSpfRepublish } from '../services/hosted-dns/managed-spf.service.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { requireSession } from '../middleware/auth.middleware.js';

/**
 * Deleting what was created.
 *
 * Three routes, one per scope, because the three scopes have different
 * permissions, different consequences and different confirmations. Collapsing
 * them into one `/delete` endpoint with a `kind` parameter would put the
 * authorization decision in the request body, which is where it is easiest to
 * get wrong.
 *
 * A GET preview exists for the workspace so the confirmation can show real
 * numbers. Reading what would be destroyed is not the same right as destroying
 * it, so the preview takes `organization: read` and the delete takes
 * `organization: update`.
 */

export const lifecycleRouter = Router();

const organizationId = (request: Request) => String(request.params.organizationId);

lifecycleRouter.delete(
  '/workspaces/:organizationId/domains/:domainId',
  requireSession,
  // `domain: delete` is already declared in the permissions statement, so no
  // schema change was needed: the right existed and nothing used it.
  requireOrganizationPermission('domain', 'delete'),
  async (request: Request, response: Response) => {
    const result = await deleteDomain(
      organizationId(request),
      String(request.params.domainId),
      response.locals.session?.user?.id,
    );

    if (!result.ok) {
      response.status(404).json({ error: { message: 'That domain is not in this workspace.' } });
      return;
    }

    // The counts travel with the response so the UI can confirm what went, not
    // only what was asked for.
    response.json({ deleted: result.name, summary: result.summary });
  },
);

lifecycleRouter.delete(
  '/workspaces/:organizationId/clients/:clientId',
  requireSession,
  requireOrganizationPermission('client', 'delete'),
  async (request: Request, response: Response) => {
    const result = await deleteClient(
      organizationId(request),
      String(request.params.clientId),
      response.locals.session?.user?.id,
    );

    if (!result.ok) {
      if (result.reason === 'has_portal_access') {
        // The one refusal that names what to do next. A client contact still
        // holds a Trust Center link, and deleting underneath it would leave them
        // with a dead one.
        response.status(409).json({
          error: {
            code: 'PORTAL_ACCESS_STILL_GRANTED',
            message: 'Revoke this client\'s portal access before deleting them. Their contact is holding a working link to the Trust Center.',
          },
        });
        return;
      }
      response.status(404).json({ error: { message: 'That client is not in this workspace.' } });
      return;
    }

    response.json({ deleted: result.name, summary: result.summary });
  },
);

lifecycleRouter.get(
  '/workspaces/:organizationId/deletion-preview',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  async (request: Request, response: Response) => {
    const organizationIdValue = organizationId(request);
    const clientId = typeof request.query.clientId === 'string' ? request.query.clientId : null;
    const [summary, hosted, spf] = await Promise.all([
      summariseWorkspace(organizationIdValue),
      prisma.hostedDmarcRecord.findMany({
        where: {
          organizationId: organizationIdValue,
          status: { not: 'RELEASED' },
          ...(clientId ? { domain: { clientId } } : {}),
        },
        select: { value: true, domain: { select: { name: true } } },
        orderBy: { domain: { name: 'asc' } },
      }),
      prisma.hostedSpfRecord.findMany({
        where: {
          organizationId: organizationIdValue,
          status: { not: 'RELEASED' },
          ...(clientId ? { domain: { clientId } } : {}),
        },
        select: { sources: true, allQualifier: true, domain: { select: { name: true } } },
        orderBy: { domain: { name: 'asc' } },
      }),
    ]);
    response.json({
      summary,
      hostedDmarc: hosted.map((row) => ({
        domain: row.domain.name,
        republish: { host: `_dmarc.${row.domain.name}`, type: 'TXT', value: row.value },
      })),
      managedSpf: spf.map((row) => ({
        domain: row.domain.name,
        republish: {
          host: row.domain.name,
          type: 'TXT',
          value: managedSpfRepublish({
            sources: row.sources,
            allQualifier: row.allQualifier,
            domain: row.domain.name,
          }),
        },
      })),
    });
  },
);

lifecycleRouter.delete(
  '/workspaces/:organizationId',
  requireSession,
  // `organization: delete`, not `organization: update`. Better Auth's default
  // organization statements are `['update', 'delete']` and the admin role here
  // is granted `['read', 'update']`, so `update` would let any admin delete the
  // workspace while `delete` is held by the owner alone. The destructive action
  // and the permission that names it have to agree.
  requireOrganizationPermission('organization', 'delete'),
  async (request: Request, response: Response) => {
    const result = await deleteWorkspace(organizationId(request), response.locals.session?.user?.id);

    if (!result.ok) {
      if (result.reason === 'has_active_subscription') {
        // Cancelling is a billing action with a period end and a refund policy.
        // Deleting the workspace is not a way to cancel: it would strand a paid
        // period the customer has already been charged for.
        response.status(409).json({
          error: {
            code: 'SUBSCRIPTION_STILL_ACTIVE',
            message: 'Cancel the subscription before deleting this workspace. Deleting it would strand a period you have already been charged for.',
          },
        });
        return;
      }
      response.status(404).json({ error: { message: 'That workspace does not exist.' } });
      return;
    }

    response.json({ deleted: result.name, summary: result.summary });
  },
);
