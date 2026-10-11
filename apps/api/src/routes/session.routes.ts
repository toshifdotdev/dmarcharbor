import { Router } from 'express';
import { getMe } from '../controllers/account.controller.js';
import {
  createWorkspace,
  listWorkspaceMembers,
  listWorkspaces,
  readWorkspaceAllowance,
} from '../controllers/workspace.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';

export const sessionRouter = Router();

sessionRouter.get('/me', requireSession, getMe);
sessionRouter.get('/workspaces', requireSession, listWorkspaces);
sessionRouter.get('/workspaces/allowance', requireSession, readWorkspaceAllowance);
sessionRouter.post('/workspaces', requireSession, createWorkspace);
sessionRouter.get('/workspaces/:organizationId/members', requireSession, listWorkspaceMembers);
