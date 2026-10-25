import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../database/prisma.js';
import { resourceIdSchema } from '../models/client.model.js';
import { EntitlementError } from '../services/entitlements/entitlement.service.js';
import { MonthlyReportError } from '../services/reports/monthly-period.js';
import {
  InvalidReportLinkError,
  downloadMonthlyReport,
  downloadMonthlyReportByToken,
  issueMonthlyReport,
  listMonthlyReports,
} from '../services/reports/monthly-report.service.js';
import {
  deleteMonthlyReportSchedule,
  getMonthlyReportSchedule,
  upsertMonthlyReportSchedule,
} from '../services/reports/monthly-report-schedule.service.js';
import { hasPortalAccess } from '../services/portal.service.js';

const periodSchema = z.object({
  period: z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM, for example 2026-10.'),
});

const scheduleSchema = z.object({
  enabled: z.boolean().optional(),
  dayOfMonth: z.number().int().min(1).max(28),
  sendHourUtc: z.number().int().min(0).max(23),
  recipientEmails: z.array(z.string().trim().min(1).max(320)).max(20),
});

function parseId(value: string | string[] | undefined): string | null {
  const parsed = resourceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function clientInWorkspace(organizationId: string, clientId: string): Promise<boolean> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId },
    select: { id: true },
  });
  return client !== null;
}

function sendError(response: Response, error: unknown, fallback: string): void {
  if (error instanceof MonthlyReportError) {
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ?? {}),
      },
    });
    return;
  }
  if (error instanceof EntitlementError) {
    response.status(error.status).json({
      error: { code: error.code, message: error.message, ...error.details },
    });
    return;
  }
  console.error(`[monthly-reports] ${fallback}: ${error instanceof Error ? error.message : 'unknown error'}`);
  response.status(500).json({ error: { code: 'INTERNAL', message: fallback } });
}

function setReportHeaders(
  response: Response,
  input: { buffer: Buffer; reference: string; hash: string; filename: string },
): void {
  response.setHeader('Content-Type', 'application/pdf');
  response.setHeader('Content-Length', String(input.buffer.length));
  response.setHeader('Content-Disposition', `attachment; filename="${input.filename}"`);
  response.setHeader('X-DMARC-Pack-Sha256', input.hash);
  response.setHeader('X-DMARC-Pack-Reference', input.reference);
  response.setHeader('Cache-Control', 'no-store');
}

export async function listMonthlyReportsController(request: Request, response: Response): Promise<void> {
  const clientId = parseId(request.params.clientId);
  if (!clientId) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid client identifier is required.' } });
    return;
  }

  try {
    if (!(await clientInWorkspace(response.locals.organizationId, clientId))) {
      response.status(404).json({ error: { code: 'CLIENT_NOT_FOUND', message: 'That client is not in this workspace.' } });
      return;
    }
    const reports = await listMonthlyReports(response.locals.organizationId, clientId);
    response.json({ reports });
  } catch (error) {
    sendError(response, error, 'The monthly reports could not be read.');
  }
}

export async function issueMonthlyReportController(request: Request, response: Response): Promise<void> {
  const clientId = parseId(request.params.clientId);
  const body = periodSchema.safeParse(request.body);
  if (!clientId) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid client identifier is required.' } });
    return;
  }
  if (!body.success) {
    response.status(400).json({
      error: { code: 'INVALID_PERIOD', message: body.error.issues[0]?.message ?? 'Use YYYY-MM.' },
    });
    return;
  }

  try {
    const issued = await issueMonthlyReport({
      clientId,
      organizationId: response.locals.organizationId,
      period: body.data.period,
      actorUserId: response.locals.session?.user?.id,
    });
    setReportHeaders(response, {
      buffer: issued.buffer,
      reference: issued.reference,
      hash: issued.hash,
      filename: issued.filename,
    });
    response.status(200).end(issued.buffer);
  } catch (error) {
    sendError(response, error, 'The monthly report could not be issued.');
  }
}

export async function downloadMonthlyReportController(request: Request, response: Response): Promise<void> {
  const clientId = parseId(request.params.clientId);
  const reportId = parseId(request.params.reportId);
  if (!clientId || !reportId) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Valid client and report identifiers are required.' } });
    return;
  }

  try {
    const file = await downloadMonthlyReport({
      organizationId: response.locals.organizationId,
      clientId,
      reportId,
      actorUserId: response.locals.session?.user?.id,
    });
    setReportHeaders(response, file);
    response.status(200).end(file.buffer);
  } catch (error) {
    sendError(response, error, 'The report could not be downloaded.');
  }
}

export async function getMonthlyReportScheduleController(request: Request, response: Response): Promise<void> {
  const clientId = parseId(request.params.clientId);
  if (!clientId) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid client identifier is required.' } });
    return;
  }

  try {
    if (!(await clientInWorkspace(response.locals.organizationId, clientId))) {
      response.status(404).json({ error: { code: 'CLIENT_NOT_FOUND', message: 'That client is not in this workspace.' } });
      return;
    }
    const schedule = await getMonthlyReportSchedule(response.locals.organizationId, clientId);
    response.json({ schedule });
  } catch (error) {
    sendError(response, error, 'The report schedule could not be read.');
  }
}

export async function putMonthlyReportScheduleController(request: Request, response: Response): Promise<void> {
  const clientId = parseId(request.params.clientId);
  const body = scheduleSchema.safeParse(request.body);
  if (!clientId) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid client identifier is required.' } });
    return;
  }
  if (!body.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_SCHEDULE',
        message: 'Choose a day from 1 to 28, an hour from 0 to 23, and up to 20 email addresses.',
      },
    });
    return;
  }

  try {
    const schedule = await upsertMonthlyReportSchedule({
      organizationId: response.locals.organizationId,
      clientId,
      actorUserId: response.locals.session?.user?.id,
      ...body.data,
    });
    response.json({ schedule });
  } catch (error) {
    sendError(response, error, 'The report schedule could not be saved.');
  }
}

export async function deleteMonthlyReportScheduleController(request: Request, response: Response): Promise<void> {
  const clientId = parseId(request.params.clientId);
  if (!clientId) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid client identifier is required.' } });
    return;
  }

  try {
    if (!(await clientInWorkspace(response.locals.organizationId, clientId))) {
      response.status(404).json({ error: { code: 'CLIENT_NOT_FOUND', message: 'That client is not in this workspace.' } });
      return;
    }
    await deleteMonthlyReportSchedule({
      organizationId: response.locals.organizationId,
      clientId,
      actorUserId: response.locals.session?.user?.id,
    });
    response.status(204).end();
  } catch (error) {
    sendError(response, error, 'The report schedule could not be removed.');
  }
}

/**
 * Public download by emailed token.
 *
 * Unknown, expired and malformed tokens answer with exactly the same 404, so
 * the endpoint cannot be used to test whether a token was ever real. The
 * response names nothing and carries no cookie or referrer onward.
 */
export async function publicMonthlyReportDownloadController(request: Request, response: Response): Promise<void> {
  const token = typeof request.query.token === 'string' ? request.query.token : '';

  try {
    const file = await downloadMonthlyReportByToken(token);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Length', String(file.buffer.length));
    response.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    response.setHeader('X-DMARC-Pack-Sha256', file.hash);
    response.setHeader('X-DMARC-Pack-Reference', file.reference);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.status(200).end(file.buffer);
  } catch (error) {
    if (error instanceof InvalidReportLinkError) {
      response.status(404).json({ error: { code: 'REPORT_LINK_NOT_FOUND', message: error.message } });
      return;
    }
    if (error instanceof MonthlyReportError && error.code === 'REPORT_CORRUPT') {
      response.status(500).json({ error: { code: 'REPORT_CORRUPT', message: error.message } });
      return;
    }
    console.error(`[monthly-reports] public download failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    response.status(500).json({ error: { code: 'INTERNAL', message: 'The report could not be downloaded.' } });
  }
}

async function portalClientAllowed(response: Response, clientId: string): Promise<boolean> {
  const clientIds = (response.locals.portalClientIds as string[] | undefined) ?? [];
  const email = response.locals.session?.user?.email as string | undefined;
  if (!clientIds.includes(clientId) || !email) {
    return false;
  }
  return hasPortalAccess(response.locals.organizationId as string, clientId, email);
}

export async function portalListMonthlyReportsController(request: Request, response: Response): Promise<void> {
  const clientId = parseId(request.params.clientId);
  if (!clientId || !(await portalClientAllowed(response, clientId))) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That report is not available to this account.' } });
    return;
  }

  const reports = await listMonthlyReports(response.locals.organizationId, clientId, {
    includeSuperseded: false,
  });
  response.json({ reports });
}

export async function portalDownloadMonthlyReportController(request: Request, response: Response): Promise<void> {
  const clientId = parseId(request.params.clientId);
  const reportId = parseId(request.params.reportId);
  if (!clientId || !reportId || !(await portalClientAllowed(response, clientId))) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'That report is not available to this account.' } });
    return;
  }

  try {
    const file = await downloadMonthlyReport({
      organizationId: response.locals.organizationId,
      clientId,
      reportId,
      actorUserId: response.locals.session?.user?.id,
      currentOnly: true,
    });
    setReportHeaders(response, file);
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.status(200).end(file.buffer);
  } catch (error) {
    if (error instanceof MonthlyReportError) {
      response.status(error.status === 410 ? 404 : error.status).json({
        error: { code: error.status === 410 ? 'NOT_FOUND' : error.code, message: error.status === 410 ? 'That report is not available to this account.' : error.message },
      });
      return;
    }
    sendError(response, error, 'The report could not be downloaded.');
  }
}
