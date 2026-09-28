import { Router } from 'express';
import {
  configureInboxController,
  deleteInboxController,
  getInboxController,
  pollInboxController,
} from '../controllers/report-inbox.controller.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { requireFeature } from '../middleware/entitlement.middleware.js';

/**
 * Emailed DMARC report collection.
 *
 * A shared inbox means one mailbox per workspace rather than one per customer:
 * every monitored domain points its rua tag at our address, and no customer
 * ever hands over IMAP credentials. That is why this is a workspace setting and
 * not a per client field.
 */
export const reportInboxRouter = Router();

/**
 * Stored settings.
 *
 * The response carries the host and username but never the password, so this
 * is safe for the agency interface to read on load.
 */
reportInboxRouter.get(
  '/workspaces/:organizationId/report-inbox',
  requireSession,
  requireOrganizationPermission('organization', 'read'),
  requireFeature('reports.inbox'),
  getInboxController,
);

/** Writing a mailbox password is a settings change, so it takes update rights. */
reportInboxRouter.put(
  '/workspaces/:organizationId/report-inbox',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('reports.inbox'),
  configureInboxController,
);

reportInboxRouter.delete(
  '/workspaces/:organizationId/report-inbox',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('reports.inbox'),
  deleteInboxController,
);

/**
 * Manual poll.
 *
 * The scheduler runs this on its own, so the endpoint exists for the case where
 * someone has just pointed a rua tag at us and does not want to wait for the
 * next cycle to find out whether the mailbox is correct.
 */
reportInboxRouter.post(
  '/workspaces/:organizationId/report-inbox/poll',
  requireSession,
  requireOrganizationPermission('organization', 'update'),
  requireFeature('reports.inbox'),
  pollInboxController,
);
