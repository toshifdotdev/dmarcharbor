import type { AlertDeliveryStatus, AlertMetric, AlertOperator, Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { env } from '../config/env.js';
import { sendAuthEmail } from '../email/email.service.js';
import { createAlertNotifications } from './notification.service.js';
import { resolveLimit } from '../utils/pagination.js';

const riskByMetric: Record<AlertMetric, 'high' | 'medium'> = {
  FAILURE_COUNT: 'high',
  FAILURE_RATE: 'high',
  SOURCE_IP_VOLUME: 'high',
  FORENSIC_FAILURES: 'high',
  REPORT_SILENCE: 'medium',
};

const maxLookbackMinutes = 43_200;

const ruleInclude = {
  domain: { select: { id: true, name: true } },
  recipients: { select: { userId: true } },
  organization: { select: { id: true, name: true, slug: true } },
} as const;

type PersistedRule = Prisma.AlertRuleGetPayload<{ include: typeof ruleInclude }>;

export interface DomainSnapshot {
  domainId: string;
  windowMinutes: number;
  aggregateRecords: { sourceIp: string; messageCount: number; failed: boolean; receivedAt: Date }[];
  forensicRows: { sourceIp: string; rejected: boolean; receivedAt: Date; recipientCount: number }[];
  totalMessages: number;
  failedMessages: number;
  failureRate: number;
  busiestSourceMessages: number;
  busiestSourceIp: string | null;
  forensicCount: number;
  forensicRejections: number;
  hoursSinceLastReport: number | null;
}

function isPass(value: string | null): boolean {
  return (value ?? '').trim().toLowerCase() === 'pass';
}

function evaluate(operator: AlertOperator, observed: number, threshold: number): boolean {
  if (operator === 'GREATER_THAN') {
    return observed > threshold;
  }
  if (operator === 'GREATER_THAN_OR_EQUAL') {
    return observed >= threshold;
  }
  return observed < threshold;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function parseHour(value: string | null | undefined): number | null {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) {
    return null;
  }

  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3, 5));
  if (hours > 23 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function localMinutes(at: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);

    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (Number.isFinite(hour) && Number.isFinite(minute)) {
      return hour * 60 + minute;
    }
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }

  return at.getUTCHours() * 60 + at.getUTCMinutes();
}

export function isWithinQuietHours(
  quietHoursStart: string | null,
  quietHoursEnd: string | null,
  at: Date,
  timeZone = 'UTC',
): boolean {
  const start = parseHour(quietHoursStart);
  const end = parseHour(quietHoursEnd);
  if (start === null || end === null || start === end) {
    return false;
  }

  const minutes = localMinutes(at, isValidTimeZone(timeZone) ? timeZone : 'UTC');
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export async function createAlertRule(input: {
  organizationId: string;
  domainId: string;
  createdById: string | undefined;
  name: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  maxReminderLevel: number;
  recipientUserIds: string[];
}): Promise<PersistedRule | null> {
  const domain = await prisma.domain.findFirst({
    where: { id: input.domainId, client: { organizationId: input.organizationId } },
    select: { id: true },
  });

  if (!domain) {
    return null;
  }

  const members = await prisma.member.findMany({
    where: { organizationId: input.organizationId, userId: { in: input.recipientUserIds } },
    select: { userId: true },
  });

  return prisma.alertRule.create({
    data: {
      organizationId: input.organizationId,
      domainId: domain.id,
      createdById: input.createdById ?? null,
      name: input.name,
      metric: input.metric,
      operator: input.operator,
      threshold: input.threshold,
      windowMinutes: clamp(input.windowMinutes, 5, maxLookbackMinutes),
      cooldownMinutes: clamp(input.cooldownMinutes, 5, maxLookbackMinutes),
      maxReminderLevel: clamp(input.maxReminderLevel, 1, 5),
      recipients: {
        create: members.map((member) => ({ userId: member.userId })),
      },
    },
    include: ruleInclude,
  });
}

export async function listAlertRules(
  organizationId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<PersistedRule[]> {
  const limit = resolveLimit(options.limit);
  return prisma.alertRule.findMany({
    where: { organizationId },
    include: ruleInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });
}

export async function getAlertRule(organizationId: string, ruleId: string): Promise<PersistedRule | null> {
  return prisma.alertRule.findFirst({
    where: { id: ruleId, organizationId },
    include: ruleInclude,
  });
}

export async function updateAlertRule(
  organizationId: string,
  ruleId: string,
  changes: {
    name?: string;
    threshold?: number;
    windowMinutes?: number;
    cooldownMinutes?: number;
    maxReminderLevel?: number;
    enabled?: boolean;
    recipientUserIds?: string[];
  },
): Promise<PersistedRule | null> {
  const rule = await prisma.alertRule.findFirst({
    where: { id: ruleId, organizationId },
    select: { id: true },
  });

  if (!rule) {
    return null;
  }

  return prisma.$transaction(async (transaction) => {
    if (changes.recipientUserIds) {
      const members = await transaction.member.findMany({
        where: { organizationId, userId: { in: changes.recipientUserIds } },
        select: { userId: true },
      });

      await transaction.alertRecipient.deleteMany({ where: { ruleId: rule.id } });
      if (members.length) {
        await transaction.alertRecipient.createMany({
          data: members.map((member) => ({ ruleId: rule.id, userId: member.userId })),
        });
      }
    }

    return transaction.alertRule.update({
      where: { id: rule.id },
      data: {
        name: changes.name,
        threshold: changes.threshold === undefined ? undefined : Math.max(0, changes.threshold),
        windowMinutes:
          changes.windowMinutes === undefined ? undefined : clamp(changes.windowMinutes, 5, maxLookbackMinutes),
        cooldownMinutes:
          changes.cooldownMinutes === undefined ? undefined : clamp(changes.cooldownMinutes, 5, maxLookbackMinutes),
        maxReminderLevel:
          changes.maxReminderLevel === undefined ? undefined : clamp(changes.maxReminderLevel, 1, 5),
        enabled: changes.enabled,
      },
      include: ruleInclude,
    });
  });
}

export async function deleteAlertRule(organizationId: string, ruleId: string): Promise<boolean> {
  const result = await prisma.alertRule.deleteMany({ where: { id: ruleId, organizationId } });
  return result.count > 0;
}

export async function listAlertEvents(
  organizationId: string,
  options: { domainId?: string; limit?: number; cursor?: string } = {},
): Promise<{
  rows: Prisma.AlertEventGetPayload<{
    include: { domain: { select: { id: true; name: true } }; rule: { select: { id: true; name: true } } };
  }>[];
  limit: number;
}> {
  const limit = resolveLimit(options.limit);
  const rows = await prisma.alertEvent.findMany({
    where: {
      organizationId,
      domainId: options.domainId,
    },
    include: {
      domain: { select: { id: true, name: true } },
      rule: { select: { id: true, name: true } },
    },
    orderBy: [{ triggeredAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  return { rows, limit };
}

export async function buildDomainSnapshot(domainId: string, windowMinutes: number, now = new Date()): Promise<DomainSnapshot> {
  const window = clamp(windowMinutes, 5, maxLookbackMinutes);
  const since = new Date(now.getTime() - window * 60 * 1000);

  const [reports, forensics, lastReport, lastForensic] = await Promise.all([
    prisma.dmarcReport.findMany({
      where: { domainId, receivedAt: { gte: since } },
      select: {
        receivedAt: true,
        records: {
          select: { sourceIp: true, messageCount: true, dkimResult: true, spfResult: true },
        },
      },
      take: 500,
    }),
    prisma.dmarcForensicReport.findMany({
      where: { domainId, receivedAt: { gte: since } },
      select: { sourceIp: true, disposition: true, receivedAt: true, recipientCount: true },
      take: 2_000,
    }),
    prisma.dmarcReport.findFirst({
      where: { domainId },
      select: { receivedAt: true },
      orderBy: { receivedAt: 'desc' },
    }),
    prisma.dmarcForensicReport.findFirst({
      where: { domainId },
      select: { receivedAt: true },
      orderBy: { receivedAt: 'desc' },
    }),
  ]);

  const perSource = new Map<string, number>();
  let totalMessages = 0;
  let failedMessages = 0;

  const aggregateRecords = reports.flatMap((report) =>
    report.records.map((record) => {
      const failed = !isPass(record.dkimResult) || !isPass(record.spfResult);
      totalMessages += record.messageCount;
      if (failed) {
        failedMessages += record.messageCount;
      }
      perSource.set(record.sourceIp, (perSource.get(record.sourceIp) ?? 0) + record.messageCount);
      return { sourceIp: record.sourceIp, messageCount: record.messageCount, failed, receivedAt: report.receivedAt };
    }),
  );

  let busiestSourceIp: string | null = null;
  let busiestSourceMessages = 0;
  for (const [sourceIp, count] of perSource) {
    if (count > busiestSourceMessages) {
      busiestSourceIp = sourceIp;
      busiestSourceMessages = count;
    }
  }

  const forensicRejections = forensics.filter(
    (row) => row.disposition === 'reject' || row.disposition === 'quarantine',
  ).length;

  const lastSeen = [lastReport?.receivedAt, lastForensic?.receivedAt]
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => right.getTime() - left.getTime())[0];

  return {
    domainId,
    windowMinutes: window,
    aggregateRecords,
    forensicRows: forensics.map((row) => ({
      sourceIp: row.sourceIp,
      rejected: row.disposition === 'reject' || row.disposition === 'quarantine',
      receivedAt: row.receivedAt,
      recipientCount: row.recipientCount,
    })),
    totalMessages,
    failedMessages,
    failureRate: totalMessages ? Math.round((failedMessages / totalMessages) * 100) : 0,
    busiestSourceMessages,
    busiestSourceIp,
    forensicCount: forensics.length,
    forensicRejections,
    hoursSinceLastReport: lastSeen ? Math.round(((now.getTime() - lastSeen.getTime()) / 3_600_000) * 100) / 100 : null,
  };
}

function observedFor(snapshot: DomainSnapshot, metric: AlertMetric): number | null {
  switch (metric) {
    case 'FAILURE_COUNT':
      return snapshot.failedMessages;
    case 'FAILURE_RATE':
      return snapshot.failureRate;
    case 'SOURCE_IP_VOLUME':
      return snapshot.busiestSourceMessages;
    case 'FORENSIC_FAILURES':
      return snapshot.forensicRejections;
    case 'REPORT_SILENCE':
      return snapshot.hoursSinceLastReport;
    default:
      return null;
  }
}

function summarise(
  rule: { metric: AlertMetric; operator: AlertOperator; threshold: number; windowMinutes: number },
  snapshot: DomainSnapshot,
  observed: number,
): string {
  const unit = rule.metric === 'FAILURE_RATE' ? '%' : rule.metric === 'REPORT_SILENCE' ? 'h' : ' messages';
  const comparison = rule.operator === 'LESS_THAN' ? 'below' : 'above';

  if (rule.metric === 'REPORT_SILENCE') {
    const last = snapshot.hoursSinceLastReport === null ? 'never' : `${snapshot.hoursSinceLastReport}h ago`;
    return `No DMARC report has been received since ${last}, which is ${comparison} the ${rule.threshold}h threshold.`;
  }

  if (rule.metric === 'SOURCE_IP_VOLUME' && snapshot.busiestSourceIp) {
    return `Source ${snapshot.busiestSourceIp} sent ${observed}${unit} in the last ${rule.windowMinutes} minutes, ${comparison} the ${rule.threshold}${unit} threshold.`;
  }

  return `Observed ${observed}${unit} in the last ${rule.windowMinutes} minutes, ${comparison} the ${rule.threshold}${unit} threshold.`;
}

function contextFor(snapshot: DomainSnapshot, metric: AlertMetric): Prisma.InputJsonValue {
  return {
    totalMessages: snapshot.totalMessages,
    failedMessages: snapshot.failedMessages,
    failureRate: snapshot.failureRate,
    busiestSourceIp: snapshot.busiestSourceIp,
    busiestSourceMessages: snapshot.busiestSourceMessages,
    forensicCount: snapshot.forensicCount,
    forensicRejections: snapshot.forensicRejections,
    hoursSinceLastReport: snapshot.hoursSinceLastReport,
    metric,
  };
}

export async function evaluateRule(
  rule: PersistedRule,
  now = new Date(),
): Promise<{ triggered: boolean; observed: number | null; snapshot: DomainSnapshot }> {
  const snapshot = await buildDomainSnapshot(rule.domainId, rule.windowMinutes, now);
  const observed = observedFor(snapshot, rule.metric);

  if (observed === null) {
    return { triggered: false, observed, snapshot };
  }

  return { triggered: evaluate(rule.operator, observed, rule.threshold), observed, snapshot };
}

async function deliverEvent(
  eventId: string,
  recipientUserIds: string[],
  organizationName: string,
  domainName: string,
  subject: string,
  body: string,
  risk: 'high' | 'medium',
  reminderLevel: number,
  now: Date,
): Promise<void> {
  if (recipientUserIds.length === 0) {
    return;
  }

  const users = await prisma.user.findMany({
    where: { id: { in: recipientUserIds } },
    select: {
      id: true,
      email: true,
      notificationPreference: {
        select: {
          emailAlerts: true,
          quietHoursStart: true,
          quietHoursEnd: true,
          onlyHighRiskAlerts: true,
          timezone: true,
        },
      },
    },
  });

  for (const user of users) {
    await deliverToUser(user, {
      eventId,
      kind: 'ALERT',
      subject,
      body,
      risk,
      reminderLevel,
      now,
    });
  }
}

async function deliverToUser(
  user: {
    id: string;
    email: string;
    notificationPreference: {
      emailAlerts: boolean;
      quietHoursStart: string | null;
      quietHoursEnd: string | null;
      onlyHighRiskAlerts: boolean;
      timezone: string;
    } | null;
  },
  options: {
    eventId: string;
    kind: 'ALERT' | 'ROLLUP';
    subject: string;
    body: string;
    risk: 'high' | 'medium';
    reminderLevel: number;
    now: Date;
  },
): Promise<void> {
  const { eventId, kind, subject, body, risk, reminderLevel, now } = options;
  const preference = user.notificationPreference;
  let status: AlertDeliveryStatus = 'PENDING';

  if (preference && !preference.emailAlerts) {
    status = 'SKIPPED_DISABLED';
  } else if (preference?.onlyHighRiskAlerts && risk !== 'high') {
    status = 'SKIPPED_DISABLED';
  } else if (
    preference &&
    isWithinQuietHours(preference.quietHoursStart, preference.quietHoursEnd, now, preference.timezone)
  ) {
    status = 'SKIPPED_QUIET_HOURS';
  }

  const delivery = await prisma.alertDelivery.create({
    data: { eventId, userId: user.id, channel: 'EMAIL', kind, status, reminderLevel },
  });

  if (status !== 'PENDING') {
    return;
  }

  try {
    await sendAuthEmail({ to: user.email, subject, text: body });
    await prisma.alertDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SENT', attempts: 1, sentAt: new Date() },
    });
  } catch (error) {
    await prisma.alertDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'FAILED',
        attempts: 1,
        lastError: error instanceof Error ? error.message : 'Unknown delivery error.',
      },
    });
  }
}

export interface RuleEvaluationResult {
  ruleId: string;
  outcome: 'triggered' | 'escalated' | 'unchanged' | 'resolved' | 'no_data';
  observed: number | null;
  eventId?: string;
  reminderLevel?: number;
}

function escalationSubject(rule: { domain: { name: string }; name: string }, reminderLevel: number): string {
  if (reminderLevel <= 1) {
    return `[DMARC Harbor] ${rule.domain.name}: ${rule.name}`;
  }
  if (reminderLevel === 2) {
    return `[DMARC Harbor] Unacknowledged: ${rule.domain.name} ${rule.name}`;
  }
  return `[DMARC Harbor] URGENT unacknowledged: ${rule.domain.name} ${rule.name}`;
}

function escalationNote(reminderLevel: number): string {
  if (reminderLevel <= 1) {
    return '';
  }
  if (reminderLevel === 2) {
    return 'Nobody has acknowledged this alert yet. If someone is already handling it, acknowledge it to stop further reminders.';
  }
  return 'This alert has been unacknowledged across multiple reminders. Escalate to whoever owns this domain.';
}

export async function evaluateAlertRules(now = new Date()): Promise<RuleEvaluationResult[]> {
  const rules = await prisma.alertRule.findMany({
    where: { enabled: true, domain: { status: 'VERIFIED' } },
    include: ruleInclude,
    orderBy: { id: 'asc' },
  });

  const results: RuleEvaluationResult[] = [];

  for (const rule of rules) {
    const snapshot = await buildDomainSnapshot(rule.domainId, rule.windowMinutes, now);
    const observed = observedFor(snapshot, rule.metric);

    if (observed === null) {
      results.push({ ruleId: rule.id, outcome: 'no_data', observed });
      continue;
    }

    const crossed = evaluate(rule.operator, observed, rule.threshold);
    const openEvent = await prisma.alertEvent.findFirst({
      where: { ruleId: rule.id, acknowledgedAt: null, resolvedAt: null },
      select: { id: true, triggeredAt: true, reminderLevel: true },
      orderBy: { triggeredAt: 'desc' },
    });

    if (!crossed) {
      if (openEvent) {
        await prisma.alertEvent.update({
          where: { id: openEvent.id },
          data: { resolvedAt: now },
        });
        results.push({ ruleId: rule.id, outcome: 'resolved', observed, eventId: openEvent.id });
      } else {
        results.push({ ruleId: rule.id, outcome: 'unchanged', observed });
      }
      continue;
    }

    if (!openEvent) {
      const lastEvent = await prisma.alertEvent.findFirst({
        where: { ruleId: rule.id },
        select: { id: true, acknowledgedAt: true },
        orderBy: { triggeredAt: 'desc' },
      });

      const acknowledgedFor =
        lastEvent?.acknowledgedAt === null || lastEvent?.acknowledgedAt === undefined
          ? null
          : now.getTime() - lastEvent.acknowledgedAt.getTime();

      if (acknowledgedFor !== null && acknowledgedFor < rule.windowMinutes * 60 * 1000) {
        results.push({
          ruleId: rule.id,
          outcome: 'unchanged',
          observed,
          eventId: lastEvent?.id,
        });
        continue;
      }

      const summary = summarise(rule, snapshot, observed);
      const event = await prisma.alertEvent.create({
        data: {
          ruleId: rule.id,
          organizationId: rule.organizationId,
          domainId: rule.domainId,
          metric: rule.metric,
          operator: rule.operator,
          observedValue: observed,
          threshold: rule.threshold,
          windowMinutes: rule.windowMinutes,
          summary,
          context: contextFor(snapshot, rule.metric),
        },
        select: { id: true },
      });

      await prisma.alertRule.update({ where: { id: rule.id }, data: { lastTriggeredAt: now } });
      await notifyRecipients(rule, event.id, summary, observed, 1, now);

      results.push({
        ruleId: rule.id,
        outcome: 'triggered',
        observed,
        eventId: event.id,
        reminderLevel: 1,
      });
      continue;
    }

    const dueAt =
      openEvent.triggeredAt.getTime() + rule.cooldownMinutes * 60 * 1000 * openEvent.reminderLevel;

    if (now.getTime() < dueAt || openEvent.reminderLevel >= rule.maxReminderLevel) {
      results.push({
        ruleId: rule.id,
        outcome: 'unchanged',
        observed,
        eventId: openEvent.id,
        reminderLevel: openEvent.reminderLevel,
      });
      continue;
    }

    const reminderLevel = openEvent.reminderLevel + 1;
    const summary = summarise(rule, snapshot, observed);

    await prisma.alertEvent.update({
      where: { id: openEvent.id },
      data: { reminderLevel },
    });

    await notifyRecipients(rule, openEvent.id, summary, observed, reminderLevel, now);

    results.push({
      ruleId: rule.id,
      outcome: 'escalated',
      observed,
      eventId: openEvent.id,
      reminderLevel,
    });
  }

  return results;
}

async function notifyRecipients(
  rule: PersistedRule,
  eventId: string,
  summary: string,
  observed: number,
  reminderLevel: number,
  now: Date,
): Promise<void> {
  const risk = riskByMetric[rule.metric];
  const recipientUserIds = rule.recipients.map((recipient) => recipient.userId);

  await createAlertNotifications({
    alertEventId: eventId,
    organizationId: rule.organizationId,
    domainName: rule.domain.name,
    ruleName: rule.name,
    summary,
    recipientUserIds,
    reminderLevel,
  });

  return deliverEvent(
    eventId,
    recipientUserIds,
    rule.organization.name,
    rule.domain.name,
    escalationSubject(rule, reminderLevel),
    [
      `Workspace: ${rule.organization.name}`,
      `Domain: ${rule.domain.name}`,
      `Alert: ${rule.name} (${rule.metric})`,
      summary,
      '',
      `Threshold: ${rule.operator} ${rule.threshold}`,
      `Window: ${rule.windowMinutes} minutes`,
      reminderLevel > 1 ? `Reminder ${reminderLevel} of ${rule.maxReminderLevel}` : 'This is the first notification.',
      escalationNote(reminderLevel),
      '',
      'Review and acknowledge this alert in DMARC Harbor.',
    ]
      .filter(Boolean)
      .join('\n'),
    risk,
    reminderLevel,
    now,
  );
}

export interface RollupResult {
  organizationId: string;
  notified: boolean;
  eventCount: number;
  markedStale: number;
}

export async function runAlertRollups(now = new Date()): Promise<RollupResult[]> {
  const staleThreshold = new Date(now.getTime() - env.ALERT_STALE_DAYS * 24 * 60 * 60 * 1000);
  const rollupInterval = env.ALERT_ROLLUP_HOURS * 60 * 60 * 1000;

  const stale = await prisma.alertEvent.updateMany({
    where: {
      acknowledgedAt: null,
      resolvedAt: null,
      staleAt: null,
      triggeredAt: { lte: staleThreshold },
    },
    data: { staleAt: now },
  });

  const candidates = await prisma.alertEvent.findMany({
    where: {
      acknowledgedAt: null,
      resolvedAt: null,
      staleAt: null,
    },
    include: {
      rule: { select: { id: true, name: true, maxReminderLevel: true } },
      domain: { select: { name: true } },
      organization: { select: { id: true, name: true } },
    },
    orderBy: { triggeredAt: 'asc' },
    take: 5_000,
  });

  const byOrganization = new Map<string, typeof candidates>();
  for (const event of candidates) {
    byOrganization.set(event.organizationId, [...(byOrganization.get(event.organizationId) ?? []), event]);
  }

  const results: RollupResult[] = [];

  for (const [organizationId, events] of byOrganization) {
    const exhausted = events.filter((event) => event.reminderLevel >= event.rule.maxReminderLevel);
    const outstanding = exhausted.length ? exhausted : events;

    if (!outstanding.length) {
      results.push({ organizationId, notified: false, eventCount: 0, markedStale: stale.count });
      continue;
    }

    const lastNotified = outstanding
      .map((event) => event.lastOwnerNotifiedAt)
      .filter((value): value is Date => value !== null)
      .sort((left, right) => right.getTime() - left.getTime())[0];

    const reference = lastNotified ?? outstanding[0].triggeredAt;
    if (now.getTime() - reference.getTime() < rollupInterval) {
      results.push({ organizationId, notified: false, eventCount: outstanding.length, markedStale: stale.count });
      continue;
    }

    const admins = await prisma.member.findMany({
      where: { organizationId, role: { in: ['owner', 'admin'] } },
      select: {
        user: {
          select: {
            id: true,
            email: true,
            notificationPreference: {
              select: {
                emailAlerts: true,
                quietHoursStart: true,
                quietHoursEnd: true,
                onlyHighRiskAlerts: true,
                timezone: true,
              },
            },
          },
        },
      },
    });

    const lines = outstanding
      .slice(0, 20)
      .map(
        (event) =>
          `  ${event.domain.name.padEnd(30)} ${event.rule.name.padEnd(28)} ${event.summary}`,
      );

    const body = [
      `Workspace: ${outstanding[0].organization.name}`,
      '',
      `${outstanding.length} alert${outstanding.length === 1 ? '' : 's'} remain unacknowledged after their reminder sequence finished.`,
      '',
      ...lines,
      outstanding.length > 20 ? `  ...and ${outstanding.length - 20} more` : '',
      '',
      'These alerts have already been sent to the people who own each rule.',
      'Review them in DMARC Harbor and acknowledge, adjust, or disable the rule.',
    ]
      .filter((line) => line !== '')
      .join('\n');

    const subject = `[DMARC Harbor] ${outstanding.length} unacknowledged alert${outstanding.length === 1 ? '' : 's'}`;

    for (const event of outstanding) {
      const rollupLevel = event.ownerRollupLevel + 1;

      for (const member of admins) {
        await deliverToUser(member.user, {
          eventId: event.id,
          kind: 'ROLLUP',
          subject,
          body,
          risk: 'high',
          reminderLevel: rollupLevel,
          now,
        });
      }

      await prisma.alertEvent.update({
        where: { id: event.id },
        data: { lastOwnerNotifiedAt: now, ownerRollupLevel: rollupLevel },
      });
    }

    results.push({ organizationId, notified: true, eventCount: outstanding.length, markedStale: stale.count });
  }

  if (stale.count > 0) {
    console.info(`[alerts] marked ${stale.count} alert(s) stale after ${env.ALERT_STALE_DAYS} days unacknowledged`);
  }

  return results;
}

export async function acknowledgeAlertEvent(
  organizationId: string,
  eventId: string,
  userId: string | undefined,
): Promise<'acknowledged' | 'not_found' | 'already_handled'> {
  const event = await prisma.alertEvent.findFirst({
    where: { id: eventId, organizationId },
    select: { id: true, acknowledgedAt: true, resolvedAt: true },
  });

  if (!event) {
    return 'not_found';
  }

  if (event.acknowledgedAt || event.resolvedAt) {
    return 'already_handled';
  }

  await prisma.alertEvent.update({
    where: { id: event.id },
    data: { acknowledgedAt: new Date(), acknowledgedById: userId ?? null },
  });

  return 'acknowledged';
}
