import type { Request, Response } from 'express';
import { resourceIdSchema } from '../models/client.model.js';
import { insightsQuerySchema } from '../models/forensic.model.js';
import { getDomain } from '../services/client.service.js';
import { forensicRetentionSummary } from '../services/forensic-report.service.js';
import { getDomainInsights } from '../services/report-intelligence.service.js';

function parseId(value: string | string[] | undefined): string | null {
  const parsed = resourceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function domainInsightsController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  if (!domainId) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }

  const organizationId = response.locals.organizationId;
  const domain = await getDomain(organizationId, domainId);
  if (!domain) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  const query = insightsQuerySchema.safeParse(request.query);
  const insights = await getDomainInsights(organizationId, domainId, query.success ? query.data.days : undefined);

  if (!insights) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  response.json({ ...insights, retention: forensicRetentionSummary() });
}
