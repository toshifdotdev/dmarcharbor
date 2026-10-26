import { Router } from 'express';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { requireStaff } from '../middleware/staff.middleware.js';
import {
  getMySecurity,
  getWorkspaceSecurity,
  putWorkspaceSecurity,
  resetMemberMfa,
  resetUserMfaAsStaff,
} from '../controllers/mfa.controller.js';

export const mfaRouter = Router();

mfaRouter.get('/me/security', requireSession, getMySecurity);

mfaRouter.post(
  '/workspaces/:organizationId/members/:memberId/mfa/reset',
  requireSession,
  requireOrganizationPermission('member', 'update'),
  resetMemberMfa,
);

mfaRouter.post('/staff/users/:userId/mfa/reset', requireStaff, resetUserMfaAsStaff);

mfaRouter.get(
  '/workspaces/:organizationId/security',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  getWorkspaceSecurity,
);

mfaRouter.put(
  '/workspaces/:organizationId/security',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  putWorkspaceSecurity,
);
