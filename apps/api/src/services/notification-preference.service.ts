import { prisma } from '../database/prisma.js';

const quietHoursPattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface NotificationPreferenceView {
  emailAlerts: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  onlyHighRiskAlerts: boolean;
}

export async function getNotificationPreference(userId: string): Promise<NotificationPreferenceView> {
  const existing = await prisma.notificationPreference.findUnique({
    where: { userId },
    select: { emailAlerts: true, quietHoursStart: true, quietHoursEnd: true, onlyHighRiskAlerts: true },
  });

  if (existing) {
    return existing;
  }

  return { emailAlerts: true, quietHoursStart: null, quietHoursEnd: null, onlyHighRiskAlerts: false };
}

export async function updateNotificationPreference(
  userId: string,
  changes: {
    emailAlerts?: boolean;
    quietHoursStart?: string | null;
    quietHoursEnd?: string | null;
    onlyHighRiskAlerts?: boolean;
  },
): Promise<NotificationPreferenceView> {
  const view: NotificationPreferenceView = {
    emailAlerts: changes.emailAlerts ?? true,
    quietHoursStart: changes.quietHoursStart ?? null,
    quietHoursEnd: changes.quietHoursEnd ?? null,
    onlyHighRiskAlerts: changes.onlyHighRiskAlerts ?? false,
  };

  if ((view.quietHoursStart && !quietHoursPattern.test(view.quietHoursStart)) || (view.quietHoursEnd && !quietHoursPattern.test(view.quietHoursEnd))) {
    throw new Error('Quiet hours must use 24-hour HH:MM format.');
  }

  if (Boolean(view.quietHoursStart) !== Boolean(view.quietHoursEnd)) {
    throw new Error('Both quietHoursStart and quietHoursEnd must be provided together.');
  }

  await prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId, ...view },
    update: view,
  });

  return view;
}
