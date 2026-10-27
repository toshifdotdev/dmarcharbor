import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDomain } from '../services/client.service.js';
import {
  getTlsReport,
  getTlsReportSummary,
  listDomainTlsReports,
} from '../services/tls-report/tls-report-query.service.js';
import { buildPage } from '../utils/pagination.js';

const resourceId = z.string().trim().min(1);
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
});
const summaryQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export async function listTlsReportsController(request: Request, response: Response): Promise<void> {
  const domainId = resourceId.safeParse(request.params.domainId);
  if (!domainId.success) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }
  const domain = await getDomain(response.locals.organizationId, domainId.data);
  if (!domain) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }
  const query = listQuery.safeParse(request.query);
  if (!query.success) {
    response.status(400).json({
      error: { message: 'limit must be between 1 and 100, and cursor must be a valid identifier.' },
    });
    return;
  }
  const { rows, limit } = await listDomainTlsReports(
    response.locals.organizationId,
    domain.id,
    { limit: query.data.limit, cursor: query.data.cursor },
  );
  response.json(buildPage(rows, limit));
}

export async function tlsReportSummaryController(request: Request, response: Response): Promise<void> {
  const domainId = resourceId.safeParse(request.params.domainId);
  const query = summaryQuery.safeParse(request.query);
  if (!domainId.success || !query.success) {
    response.status(400).json({
      error: { message: 'A valid domain and days between 1 and 365 are required.' },
    });
    return;
  }
  const domain = await getDomain(response.locals.organizationId, domainId.data);
  if (!domain) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }
  const summary = await getTlsReportSummary(
    response.locals.organizationId,
    domain.id,
    query.data.days,
  );
  if (!summary) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }
  response.json(summary);
}

export async function getTlsReportController(request: Request, response: Response): Promise<void> {
  const reportId = resourceId.safeParse(request.params.reportId);
  if (!reportId.success) {
    response.status(400).json({ error: { message: 'A valid report identifier is required.' } });
    return;
  }
  const report = await getTlsReport(response.locals.organizationId, reportId.data);
  if (!report) {
    response.status(404).json({ error: { message: 'TLS report not found in this workspace.' } });
    return;
  }
  response.json(report);
}
