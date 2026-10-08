import { Router } from 'express';
import {
  listSessionsController,
  revokeAllSessionsController,
  revokeOtherSessionsController,
  revokeSessionController,
} from '../controllers/session-management.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { createSecureSessionRouterRateLimiter } from '../middleware/rate-limit.middleware.js';

export const sessionManagementRouter = Router();

sessionManagementRouter.get('/me/sessions', requireSession, listSessionsController);
sessionManagementRouter.delete('/me/sessions/:sessionId', requireSession, revokeSessionController);
sessionManagementRouter.post(
  '/me/sessions/revoke-others',
  requireSession,
  createSecureSessionRouterRateLimiter(),
  revokeOtherSessionsController,
);
sessionManagementRouter.post(
  '/me/sessions/revoke-all',
  requireSession,
  createSecureSessionRouterRateLimiter(),
  revokeAllSessionsController,
);
