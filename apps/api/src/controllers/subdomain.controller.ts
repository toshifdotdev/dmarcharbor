import type { Request, Response } from 'express';
import { z } from 'zod';
import { resourceIdSchema } from '../models/client.model.js';
import {
  SubdomainError,
  discoverSubdomains,
  setSubdomainDismissed,
} from '../services/subdomain-discovery.service.js';

const dismissalSchema = z.object({
  name: z.string().trim().min(1).max(253),
  dismissed: z.boolean(),
});

function sendError(response: Response, error: unknown): void {
  if (error instanceof SubdomainError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  throw error;
}

/** GET /workspaces/:organizationId/domains/:domainId/subdomains */
export async function listSubdomainsController(request: Request, response: Response): Promise<void> {
  const domainId = resourceIdSchema.safeParse(request.params.domainId);
  if (!domainId.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid domain identifier is required.' } });
    return;
  }
  try {
    response.json(await discoverSubdomains(response.locals.organizationId, domainId.data));
  } catch (error) {
    sendError(response, error);
  }
}

/** PUT /workspaces/:organizationId/domains/:domainId/subdomains/dismissal */
export async function dismissSubdomainController(request: Request, response: Response): Promise<void> {
  const domainId = resourceIdSchema.safeParse(request.params.domainId);
  const body = dismissalSchema.safeParse(request.body);
  if (!domainId.success || !body.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'A subdomain name and dismissed true or false are required.' },
    });
    return;
  }
  try {
    response.json(
      await setSubdomainDismissed({
        organizationId: response.locals.organizationId,
        domainId: domainId.data,
        name: body.data.name,
        dismissed: body.data.dismissed,
        actorUserId: response.locals.session?.user?.id,
      }),
    );
  } catch (error) {
    sendError(response, error);
  }
}
