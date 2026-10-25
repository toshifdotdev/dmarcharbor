import { prisma } from '../../database/prisma.js';
import { env } from '../../config/env.js';
import { recordAuditEvent } from '../audit.service.js';
import { queueEmail } from '../../email/email.service.js';
import { monthlyReportEmail } from '../../email/templates.js';
import { resolveBranding } from '../branding.service.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import {
  isMonthlyScheduleDue,
  nextMonthlyIssueDate,
  percentageText,
  previousCompleteMonth,
  MonthlyReportError,
  type MonthlyPeriod,
} from './monthly-period.js';
import { issueMonthlyReport, normaliseRecipients } from './monthly-report.service.js';

const maximumSchedulesPerRun = 25;

export interface MonthlyReportScheduleView {
  id: string;
  enabled: boolean;
  dayOfMonth: number;
  sendHourUtc: number;
  recipientEmails: string[];
  lastIssuedPeriod: string | null;
  nextIssueAt: string | null;
}

function toView(
  row: {
    id: string;
    enabled: boolean;
    dayOfMonth: number;
    sendHourUtc: number;
    recipientEmails: string[];
    lastIssuedPeriod: string | null;
  },
  now: Date,
): MonthlyReportScheduleView {
  return {
    id: row.id,
    enabled: row.enabled,
    dayOfMonth: row.dayOfMonth,
    sendHourUtc: row.sendHourUtc,
    recipientEmails: [...row.recipientEmails],
    lastIssuedPeriod: row.lastIssuedPeriod,
    nextIssueAt: row.enabled ? nextMonthlyIssueDate(row, now).toISOString() : null,
  };
}

export async function getMonthlyReportSchedule(
  organizationId: string,
  clientId: string,
  now = new Date(),
): Promise<MonthlyReportScheduleView | null> {
  const row = await prisma.monthlyReportSchedule.findFirst({
    where: { organizationId, clientId, client: { organizationId } },
  });
  return row ? toView(row, now) : null;
}

export async function upsertMonthlyReportSchedule(input: {
  organizationId: string;
  clientId: string;
  actorUserId?: string | null;
  enabled?: boolean;
  dayOfMonth: number;
  sendHourUtc: number;
  recipientEmails: string[];
  now?: Date;
}): Promise<MonthlyReportScheduleView> {
  const now = input.now ?? new Date();
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, organizationId: input.organizationId },
    select: { id: true },
  });
  if (!client) {
    throw new MonthlyReportError('That client is not in this workspace.', 'CLIENT_NOT_FOUND', 404);
  }

  const recipients = normaliseRecipients(input.recipientEmails);
  const row = await prisma.monthlyReportSchedule.upsert({
    where: { clientId: client.id },
    create: {
      organizationId: input.organizationId,
      clientId: client.id,
      enabled: input.enabled ?? true,
      dayOfMonth: input.dayOfMonth,
      sendHourUtc: input.sendHourUtc,
      recipientEmails: recipients,
      createdById: input.actorUserId ?? null,
    },
    update: {
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      dayOfMonth: input.dayOfMonth,
      sendHourUtc: input.sendHourUtc,
      recipientEmails: recipients,
    },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'MONTHLY_REPORT_SCHEDULE_UPDATED',
    targetType: 'monthly_report_schedule',
    targetId: row.id,
    detail: {
      clientId: client.id,
      enabled: row.enabled,
      dayOfMonth: row.dayOfMonth,
      sendHourUtc: row.sendHourUtc,
      recipientCount: recipients.length,
    },
  });

  return toView(row, now);
}

export async function deleteMonthlyReportSchedule(input: {
  organizationId: string;
  clientId: string;
  actorUserId?: string | null;
}): Promise<boolean> {
  const existing = await prisma.monthlyReportSchedule.findFirst({
    where: { organizationId: input.organizationId, clientId: input.clientId, client: { organizationId: input.organizationId } },
    select: { id: true },
  });
  if (!existing) {
    return false;
  }

  await prisma.monthlyReportSchedule.delete({ where: { id: existing.id } });
  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'MONTHLY_REPORT_SCHEDULE_DELETED',
    targetType: 'monthly_report_schedule',
    targetId: existing.id,
    detail: { clientId: input.clientId },
  });
  return true;
}

export interface MonthlyScheduleRunResult {
  examined: number;
  claimed: number;
  issued: number;
  emailed: number;
  failed: number;
  skipped: number;
}

function startOfUtcMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

/**
 * Issues and emails the previous month's report for every due schedule.
 *
 * The claim is the same shape the digest scheduler uses: an update keyed on
 * the value that was read. Two replicas that both see a due schedule cannot
 * both move it, so neither the report nor its emails are sent twice.
 *
 * A failure before any email has been queued puts the old month back, which is
 * what lets the next run retry. A failure after an email was queued leaves the
 * claim in place: a missing email is better than a duplicate to every recipient
 * on the schedule.
 */
export async function runMonthlyReportSchedules(now = new Date()): Promise<MonthlyScheduleRunResult> {
  const previousKey = previousCompleteMonth(now).key;
  const schedules = await prisma.monthlyReportSchedule.findMany({
    /**
     * Only schedules that still owe last month's report.
     *
     * Reading `enabled` alone and ordering by creation date returned the same
     * first 25 rows every run, already issued or not, so the 26th schedule and
     * every one after it never sent a report at all.
     */
    where: {
      enabled: true,
      OR: [{ lastIssuedPeriod: null }, { lastIssuedPeriod: { not: previousKey } }],
    },
    include: {
      client: { select: { id: true, name: true, createdAt: true, organizationId: true } },
      organization: { select: { id: true, name: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: maximumSchedulesPerRun,
  });

  const result: MonthlyScheduleRunResult = {
    examined: schedules.length,
    claimed: 0,
    issued: 0,
    emailed: 0,
    failed: 0,
    skipped: 0,
  };

  const previous = previousCompleteMonth(now);
  const entitlementCache = new Map<string, boolean>();

  for (const schedule of schedules) {
    if (schedule.lastIssuedPeriod === previous.key) {
      result.skipped += 1;
      continue;
    }
    if (!isMonthlyScheduleDue(schedule, now)) {
      result.skipped += 1;
      continue;
    }
    // A client that did not exist in the month has no evidence for it. Skipping
    // lets the schedule start with its first full month instead of failing every
    // run against the period validation.
    if (previous.start.getTime() < startOfUtcMonth(schedule.client.createdAt).getTime()) {
      result.skipped += 1;
      continue;
    }

    let licensed = entitlementCache.get(schedule.organizationId);
    if (licensed === undefined) {
      licensed = (await resolveEntitlements(schedule.organizationId, now)).features['reports.compliancePack'];
      entitlementCache.set(schedule.organizationId, licensed);
    }
    if (!licensed) {
      result.skipped += 1;
      continue;
    }

    const claim = await prisma.monthlyReportSchedule.updateMany({
      where: { id: schedule.id, lastIssuedPeriod: schedule.lastIssuedPeriod },
      data: { lastIssuedPeriod: previous.key },
    });
    if (claim.count !== 1) {
      result.skipped += 1;
      continue;
    }
    result.claimed += 1;

    let emailsQueued = 0;
    try {
      const issued = await issueMonthlyReport({
        clientId: schedule.clientId,
        organizationId: schedule.organizationId,
        period: previous.key,
        actorUserId: null,
        now,
        recipients: schedule.recipientEmails,
      });
      result.issued += 1;

      const brand = await resolveBranding(schedule.organizationId);
      const passRate = percentageText(issued.summary.dmarcPass, issued.summary.messages);

      for (const link of issued.links) {
        const email = monthlyReportEmail({
          brand: {
            workspaceName: brand.workspaceName,
            logoUrl: brand.logoUrl,
            primaryColor: brand.primaryColor,
            accentColor: brand.accentColor,
          },
          branded: brand.branded,
          agencyName: schedule.organization.name,
          clientName: schedule.client.name,
          periodLabel: previous.label,
          messages: issued.summary.messages,
          passRate,
          domainsAtReject: issued.summary.domainsAtReject,
          downloadUrl: `${env.APP_URL.replace(/\/$/, '')}/reports/download?token=${encodeURIComponent(link.token)}`,
          reference: issued.reference,
          verifyUrl: `${issued.verifyBase}/verify?reference=${encodeURIComponent(issued.reference)}`,
        });
        queueEmail(
          email,
          link.recipientEmail,
          `monthly-report:${schedule.id}:${previous.key}:${link.recipientEmail}`,
        );
        emailsQueued += 1;
      }
      result.emailed += emailsQueued;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      console.error(`[monthly-reports] schedule ${schedule.id} failed: ${detail}`);
      if (emailsQueued === 0) {
        await prisma.monthlyReportSchedule
          .updateMany({
            where: { id: schedule.id, lastIssuedPeriod: previous.key },
            data: { lastIssuedPeriod: schedule.lastIssuedPeriod },
          })
          .catch(() => undefined);
      }
      result.failed += 1;
    }
  }

  return result;
}

export type { MonthlyPeriod };
