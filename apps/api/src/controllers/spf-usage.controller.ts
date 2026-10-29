import type { Request, Response } from 'express';
import { resourceIdSchema } from '../models/client.model.js';
import { SpfUsageError, analyseSpfUsage } from '../services/spf-usage.service.js';

/** GET /workspaces/:organizationId/domains/:domainId/spf-usage */
export async function spfUsageController(request: Request, response: Response): Promise<void> {
  const domainId = resourceIdSchema.safeParse(request.params.domainId);
  if (!domainId.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid domain identifier is required.' } });
    return;
  }
  try {
    response.setHeader('Cache-Control', 'no-store');
    response.json(await analyseSpfUsage(response.locals.organizationId, domainId.data));
  } catch (error) {
    if (error instanceof SpfUsageError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    throw error;
  }
}
