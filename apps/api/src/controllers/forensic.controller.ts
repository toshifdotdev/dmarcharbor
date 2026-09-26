import type { Request, Response } from 'express';
import { requestHasOrganizationPermission } from '../auth/permission-check.js';
import { resourceIdSchema } from '../models/client.model.js';
import {
  forensicCollectionSchema,
  forensicIdentitySchema,
  forensicIngestSchema,
} from '../models/forensic.model.js';
import { buildPage, parsePagination } from '../utils/pagination.js';
import { getDomain } from '../services/client.service.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { ForensicReportParseError } from '../services/forensic-report-parser.service.js';
import {
  deleteForensicReport,
  forensicRetentionSummary,
  getForensicReport,
  ingestForensicReport,
  listDomainForensics,
  presentForensic,
  purgeForensicReports,
  setForensicCollection,
  setForensicIdentityRetention,
} from '../services/forensic-report.service.js';

function parseId(value: string | string[] | undefined): string | null {
  const parsed = resourceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function mayIdentify(request: Request, organizationId: string): Promise<boolean> {
  return requestHasOrganizationPermission(request, organizationId, 'forensic', 'identify');
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

  const page = parsePagination(request, response);
  if (!page.ok) {
    return;
  }

  const organizationId = response.locals.organizationId;
  const [{ rows, limit }, includePii] = await Promise.all([
    listDomainForensics(organizationId, domainId, { limit: page.limit, cursor: page.cursor }),
    mayIdentify(request, organizationId),
  ]);

  response.json({
    ...buildPage(
      rows.map((forensic) => presentForensic(forensic, includePii)),
      limit,
    ),
    ...forensicRetentionSummary(),
  });
}

export async function getForensicReportController(request: Request, response: Response): Promise<void> {
  const forensicId = parseId(request.params.forensicId);
  if (!forensicId) {
    response.status(400).json({ error: { message: 'A valid forensic report identifier is required.' } });
    return;
  }

  const organizationId = response.locals.organizationId;
  const [forensic, includePii] = await Promise.all([
    getForensicReport(organizationId, forensicId),
    mayIdentify(request, organizationId),
  ]);

  if (!forensic) {
    response.status(404).json({ error: { message: 'Forensic report not found in this workspace.' } });
    return;
  }

  response.json(presentForensic(forensic, includePii));
}

export async function deleteForensicReportController(request: Request, response: Response): Promise<void> {
  const forensicId = parseId(request.params.forensicId);
  if (!forensicId) {
    response.status(400).json({ error: { message: 'A valid forensic report identifier is required.' } });
    return;
  }

  const organizationId = response.locals.organizationId;
  const existing = await getForensicReport(organizationId, forensicId);
  if (!existing) {
    response.status(404).json({ error: { message: 'Forensic report not found in this workspace.' } });
    return;
  }

  await deleteForensicReport(organizationId, forensicId);
  await recordAuditEvent({
    organizationId,
    domainId: existing.domainId,
    actorUserId: response.locals.session?.user?.id,
    action: 'FORENSIC_PURGE_SINGLE',
    targetType: 'forensic_report',
    targetId: forensicId,
    detail: { reportedDomain: existing.reportedDomain, piiRetained: existing.piiRetained },
    requestId: response.locals.requestId,
  });

  response.status(204).send();
}

export async function purgeForensicsController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  if (!domainId) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }

  const organizationId = response.locals.organizationId;
  const deleted = await purgeForensicReports(organizationId, domainId);
  if (deleted === 0 && !(await getDomain(organizationId, domainId))) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  await recordAuditEvent({
    organizationId,
    domainId,
    actorUserId: response.locals.session?.user?.id,
    action: 'FORENSIC_PURGE_DOMAIN',
    targetType: 'domain',
    targetId: domainId,
    detail: { deleted },
    requestId: response.locals.requestId,
  });

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

export async function setForensicIdentityController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  const body = forensicIdentitySchema.safeParse(request.body);

  if (!domainId || !body.success) {
    response.status(400).json({ error: { message: 'A valid domain and retainForensicPii flag are required.' } });
    return;
  }

  const organizationId = response.locals.organizationId;
  const outcome = await setForensicIdentityRetention(
    organizationId,
    domainId,
    body.data.retainForensicPii,
    { confirmedLegalBasis: body.data.confirmLegalBasis, confirmedNamePurge: body.data.confirmNamePurge },
    response.locals.session?.user?.id,
  );

  if (outcome.status === 'not_found') {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  if (outcome.status === 'legal_basis_required') {
    response.status(400).json({
      error: {
        message:
          'Retaining named recipients is personal data. Confirm the lawful basis for your workspace before enabling it.',
      },
    });
    return;
  }

  if (outcome.status === 'purge_confirmation_required') {
    response.status(400).json({
      error: {
        message:
          'Turning this off permanently deletes the stored recipient addresses, subject lines and sender addresses for this domain. This cannot be undone. The pseudonymized evidence is kept. Confirm the purge to continue.',
        requiresNamePurgeConfirmation: true,
      },
    });
    return;
  }

  await recordAuditEvent({
    organizationId,
    domainId,
    actorUserId: response.locals.session?.user?.id,
    action: body.data.retainForensicPii ? 'FORENSIC_IDENTITY_ENABLED' : 'FORENSIC_IDENTITY_DISABLED',
    targetType: 'domain',
    targetId: domainId,
    detail: {
      retainForensicPii: body.data.retainForensicPii,
      purgedIdentities: outcome.purgedIdentities,
      identitiesDestroyed: outcome.purgedIdentities,
    },
    requestId: response.locals.requestId,
  });

  response.json({
    domain: outcome.domain,
    purgedIdentities: outcome.purgedIdentities,
    ...forensicRetentionSummary(),
  });
}
