import type { Request, Response } from 'express';
import { resourceIdSchema } from '../models/client.model.js';
import { getMailboxCompliance } from '../services/compliance/mailbox-compliance.service.js';

/**
 * Unexpected errors are not caught here: they reach the global error handler,
 * which logs them and answers in the standard error shape. Catching them
 * locally would answer 500 with nothing in the logs to explain it.
 */
export async function mailboxComplianceController(request: Request, response: Response): Promise<void> {
  const domainId = resourceIdSchema.safeParse(request.params.domainId);
  if (!domainId.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid domain identifier is required.' } });
    return;
  }

  const view = await getMailboxCompliance({
    organizationId: response.locals.organizationId,
    domainIdOrSlug: domainId.data,
  });

  if (!view) {
    response.status(404).json({ error: { code: 'DOMAIN_NOT_FOUND', message: 'Domain not found in this workspace.' } });
    return;
  }

  response.json(view);
}
