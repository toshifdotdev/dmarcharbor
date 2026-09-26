import type { Request, Response } from 'express';
import { prisma } from '../database/prisma.js';
import { resourceIdSchema } from '../models/client.model.js';
import { notificationListQuerySchema, reportDigestCreateSchema, reportDigestUpdateSchema } from '../models/notification.model.js';
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../services/notification.service.js';
import { getPortfolioOnboarding } from '../services/portfolio.service.js';
import {
  createReportDigest,
  deleteReportDigest,
  listReportDigests,
  runReportDigests,
  sendReportDigestNow,
  updateReportDigest,
} from '../services/report-digest.service.js';

function parseId(value: string | string[] | undefined): string | null {
  const parsed = resourceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function listNotificationsController(request: Request, response: Response): Promise<void> {
  const query = notificationListQuerySchema.safeParse(request.query);
  const userId = response.locals.session?.user?.id as string;

  const [notifications, unread] = await Promise.all([
    listNotifications(userId, {
      unreadOnly: query.success ? query.data.unreadOnly : false,
      limit: query.success ? query.data.limit : undefined,
    }),
    countUnreadNotifications(userId),
  ]);

  response.json({ notifications, unread });
}

export async function unreadCountController(_request: Request, response: Response): Promise<void> {
  const userId = response.locals.session?.user?.id as string;
  response.json({ unread: await countUnreadNotifications(userId) });
}

export async function markNotificationReadController(request: Request, response: Response): Promise<void> {
  const notificationId = parseId(request.params.notificationId);
  if (!notificationId) {
    response.status(400).json({ error: { message: 'A valid notification identifier is required.' } });
    return;
  }

  const outcome = await markNotificationRead(response.locals.session?.user?.id as string, notificationId);

  if (outcome === 'not_found') {
    response.status(404).json({ error: { message: 'Notification not found.' } });
    return;
  }

  if (outcome === 'already_read') {
    response.status(409).json({ error: { message: 'This notification is already marked as read.' } });
    return;
  }

  response.json({ read: true });
}

export async function markAllNotificationsReadController(_request: Request, response: Response): Promise<void> {
  const marked = await markAllNotificationsRead(response.locals.session?.user?.id as string);
  response.json({ marked });
}

export async function portfolioOnboardingController(_request: Request, response: Response): Promise<void> {
  response.json(await getPortfolioOnboarding(response.locals.organizationId));
}

export async function createReportDigestController(request: Request, response: Response): Promise<void> {
  const body = reportDigestCreateSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: { message: 'A valid domain, frequency and recipient list are required.' } });
    return;
  }

  const digest = await createReportDigest({
    organizationId: response.locals.organizationId,
    domainId: body.data.domainId,
    createdById: response.locals.session?.user?.id,
    frequency: body.data.frequency,
    sendHourUtc: body.data.sendHourUtc ?? 9,
    weekday: body.data.weekday ?? 1,
    dayOfMonth: body.data.dayOfMonth ?? 1,
    recipientEmails: body.data.recipientEmails,
    includeForensics: body.data.includeForensics,
  });

  if (!digest) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  response.status(201).json(digest);
}

export async function listReportDigestsController(_request: Request, response: Response): Promise<void> {
  response.json(await listReportDigests(response.locals.organizationId));
}

export async function updateReportDigestController(request: Request, response: Response): Promise<void> {
  const digestId = parseId(request.params.digestId);
  const body = reportDigestUpdateSchema.safeParse(request.body);

  if (!digestId || !body.success) {
    response.status(400).json({ error: { message: 'A valid digest and updates are required.' } });
    return;
  }

  const digest = await updateReportDigest(response.locals.organizationId, digestId, body.data);
  if (!digest) {
    response.status(404).json({ error: { message: 'Report digest not found in this workspace.' } });
    return;
  }

  response.json(digest);
}

export async function deleteReportDigestController(request: Request, response: Response): Promise<void> {
  const digestId = parseId(request.params.digestId);
  if (!digestId) {
    response.status(400).json({ error: { message: 'A valid digest identifier is required.' } });
    return;
  }

  const deleted = await deleteReportDigest(response.locals.organizationId, digestId);
  if (!deleted) {
    response.status(404).json({ error: { message: 'Report digest not found in this workspace.' } });
    return;
  }

  response.status(204).send();
}

export async function sendReportDigestController(request: Request, response: Response): Promise<void> {
  const digestId = parseId(request.params.digestId);
  if (!digestId) {
    response.status(400).json({ error: { message: 'A valid digest identifier is required.' } });
    return;
  }

  const digest = await prismaDigestExists(response.locals.organizationId, digestId);
  if (!digest) {
    response.status(404).json({ error: { message: 'Report digest not found in this workspace.' } });
    return;
  }

  const content = await sendReportDigestNow(digestId);
  if (!content) {
    response.status(400).json({ error: { message: 'The digest could not be built for this domain.' } });
    return;
  }

  response.json({ sent: true, recipients: content.recipientCount, subject: content.subject, preview: content.text });
}

export async function runDigestsNowController(_request: Request, response: Response): Promise<void> {
  const results = await runReportDigests();
  response.json({ processed: results.length, sent: results.filter((result) => result.sent).length });
}

async function prismaDigestExists(organizationId: string, digestId: string): Promise<boolean> {
  const found = await prisma.reportDigest.findFirst({
    where: { id: digestId, organizationId },
    select: { id: true },
  });
  return Boolean(found);
}
