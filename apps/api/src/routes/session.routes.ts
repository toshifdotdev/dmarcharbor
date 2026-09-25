import { Router } from 'express';
import { getMe } from '../controllers/session.controller.js';
import {
  createWorkspace,
  listWorkspaceMembers,
  listWorkspaces,
} from '../controllers/workspace.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';

export const sessionRouter = Router();

sessionRouter.get('/me', requireSession, getMe);
sessionRouter.get('/workspaces', requireSession, listWorkspaces);
sessionRouter.post('/workspaces', requireSession, createWorkspace);
sessionRouter.get('/workspaces/:organizationId/members', requireSession, listWorkspaceMembers);
