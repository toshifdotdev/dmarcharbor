import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { requirePortalScope } from '../middleware/portal.middleware.js';
import { policyProposalRateLimiter } from '../middleware/rate-limit.middleware.js';
import {
  PolicyProposalError,
  createPolicyProposal,
  decidePolicyProposal,
  listDomainProposals,
  listPortalProposals,
  maximumDeclineReasonLength,
  maximumNoteLength,
  retryPolicyProposal,
  withdrawPolicyProposal,
} from '../services/policy-proposal/policy-proposal.service.js';

const json = express.json({ limit: '16kb' });

const createSchema = z.object({
  policy: z.enum(['quarantine', 'reject']),
  testing: z.boolean().default(false),
  note: z.string().trim().max(maximumNoteLength).optional().nullable(),
  acceptBlockers: z.boolean().default(false),
});

const decideSchema = z.object({
  reason: z.string().trim().max(maximumDeclineReasonLength).optional().nullable(),
});

function sessionUser(response: Response): { id: string; email: string } | null {
  const user = response.locals.session?.user as { id?: string; email?: string } | undefined;
  return user?.id && user.email ? { id: user.id, email: user.email } : null;
}

function fail(response: Response, error: unknown): void {
  if (error instanceof PolicyProposalError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, ...error.details } });
    return;
  }
  throw error;
}

/**
 * Client-approved enforcement.
 *
 * The agency's side is under the workspace. Proposing needs the client portal,
 * because that is where the client answers. Reading and withdrawing do not, so
 * a downgraded workspace can still see and withdraw what it sent.
 *
 * The client's side is under /portal and scoped exactly like every other
 * portal route: the contact's grants decide which proposals they can see and
 * answer, never an id in the path.
 */
export const policyProposalRouter = Router();

policyProposalRouter.get(
  '/workspaces/:organizationId/domains/:domainId/policy-proposals',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  async (request: Request, response: Response) => {
    const result = await listDomainProposals(String(request.params.organizationId), String(request.params.domainId));
    if (!result) {
      response.status(404).json({ error: { code: 'DOMAIN_NOT_FOUND', message: 'That domain is not in this workspace.' } });
      return;
    }
    response.json(result);
  },
);

policyProposalRouter.post(
  '/workspaces/:organizationId/domains/:domainId/policy-proposals',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  requireFeature('portal.client'),
  policyProposalRateLimiter,
  json,
  async (request: Request, response: Response) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      response.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message:
            field === 'note'
              ? `The note can be at most ${maximumNoteLength} characters.`
              : 'Choose quarantine or reject. The step to none needs no approval.',
        },
      });
      return;
    }
    try {
      const proposal = await createPolicyProposal({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: sessionUser(response)?.id ?? null,
        ...parsed.data,
      });
      response.status(201).json({ proposal });
    } catch (error) {
      fail(response, error);
    }
  },
);

policyProposalRouter.post(
  '/workspaces/:organizationId/policy-proposals/:proposalId/withdraw',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  async (request: Request, response: Response) => {
    try {
      const proposal = await withdrawPolicyProposal({
        organizationId: String(request.params.organizationId),
        proposalId: String(request.params.proposalId),
        actorUserId: sessionUser(response)?.id ?? null,
      });
      if (!proposal) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That request is not in this workspace.' } });
        return;
      }
      response.json({ proposal });
    } catch (error) {
      fail(response, error);
    }
  },
);

policyProposalRouter.post(
  '/workspaces/:organizationId/policy-proposals/:proposalId/retry',
  requireSession,
  requireOrganizationPermission('domain', 'update'),
  policyProposalRateLimiter,
  async (request: Request, response: Response) => {
    const user = sessionUser(response);
    if (!user) {
      response.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Sign in again.' } });
      return;
    }
    try {
      const proposal = await retryPolicyProposal({
        organizationId: String(request.params.organizationId),
        proposalId: String(request.params.proposalId),
        actorUserId: user.id,
      });
      if (!proposal) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That request is not in this workspace.' } });
        return;
      }
      response.json({ proposal });
    } catch (error) {
      fail(response, error);
    }
  },
);

/** Open requests across the contact's clients, for the overview. */
policyProposalRouter.get(
  '/portal/policy-proposals',
  requireSession,
  requirePortalScope,
  async (_request: Request, response: Response) => {
    const proposals = await listPortalProposals({
      organizationId: response.locals.organizationId as string,
      clientIds: response.locals.portalClientIds as string[],
    });
    response.json({ proposals });
  },
);

/** Open and recently answered requests for one domain. */
policyProposalRouter.get(
  '/portal/domains/:domainId/policy-proposals',
  requireSession,
  requirePortalScope,
  async (request: Request, response: Response) => {
    const proposals = await listPortalProposals({
      organizationId: response.locals.organizationId as string,
      clientIds: response.locals.portalClientIds as string[],
      domainId: String(request.params.domainId),
    });
    response.json({ proposals });
  },
);

function decide(decision: 'approve' | 'decline') {
  return async (request: Request, response: Response) => {
    const user = sessionUser(response);
    if (!user) {
      response.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Sign in to answer this request.' } });
      return;
    }
    const parsed = decideSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: `The reason can be at most ${maximumDeclineReasonLength} characters.`,
        },
      });
      return;
    }
    try {
      const proposal = await decidePolicyProposal({
        organizationId: response.locals.organizationId as string,
        clientIds: response.locals.portalClientIds as string[],
        proposalId: String(request.params.proposalId),
        user,
        decision,
        reason: parsed.data.reason,
      });
      response.json({ proposal });
    } catch (error) {
      fail(response, error);
    }
  };
}

policyProposalRouter.post(
  '/portal/policy-proposals/:proposalId/approve',
  requireSession,
  requirePortalScope,
  json,
  decide('approve'),
);
policyProposalRouter.post(
  '/portal/policy-proposals/:proposalId/decline',
  requireSession,
  requirePortalScope,
  json,
  decide('decline'),
);
