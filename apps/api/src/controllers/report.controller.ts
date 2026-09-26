import type { Request, Response } from 'express';
import { resourceIdSchema } from '../models/client.model.js';
import { reportIngestSchema } from '../models/report.model.js';
import { getDomain } from '../services/client.service.js';
import {
  getDmarcReport,
  ingestDmarcReport,
  listDomainReports,
} from '../services/report.service.js';
import { DmarcReportParseError } from '../services/report-parser.service.js';

function parseId(value: string | string[] | undefined): string | null {
  const parsed = resourceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function ingestReportController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  const body = reportIngestSchema.safeParse(request.body);

  if (!domainId || !body.success) {
    response.status(400).json({ error: { message: 'A valid domain and DMARC XML report are required.' } });
    return;
  }

  try {
    const outcome = await ingestDmarcReport({
      organizationId: response.locals.organizationId,
      domainId,
      xml: body.data.xml,
    });

    if (outcome.status === 'not_found') {
      response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
      return;
    }

    if (outcome.status === 'not_verified') {
      response.status(409).json({ error: { message: 'Verify the domain before ingesting DMARC reports.' } });
      return;
    }

    if (outcome.status === 'domain_mismatch') {
      response.status(409).json({
        error: {
          message: `This report belongs to ${outcome.reportDomain}, not the selected domain.`,
        },
      });
      return;
    }

    response.status(outcome.status === 'created' ? 201 : 200).json({
      duplicate: outcome.status === 'duplicate',
      report: outcome.report,
    });
  } catch (error) {
    if (error instanceof DmarcReportParseError) {
      response.status(400).json({ error: { message: error.message } });
      return;
    }

    response.status(500).json({ error: { message: 'The DMARC report could not be stored.' } });
  }
}

export async function listReportsController(request: Request, response: Response): Promise<void> {
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

  const reports = await listDomainReports(response.locals.organizationId, domainId);
  response.json(reports);
}

export async function getReportController(request: Request, response: Response): Promise<void> {
  const reportId = parseId(request.params.reportId);
  if (!reportId) {
    response.status(400).json({ error: { message: 'A valid report identifier is required.' } });
    return;
  }

  const report = await getDmarcReport(response.locals.organizationId, reportId);
  if (!report) {
    response.status(404).json({ error: { message: 'Report not found in this workspace.' } });
    return;
  }

  response.json(report);
}
