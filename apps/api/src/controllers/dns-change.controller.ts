import type { Request, Response } from 'express';
import { z } from 'zod';
import { resourceIdSchema } from '../models/client.model.js';
import { acknowledgeDnsChange, listDnsChanges } from '../services/monitoring/dns-change.service.js';

const severitySchema = z.enum(['INFO', 'WARNING', 'CRITICAL']);

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
  severity: z
    .preprocess(
      (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
      z.array(severitySchema).optional(),
    )
    .optional(),
});

function parseId(value: string | string[] | undefined): string | null {
  const parsed = resourceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function listDnsChangesController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  if (!domainId) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }

  const query = listQuerySchema.safeParse(request.query);
  if (!query.success) {
    response.status(400).json({
      error: { message: 'limit must be between 1 and 100, and severity must be INFO, WARNING or CRITICAL.' },
    });
    return;
  }

  const result = await listDnsChanges(response.locals.organizationId, domainId, {
    limit: query.data.limit,
    cursor: query.data.cursor,
    severity: query.data.severity,
  });

  if (!result) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  response.json(result);
}

export async function acknowledgeDnsChangeController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  const changeId = parseId(request.params.changeId);

  if (!domainId || !changeId) {
    response.status(400).json({ error: { message: 'A valid domain and change identifier are required.' } });
    return;
  }

  const result = await acknowledgeDnsChange({
    organizationId: response.locals.organizationId,
    domainIdOrSlug: domainId,
    changeId,
    actorUserId: response.locals.session?.user?.id,
  });

  if (!result) {
    response.status(404).json({ error: { message: 'DNS change not found for this domain.' } });
    return;
  }

  response.json(result);
}
