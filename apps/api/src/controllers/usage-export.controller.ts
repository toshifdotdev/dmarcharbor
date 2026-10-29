import type { Request, Response } from 'express';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { EntitlementError, assertFeature } from '../services/entitlements/entitlement.service.js';
import { MonthlyReportError } from '../services/reports/monthly-period.js';
import {
  buildUsageExport,
  resolveUsagePeriod,
  usageCsv,
  usageFilename,
} from '../services/reports/usage-export.service.js';

/**
 * The monthly usage export, for the browser (CSV or JSON) and for /api/v1
 * (JSON). Both read the same figures, so an agency's PSA and its spreadsheet
 * never disagree about a client's month.
 */

function fail(response: Response, error: unknown): void {
  if (error instanceof EntitlementError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, ...error.details } });
    return;
  }
  if (error instanceof MonthlyReportError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  throw error;
}

function monthParam(request: Request): string | undefined {
  return typeof request.query.month === 'string' ? request.query.month : undefined;
}

export async function usageExportController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId as string;
  const format = request.query.format === 'json' ? 'json' : request.query.format === undefined || request.query.format === 'csv' ? 'csv' : null;
  if (!format) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'format must be csv or json.' } });
    return;
  }

  try {
    await assertFeature(organizationId, 'reports.usageExport');
    const period = resolveUsagePeriod(monthParam(request));
    const usage = await buildUsageExport(organizationId, period);
    const workspace = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { slug: true } });

    await recordAuditEvent({
      organizationId,
      actorUserId: response.locals.session?.user?.id,
      action: 'EXPORT_DOWNLOADED',
      targetType: 'usage_export',
      targetId: period.key,
      detail: { kind: 'usage', month: period.key, format, clients: usage.clients.length },
      requestId: response.locals.requestId,
    });

    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Disposition', `attachment; filename="${usageFilename(workspace.slug, period, format)}"`);
    if (format === 'csv') {
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.send(usageCsv(usage));
      return;
    }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.send(JSON.stringify(usage, null, 2));
  } catch (error) {
    fail(response, error);
  }
}

/** GET /api/v1/usage: the same figures, for an integration that bills from them. */
export async function apiUsageController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId as string;
  try {
    await assertFeature(organizationId, 'reports.usageExport');
    const period = resolveUsagePeriod(monthParam(request));
    response.json(await buildUsageExport(organizationId, period));
  } catch (error) {
    if (error instanceof EntitlementError || error instanceof MonthlyReportError) {
      fail(response, error);
      return;
    }
    response.status(500).json({ error: { code: 'INTERNAL', message: 'The request could not be completed.' } });
  }
}
