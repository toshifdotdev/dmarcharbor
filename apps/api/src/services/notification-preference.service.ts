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

  /**
   * A half-configured quiet-hours window has to be refused, because "start at
   * 22:00 with no end" is not a window, it is an alert suppression that never
   * lifts.
   *
   * Clearing both to null is not that case and used to be rejected by accident:
   * the guard tested truthiness of the incoming fields, so `null` read as
   * "missing" rather than "explicitly off". A user who had once set quiet hours
   * could not turn them off again, and the only way out was a different browser.
   * The check is on presence instead, which distinguishes an absent field from
   * a deliberate null.
   */
  if (changes.quietHoursStart !== undefined || changes.quietHoursEnd !== undefined) {
    const clearingBoth =
      changes.quietHoursStart === null &&
      changes.quietHoursEnd === null;
    const settingOne = Boolean(changes.quietHoursStart) !== Boolean(changes.quietHoursEnd);

    if (!clearingBoth && settingOne) {
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
