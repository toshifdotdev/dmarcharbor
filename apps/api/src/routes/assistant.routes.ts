import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import {
  askAssistantController,
  assistantIntroController,
  listAssistantQuestionsController,
} from '../controllers/assistant.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { rateLimitStoreFor } from '../middleware/postgres-rate-limit-store.js';
import { requireStaff } from '../middleware/staff.middleware.js';
import { askerKeyFor } from '../services/assistant/assistant.service.js';
import { getCorpus } from '../services/assistant/corpus.js';

export const assistantRouter = Router();

// Read at startup, so the first question does not pay for it and a missing
// docs/ directory is in the boot log rather than discovered by a customer.
getCorpus();

/** The same three options every limiter in rate-limit.middleware.ts sets. */
const shared = { standardHeaders: 'draft-7', legacyHeaders: false, passOnStoreError: true } as const;

/**
 * Per person, per minute. Keyed on a hash of the signed-in user, so staff
 * behind one office address do not share a budget and one person cannot
 * spend a colleague's.
 */
const perPerson = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: env.ASSISTANT_RATE_LIMIT_PER_MINUTE,
  store: rateLimitStoreFor('assistant-person'),
  keyGenerator: (_request, response) =>
    `user:${askerKeyFor((response.locals.session as { user?: { id?: string } } | undefined)?.user?.id)}`,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: `That is ${env.ASSISTANT_RATE_LIMIT_PER_MINUTE} questions in a minute. Wait a moment before asking another.`,
      reason: 'per_person',
    },
  },
});

/**
 * Per workspace, per day: the cost ceiling. Only answered requests count, so
 * a refused or mistyped question does not spend the workspace's budget.
 */
const perWorkspaceDaily = rateLimit({
  ...shared,
  windowMs: 24 * 60 * 60 * 1000,
  limit: env.ASSISTANT_WORKSPACE_DAILY_LIMIT,
  // The store learns this 24 hour window from the limiter (PostgresRateLimitStore.init).
  store: rateLimitStoreFor('assistant-workspace-day'),
  keyGenerator: (request) => `org:${String(request.params.organizationId)}`,
  skipFailedRequests: true,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: `This workspace has asked ${env.ASSISTANT_WORKSPACE_DAILY_LIMIT} questions today, which is the daily limit. It resets within a day; support can still answer in the meantime.`,
      reason: 'per_workspace_day',
    },
  },
});

/**
 * `billing: read` is the permission every staff role holds (owner, admin,
 * analyst, viewer) and the client portal role does not. The assistant is for
 * the agency's own people, so a client contact cannot reach it.
 */
assistantRouter.get(
  '/workspaces/:organizationId/assistant',
  requireSession,
  requireOrganizationPermission('billing', 'read'),
  requireFeature('assistant.docs'),
  assistantIntroController,
);

assistantRouter.post(
  '/workspaces/:organizationId/assistant/ask',
  requireSession,
  requireOrganizationPermission('billing', 'read'),
  requireFeature('assistant.docs'),
  perPerson,
  perWorkspaceDaily,
  askAssistantController,
);

/** Staff only, by the deployment's STAFF_API_KEY: what the docs failed to answer. */
assistantRouter.get('/staff/assistant/questions', requireStaff, listAssistantQuestionsController);
