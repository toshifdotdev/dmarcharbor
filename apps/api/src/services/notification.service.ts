import { prisma } from '../database/prisma.js';

export type NotificationSeverityName = 'INFO' | 'WARNING' | 'CRITICAL';

export interface CreateAlertNotificationsInput {
  alertEventId: string;
  organizationId: string;
  domainName: string;
  ruleName: string;
  summary: string;
  recipientUserIds: string[];
  reminderLevel: number;
}

export async function createAlertNotifications(input: CreateAlertNotificationsInput): Promise<number> {
  if (input.recipientUserIds.length === 0) {
    return 0;
  }

  const severity: NotificationSeverityName = input.reminderLevel >= 2 ? 'CRITICAL' : 'WARNING';
  const title =
    input.reminderLevel >= 2
      ? `Unacknowledged: ${input.domainName} ${input.ruleName}`
      : `${input.domainName}: ${input.ruleName}`;

  const body =
    input.reminderLevel >= 2
      ? `${input.summary} Nobody has acknowledged this yet.`
      : input.summary;

  const members = await prisma.member.findMany({
    where: { organizationId: input.organizationId, userId: { in: input.recipientUserIds } },
    select: { userId: true },
  });

  if (members.length === 0) {
    return 0;
  }

  const result = await prisma.notification.createMany({
    data: members.map((member) => ({
      userId: member.userId,
      organizationId: input.organizationId,
      kind: 'ALERT' as const,
      severity,
      title,
      body,
      link: '/alerts',
      alertEventId: input.alertEventId,
      reminderLevel: input.reminderLevel,
    })),
    skipDuplicates: true,
  });

  return result.count;
}

export async function listNotifications(
  userId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
) {
  return prisma.notification.findMany({
    where: {
      userId,
      readAt: options.unreadOnly ? null : undefined,
    },
    select: {
      id: true,
      kind: true,
      severity: true,
      title: true,
      body: true,
      link: true,
      readAt: true,
      createdAt: true,
      organization: { select: { id: true, name: true } },
      alertEvent: { select: { id: true, domainId: true, acknowledgedAt: true, resolvedAt: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(options.limit ?? 50, 1), 200),
  });
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<'read' | 'not_found' | 'already_read'> {
  const existing = await prisma.notification.findFirst({
    where: { id: notificationId, userId },
    select: { id: true, readAt: true },
  });

  if (!existing) {
    return 'not_found';
  }

  if (existing.readAt) {
    return 'already_read';
  }

  await prisma.notification.update({
    where: { id: existing.id },
    data: { readAt: new Date() },
  });

  return 'read';
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });

  return result.count;
}
