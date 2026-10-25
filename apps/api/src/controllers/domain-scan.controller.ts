import type { Request, Response } from 'express';
import { z } from 'zod';
import { resourceIdSchema } from '../models/client.model.js';
import { getDomain } from '../services/client.service.js';
import { getScan, listDomainScans, runDomainScan } from '../services/domain-scan.service.js';

const scanListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
});

function parseId(value: string | string[] | undefined): string | null {
  const parsed = resourceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function createDomainScanController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);

  if (!domainId) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }

  try {
    const outcome = await runDomainScan({
      organizationId: response.locals.organizationId,
      domainId,
      requestedById: response.locals.session.user.id,
    });

    if (outcome.status === 'not_found') {
      response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
      return;
    }

    if (outcome.status === 'not_verified') {
      response.status(409).json({ error: { message: 'Verify the domain before running an authenticated scan.' } });
      return;
    }

    if (outcome.status === 'failed') {
      response.status(502).json({
        error: { message: 'The scan could not be completed.' },
        scan: outcome.scan,
      });
      return;
    }

    response.status(201).json(outcome.scan);
  } catch {
    response.status(500).json({ error: { message: 'The scan could not be started.' } });
  }
}

export async function listDomainScansController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);

  if (!domainId) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }

  const domain = await getDomain(response.locals.organizationId, domainId);
  if (!domain) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  // The resolved id: the path may carry the slug, and scans key on id.
  const query = scanListQuerySchema.safeParse(request.query);
  if (!query.success) {
    response.status(400).json({ error: { message: 'limit must be between 1 and 100, and cursor must be a valid identifier.' } });
    return;
  }

  const scans = await listDomainScans(response.locals.organizationId, domain.id, {
    limit: query.data.limit,
    cursor: query.data.cursor,
  });
  response.json(scans);
}

export async function getScanController(request: Request, response: Response): Promise<void> {
  const scanId = parseId(request.params.scanId);

  if (!scanId) {
    response.status(400).json({ error: { message: 'A valid scan identifier is required.' } });
    return;
  }

  const scan = await getScan(response.locals.organizationId, scanId);
  if (!scan) {
    response.status(404).json({ error: { message: 'Scan not found in this workspace.' } });
    return;
  }

  response.json(scan);
}
