import { prisma } from '../database/prisma.js';
import { isValidTimeZone } from './alert.service.js';

const quietHoursPattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface NotificationPreferenceView {
  emailAlerts: boolean;
  timezone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  onlyHighRiskAlerts: boolean;
}

const preferenceSelect = {
  emailAlerts: true,
  timezone: true,
  quietHoursStart: true,
  quietHoursEnd: true,
  onlyHighRiskAlerts: true,
} as const;

export async function getNotificationPreference(userId: string): Promise<NotificationPreferenceView> {
  const existing = await prisma.notificationPreference.findUnique({
    where: { userId },
    select: preferenceSelect,
  });

  if (existing) {
    return existing;
  }

  return { emailAlerts: true, timezone: 'UTC', quietHoursStart: null, quietHoursEnd: null, onlyHighRiskAlerts: false };
}

export async function updateNotificationPreference(
  userId: string,
  changes: {
    emailAlerts?: boolean;
    timezone?: string;
    quietHoursStart?: string | null;
    quietHoursEnd?: string | null;
    onlyHighRiskAlerts?: boolean;
  },
): Promise<NotificationPreferenceView> {
  const current = await getNotificationPreference(userId);

  const timezone = changes.timezone?.trim() ?? current.timezone;
  if (!isValidTimeZone(timezone)) {
    throw new Error(`"${timezone}" is not a valid IANA timezone, for example Europe/Berlin.`);
  }

  const view: NotificationPreferenceView = {
    emailAlerts: changes.emailAlerts ?? current.emailAlerts,
    timezone,
    quietHoursStart: changes.quietHoursStart === undefined ? current.quietHoursStart : changes.quietHoursStart,
    quietHoursEnd: changes.quietHoursEnd === undefined ? current.quietHoursEnd : changes.quietHoursEnd,
    onlyHighRiskAlerts: changes.onlyHighRiskAlerts ?? current.onlyHighRiskAlerts,
  };

  if (changes.quietHoursStart !== undefined || changes.quietHoursEnd !== undefined) {
    if (!changes.quietHoursStart || !changes.quietHoursEnd) {
      throw new Error('Provide both quietHoursStart and quietHoursEnd together, or neither.');
    }
  }

  if (view.quietHoursStart && !quietHoursPattern.test(view.quietHoursStart)) {
    throw new Error('Quiet hours must use 24-hour HH:MM format.');
  }
  if (view.quietHoursEnd && !quietHoursPattern.test(view.quietHoursEnd)) {
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
