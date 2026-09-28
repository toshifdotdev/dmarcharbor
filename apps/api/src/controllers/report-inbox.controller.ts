import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../database/prisma.js';
import { InboxError, configureInbox, disableInbox, inboxStatus, pollInbox, recordInboxFailure } from '../services/report/imap-inbox.service.js';
import { recordAuditEvent } from '../services/audit.service.js';

/**
 * Mailbox settings for emailed report collection.
 *
 * The password is never returned. Only the host and username come back, which
 * is what support needs to tell a customer why collection is not working
 * without the account password ever leaving the server.
 */
const settingsSchema = z.object({
  host: z.string().trim().min(3).max(253),
  port: z.number().int().positive().max(65535).optional(),
  secure: z.boolean().optional(),
  username: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(512),
});

function sendError(response: Response, error: unknown): void {
  if (error instanceof InboxError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }

  response.status(500).json({ error: { code: 'INBOX_ERROR', message: 'The mailbox could not be reached.' } });
}

export async function getInboxController(_request: Request, response: Response): Promise<void> {
  response.json(await inboxStatus(response.locals.organizationId));
}

export async function configureInboxController(request: Request, response: Response): Promise<void> {
  const body = settingsSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'Provide a mail host, username and password.' },
    });
    return;
  }

  const organizationId = response.locals.organizationId;

  try {
    await configureInbox(organizationId, body.data);
  } catch (error) {
    sendError(response, error);
    return;
  }

  // A mailbox password is account level access, so who set it and when is
  // something a security reviewer will ask for later.
  await recordAuditEvent({
    organizationId,
    action: 'REPORT_INBOX_CONFIGURED',
    targetType: 'ReportInbox',
    // The host and username only. The password is never written to the audit
    // trail, so the log cannot become a second copy of the credential.
    detail: { host: body.data.host, username: body.data.username },
  });

  response.json(await inboxStatus(organizationId));
}

export async function deleteInboxController(_request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  await disableInbox(organizationId);
  await prisma.reportInbox.deleteMany({ where: { organizationId } });

  await recordAuditEvent({
    organizationId,
    action: 'REPORT_INBOX_REMOVED',
    targetType: 'ReportInbox',
  });

  response.status(204).end();
}

export async function pollInboxController(_request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;

  try {
    const outcome = await pollInbox(organizationId);
    response.json(outcome);
  } catch (error) {
    // A failure is recorded against the mailbox so the next status read shows
    // why collection stopped, rather than the error vanishing into a log the
    // customer cannot see.
    await recordInboxFailure(organizationId, error instanceof Error ? error.message : 'Unknown IMAP failure');
    sendError(response, error);
  }
}
