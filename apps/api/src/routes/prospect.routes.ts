import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { createPublicReportRateLimiter, createScanRateLimiter } from '../middleware/rate-limit.middleware.js';
import {
  ProspectReportError,
  createProspectReport,
  deleteProspectReport,
  getPublicProspectReport,
  listProspectReports,
  maximumProspectDays,
  revokeProspectReport,
} from '../services/prospect/prospect-report.service.js';

const json = express.json({ limit: '8kb' });

const createSchema = z.object({
  domain: z.string().trim().min(1).max(253),
  prospectName: z.string().trim().max(120).optional().nullable(),
  note: z.string().trim().max(600).optional().nullable(),
  contactEmail: z.union([z.literal(''), z.string().trim().email().max(254)]).optional().nullable(),
  expiresInDays: z.coerce.number().int().min(1).max(maximumProspectDays).optional(),
});

function actor(response: Response): string | null {
  return (response.locals.session?.user?.id as string | undefined) ?? null;
}

function fail(response: Response, error: unknown): void {
  if (error instanceof ProspectReportError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, ...error.details } });
    return;
  }
  throw error;
}

/**
 * Prospect risk reports.
 *
 * Creating one is the paid feature, and it runs a live scan, so it carries the
 * scanner's own rate limit as well as the monthly allowance. Listing, revoking
 * and removing are open on every plan: a downgraded workspace can always see
 * and withdraw the links it already sent.
 */
export const prospectRouter = Router();

prospectRouter.get(
  '/workspaces/:organizationId/prospect-reports',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  async (request: Request, response: Response) => {
    response.json(await listProspectReports(String(request.params.organizationId)));
  },
);

prospectRouter.post(
  '/workspaces/:organizationId/prospect-reports',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  requireFeature('prospects.reports'),
  createScanRateLimiter(),
  json,
  async (request: Request, response: Response) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      response.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message:
            field === 'contactEmail'
              ? 'The contact email is not a valid address. Leave it empty to show none.'
              : field === 'note'
                ? 'The note can be at most 600 characters.'
                : field === 'prospectName'
                  ? 'The prospect name can be at most 120 characters.'
                  : field === 'expiresInDays'
                    ? `The link can last between 1 and ${maximumProspectDays} days.`
                    : 'Enter the domain to check, for example acme.com.',
        },
      });
      return;
    }
    try {
      const report = await createProspectReport({
        organizationId: String(request.params.organizationId),
        actorUserId: actor(response),
        domain: parsed.data.domain,
        prospectName: parsed.data.prospectName,
        note: parsed.data.note,
        contactEmail: parsed.data.contactEmail || null,
        expiresInDays: parsed.data.expiresInDays,
      });
      response.status(201).json({ report });
    } catch (error) {
      fail(response, error);
    }
  },
);

prospectRouter.post(
  '/workspaces/:organizationId/prospect-reports/:reportId/revoke',
  requireSession,
  requireOrganizationPermission('report', 'update'),
  async (request: Request, response: Response) => {
    const revoked = await revokeProspectReport({
      organizationId: String(request.params.organizationId),
      actorUserId: actor(response),
      reportId: String(request.params.reportId),
    });
    if (!revoked) {
      response
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'That report is not in this workspace, or is already revoked.' } });
      return;
    }
    response.status(204).end();
  },
);

prospectRouter.delete(
  '/workspaces/:organizationId/prospect-reports/:reportId',
  requireSession,
  requireOrganizationPermission('report', 'delete'),
  async (request: Request, response: Response) => {
    const outcome = await deleteProspectReport({
      organizationId: String(request.params.organizationId),
      actorUserId: actor(response),
      reportId: String(request.params.reportId),
    });
    if (outcome === 'not_found') {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That report is not in this workspace.' } });
      return;
    }
    if (outcome === 'still_active') {
      response.status(409).json({
        error: {
          code: 'PROSPECT_REPORT_STILL_ACTIVE',
          message: 'Revoke this link first. Removing it while it still works would leave no record that it was withdrawn.',
        },
      });
      return;
    }
    response.status(204).end();
  },
);

/**
 * The page a prospect opens. No session, no cookie, and one 404 for a link
 * that never existed, was revoked or has expired, so the route cannot be used
 * to learn which tokens were real. Served from the stored snapshot: opening a
 * link never scans anyone's DNS.
 */
export const publicProspectRouter = Router();

publicProspectRouter.get(
  '/prospect-reports/:token',
  createPublicReportRateLimiter(),
  async (request: Request, response: Response) => {
    const token = String(request.params.token ?? '');
    const notFound = () => {
      response.setHeader('Cache-Control', 'no-store');
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'This report is not available.' } });
    };
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) {
      notFound();
      return;
    }
    const report = await getPublicProspectReport(token);
    if (!report) {
      notFound();
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Robots-Tag', 'noindex');
    response.json(report);
  },
);
