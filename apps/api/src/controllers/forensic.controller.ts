import type { Request, Response } from 'express';
import { resourceIdSchema } from '../models/client.model.js';
import { forensicCollectionSchema, forensicIngestSchema, forensicListQuerySchema } from '../models/forensic.model.js';
import { getDomain } from '../services/client.service.js';
import { ForensicReportParseError } from '../services/forensic-report-parser.service.js';
import {
  deleteForensicReport,
  forensicRetentionSummary,
  getForensicReport,
  ingestForensicReport,
  listDomainForensics,
  purgeForensicReports,
  setForensicCollection,
} from '../services/forensic-report.service.js';

function parseId(value: string | string[] | undefined): string | null {
  const parsed = resourceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function ingestForensicReportController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  const body = forensicIngestSchema.safeParse(request.body);

  if (!domainId || !body.success) {
    response.status(400).json({ error: { message: 'A valid domain and raw forensic report email are required.' } });
    return;
  }

  try {
    const outcome = await ingestForensicReport({
      organizationId: response.locals.organizationId,
      domainId,
      rawEmail: body.data.rawEmail,
    });

    if (outcome.status === 'not_found') {
      response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
      return;
    }

    if (outcome.status === 'not_verified') {
      response.status(409).json({ error: { message: 'Verify the domain before ingesting forensic reports.' } });
      return;
    }

    if (outcome.status === 'forensics_not_enabled') {
      response.status(409).json({
        error: { message: 'Enable forensic report collection for this domain before ingesting.' },
      });
      return;
    }

    if (outcome.status === 'ruf_not_configured') {
      response.status(409).json({
        error: { message: 'This domain does not publish a ruf= address, so forensic reports are not collected.' },
      });
      return;
    }

    if (outcome.status === 'domain_mismatch') {
      response.status(409).json({
        error: { message: `This report belongs to ${outcome.reportedDomain}, not the selected domain.` },
      });
      return;
    }

    response.status(outcome.status === 'created' ? 201 : 200).json({
      duplicate: outcome.status === 'duplicate',
      forensic: outcome.forensic,
    });
  } catch (error) {
    if (error instanceof ForensicReportParseError) {
      response.status(400).json({ error: { message: error.message } });
      return;
    }

    response.status(500).json({ error: { message: 'The forensic report could not be stored.' } });
  }
}

export async function listForensicsController(request: Request, response: Response): Promise<void> {
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

  const query = forensicListQuerySchema.safeParse(request.query);
  const forensics = await listDomainForensics(
    response.locals.organizationId,
    domainId,
    query.success ? query.data.limit : undefined,
  );

  response.json({ forensics, ...forensicRetentionSummary() });
}

export async function getForensicReportController(request: Request, response: Response): Promise<void> {
  const forensicId = parseId(request.params.forensicId);
  if (!forensicId) {
    response.status(400).json({ error: { message: 'A valid forensic report identifier is required.' } });
    return;
  }

  const forensic = await getForensicReport(response.locals.organizationId, forensicId);
  if (!forensic) {
    response.status(404).json({ error: { message: 'Forensic report not found in this workspace.' } });
    return;
  }

  response.json(forensic);
}

export async function deleteForensicReportController(request: Request, response: Response): Promise<void> {
  const forensicId = parseId(request.params.forensicId);
  if (!forensicId) {
    response.status(400).json({ error: { message: 'A valid forensic report identifier is required.' } });
    return;
  }

  const deleted = await deleteForensicReport(response.locals.organizationId, forensicId);
  if (!deleted) {
    response.status(404).json({ error: { message: 'Forensic report not found in this workspace.' } });
    return;
  }

  response.status(204).send();
}

export async function purgeForensicsController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  if (!domainId) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }

  const deleted = await purgeForensicReports(response.locals.organizationId, domainId);
  response.json({ deleted });
}

export async function setForensicCollectionController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  const body = forensicCollectionSchema.safeParse(request.body);

  if (!domainId || !body.success) {
    response.status(400).json({ error: { message: 'A valid domain and collectForensicReports flag are required.' } });
    return;
  }

  const outcome = await setForensicCollection(
    response.locals.organizationId,
    domainId,
    body.data.collectForensicReports,
  );

  if (outcome.status === 'not_found') {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  response.json({ domain: outcome.domain, ...forensicRetentionSummary() });
}
