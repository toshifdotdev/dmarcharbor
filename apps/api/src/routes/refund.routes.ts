import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireStaff } from '../middleware/staff.middleware.js';
import { RefundError, issueRefund, refundEligibility } from '../billing/refund.service.js';
import { workspaceIdSchema } from '../models/auth.model.js';

export const refundRouter = Router();

/**
 * Refunds against the published 30 day guarantee.
 *
 * Staff credentialed, on the same reasoning as a plan change and an entitlement
 * override: paying money out is not something the permission table should be able
 * to express, and every route that was ever left on `billing:update` became a way
 * for a workspace owner to help themselves. The `owner` role holds `billing:
 * update`, so this would not have been a small mistake.
 *
 * Separate from the billing router on purpose. A refund is not a self service
 * action, and mixing it into a workspace-scoped file makes it look like one.
 */

function target(request: Request, response: Response): string | null {
  const parsed = workspaceIdSchema.safeParse(request.params.organizationId);
  if (!parsed.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid workspace identifier is required.' } });
    return null;
  }
  return parsed.data;
}

function fail(response: Response, error: unknown): void {
  if (error instanceof RefundError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  response.status(500).json({
    error: { code: 'INTERNAL', message: 'The refund could not be processed.' },
  });
}

/**
 * Read only, and safe to call during a support conversation.
 *
 * This is the whole point of the feature. Support could previously only answer by
 * opening a provider dashboard and reading an invoice date, so the answer was a
 * guess, and a guess is wrong in one of two expensive directions.
 */
refundRouter.get('/workspaces/:organizationId/refund-eligibility', requireStaff, async (request, response) => {
  const organizationId = target(request, response);
  if (!organizationId) return;

  try {
    response.json(await refundEligibility(organizationId));
  } catch (error) {
    fail(response, error);
  }
});

refundRouter.post('/workspaces/:organizationId/refund', requireStaff, async (request, response) => {
  const organizationId = target(request, response);
  if (!organizationId) return;

  const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : '';
  if (reason.length < 3) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'Record why this refund is being issued.' },
    });
    return;
  }

  try {
    const outcome = await issueRefund({
      organizationId,
      reason,
      // An explicit decision to pay outside the guarantee. Recorded, because
      // "we refunded it anyway" and "it was inside the guarantee" are different
      // facts about the same event.
      overrideWindow: request.body?.overrideWindow === true,
    });
    response.status(201).json(outcome);
  } catch (error) {
    fail(response, error);
  }
});