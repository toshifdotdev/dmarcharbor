export const cutoverThresholds = {
  minimumDualDays: 14,
  recentWindowDays: 14,
  minimumRecentReportDays: 10,
  majorReceiverSharePercent: 90,
  majorReceiverMaxSilentDays: 3,
  minimumMessages: 100,
};

export const overlapNote =
  'Receivers report only on days they saw mail from the domain, so low coverage from a small receiver is normal.';

export interface SwitchOverlapReportInput {
  reportingOrganization: string | null;
  reportingEmail: string | null;
  dateRangeBegin: Date | string | null;
  receivedAt: Date | string | null;
  messages: number;
}

export interface SwitchOverlapReceiver {
  key: string;
  label: string;
  firstReportDay: string;
  lastReportDay: string;
  reportDays: number;
  expectedDays: number;
  coveragePercent: number;
  messages: number;
  sharePercent: number;
  silentDays: number;
}

export interface SwitchOverlap {
  receivers: SwitchOverlapReceiver[];
  totals: {
    messages: number;
    receivers: number;
    dualDays: number;
    recentReportDays: number;
  };
  note: string;
}

function parseInstant(value: Date | string | null): Date | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayFromKey(key: string): number {
  return Date.parse(`${key}T00:00:00.000Z`);
}

function addDays(key: string, days: number): string {
  return utcDay(new Date(dayFromKey(key) + days * 86_400_000));
}

function daysBetween(from: string, to: string): number {
  return Math.round((dayFromKey(to) - dayFromKey(from)) / 86_400_000);
}

function receiverKey(report: SwitchOverlapReportInput): { key: string; label: string } {
  const original = report.reportingOrganization?.trim();
  if (original) {
    return { key: original.replace(/\s+/g, ' ').toLowerCase(), label: original };
  }

  const email = report.reportingEmail?.trim();
  const domain = email?.split('@').pop()?.trim();
  if (domain) {
    return { key: domain.toLowerCase(), label: domain };
  }

  return { key: 'unknown', label: 'unknown' };
}

interface Accumulator {
  key: string;
  labels: Map<string, number>;
  days: Set<string>;
  messages: number;
}

function mostFrequentLabel(labels: Map<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const [label, count] of labels) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

/**
 * What arrived from each receiver since dual reporting began, set against what
 * a daily cadence would have produced.
 *
 * Coverage is deliberately not called delivery: a receiver reports only on days
 * it saw mail, so a small receiver with ten percent coverage can be working
 * perfectly. The note travels with the data so no screen has to remember that.
 */
export function buildSwitchOverlap(
  reports: readonly SwitchOverlapReportInput[],
  input: { startedAt: Date | null; now: Date },
): SwitchOverlap {
  const lastCompleteDay = addDays(utcDay(input.now), -1);
  const recentStartDay = addDays(lastCompleteDay, -(cutoverThresholds.recentWindowDays - 1));

  if (!input.startedAt) {
    return {
      receivers: [],
      totals: { messages: 0, receivers: 0, dualDays: 0, recentReportDays: 0 },
      note: overlapNote,
    };
  }

  const accumulators = new Map<string, Accumulator>();
  const recentDays = new Set<string>();

  for (const report of reports) {
    const dayDate = parseInstant(report.dateRangeBegin) ?? parseInstant(report.receivedAt);
    if (!dayDate) {
      continue;
    }
    const day = utcDay(dayDate);
    const { key, label } = receiverKey(report);
    const accumulator = accumulators.get(key) ?? {
      key,
      labels: new Map<string, number>(),
      days: new Set<string>(),
      messages: 0,
    };

    accumulator.labels.set(label, (accumulator.labels.get(label) ?? 0) + 1);
    accumulator.days.add(day);
    accumulator.messages += Math.max(0, report.messages);
    accumulators.set(key, accumulator);

    if (day >= recentStartDay && day <= lastCompleteDay) {
      recentDays.add(day);
    }
  }

  const totalMessages = [...accumulators.values()].reduce((total, entry) => total + entry.messages, 0);

  const receivers: SwitchOverlapReceiver[] = [...accumulators.values()]
    .map((accumulator) => {
      const days = [...accumulator.days].sort();
      const firstReportDay = days[0]!;
      const lastReportDay = days[days.length - 1]!;
      const expectedDays = Math.max(1, daysBetween(firstReportDay, lastCompleteDay) + 1);
      const coveragePercent = Math.min(100, Math.round((accumulator.days.size / expectedDays) * 100));

      return {
        key: accumulator.key,
        label: mostFrequentLabel(accumulator.labels),
        firstReportDay,
        lastReportDay,
        reportDays: accumulator.days.size,
        expectedDays,
        coveragePercent,
        messages: accumulator.messages,
        sharePercent: totalMessages > 0 ? Math.round((accumulator.messages / totalMessages) * 100) : 0,
        silentDays: Math.max(0, daysBetween(lastReportDay, lastCompleteDay)),
      };
    })
    .sort((a, b) => b.messages - a.messages || a.label.localeCompare(b.label));

  const dualDays = Math.max(0, Math.floor((input.now.getTime() - input.startedAt.getTime()) / 86_400_000));

  return {
    receivers,
    totals: {
      messages: totalMessages,
      receivers: receivers.length,
      dualDays,
      recentReportDays: recentDays.size,
    },
    note: overlapNote,
  };
}

function majorReceivers(overlap: SwitchOverlap): SwitchOverlapReceiver[] {
  const total = overlap.totals.messages;
  if (total <= 0) {
    return [];
  }

  const selected: SwitchOverlapReceiver[] = [];
  let cumulative = 0;
  for (const receiver of overlap.receivers) {
    selected.push(receiver);
    cumulative += receiver.messages;
    if ((cumulative / total) * 100 >= cutoverThresholds.majorReceiverSharePercent) {
      break;
    }
  }
  return selected;
}

export interface CutoverReadiness {
  ready: boolean;
  blockers: string[];
}

/**
 * Whether the overlap is strong enough to cut over, in plain sentences.
 *
 * Every blocker carries its own number, because "not enough data yet" is a
 * sentence that tells an operator nothing and makes them ask support.
 */
export function cutoverReadiness(status: string, overlap: SwitchOverlap): CutoverReadiness {
  const blockers: string[] = [];
  const totals = overlap.totals;

  // A finished switch has nothing left to wait for, and listing day counts
  // under it would read as reasons the cutover was wrong.
  if (status === 'CUT_OVER') {
    return { ready: false, blockers: ['The domain is already cut over, so there is no overlap period left to judge.'] };
  }

  if (status !== 'DUAL_REPORTING') {
    blockers.push('The domain has not started dual reporting yet, so there is no overlap to judge.');
  }

  if (totals.dualDays < cutoverThresholds.minimumDualDays) {
    blockers.push(
      `Dual reporting has run for ${totals.dualDays} day${totals.dualDays === 1 ? '' : 's'}. Wait until it has run for at least ${cutoverThresholds.minimumDualDays} days.`,
    );
  }

  if (totals.recentReportDays < cutoverThresholds.minimumRecentReportDays) {
    blockers.push(
      `Reports arrived on ${totals.recentReportDays} of the last ${cutoverThresholds.recentWindowDays} days. Wait until at least ${cutoverThresholds.minimumRecentReportDays} days have reports.`,
    );
  }

  for (const receiver of majorReceivers(overlap)) {
    if (receiver.silentDays > cutoverThresholds.majorReceiverMaxSilentDays) {
      blockers.push(
        `${receiver.label} has sent no report for ${receiver.silentDays} days. Wait until it is at most ${cutoverThresholds.majorReceiverMaxSilentDays} days behind, or check why it stopped.`,
      );
    }
  }

  if (totals.messages < cutoverThresholds.minimumMessages) {
    blockers.push(
      `Only ${totals.messages} messages have been received, which is too little mail to judge yet; you can still cut over.`,
    );
  }

  return { ready: blockers.length === 0, blockers };
}
