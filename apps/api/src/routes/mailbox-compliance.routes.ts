import { Router } from 'express';
import { mailboxComplianceController } from '../controllers/mailbox-compliance.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';

/**
 * Gmail, Yahoo and Outlook sender requirements.
 *
 * Available on every plan and deliberately not behind an entitlement gate: this
 * is a read of evidence the workspace already has, next to the same scans,
 * senders and DNS changes that are ungated.
 */
export const mailboxComplianceRouter = Router();

mailboxComplianceRouter.get(
  '/workspaces/:organizationId/domains/:domainId/mailbox-compliance',
  requireSession,
  requireOrganizationPermission('domain', 'read'),
  mailboxComplianceController,
);
