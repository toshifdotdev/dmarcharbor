/**
 * Calendar months for the monthly evidence report.
 *
 * A period is a UTC calendar month, written YYYY-MM. Only complete months can
 * be issued, because a report that says "October" while October is still
 * running is a statement about a month nobody has finished living through.
 *
 * The boundaries are half open: [start, end). A report whose dateRangeBegin is
 * the first instant of the next month belongs to the next month, not this one.
 */

import { randomBytes } from 'node:crypto';

const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export interface MonthlyPeriod {
  key: string;
  year: number;
  /** 1 to 12, for humans; Date uses 0 to 11. */
  month: number;
  start: Date;
  end: Date;
  label: string;
}

export class MonthlyReportError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code = 'MONTHLY_REPORT_ERROR', status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MonthlyReportError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function startOfUtcMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function addMonths(value: Date, months: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));
}

function keyOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function periodOf(year: number, month: number): MonthlyPeriod {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return {
    key: keyOf(year, month),
    year,
    month,
    start,
    end,
    label: `${monthNames[month - 1]} ${year}`,
  };
}

/** The calendar month that contains `value`. */
export function periodForDate(value: Date): MonthlyPeriod {
  const start = startOfUtcMonth(value);
  return periodOf(start.getUTCFullYear(), start.getUTCMonth() + 1);
}

export function previousCompleteMonth(now = new Date()): MonthlyPeriod {
  const current = startOfUtcMonth(now);
  const previous = addMonths(current, -1);
  return periodOf(previous.getUTCFullYear(), previous.getUTCMonth() + 1);
}

/**
 * Parses and validates a requested period against the deployment and the
 * client it belongs to.
 *
 * The client rule uses its creation *month*, not its creation day: a client
 * added on the 28th has no evidence for the earlier part of that month, but the
 * month it was created in is still the first month it can be reported on, and
 * the document says the figures came from reports that arrived.
 */
export function parseMonthlyPeriod(input: string, now: Date, clientCreatedAt: Date): MonthlyPeriod {
  const value = input.trim();
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) {
    throw new MonthlyReportError(
      'Choose a month in YYYY-MM form, for example 2026-10.',
      'INVALID_PERIOD',
      400,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 9999 || month < 1 || month > 12) {
    throw new MonthlyReportError('That is not a calendar month.', 'INVALID_PERIOD', 400);
  }

  const period = periodOf(year, month);
  const currentStart = startOfUtcMonth(now);
  if (period.start.getTime() >= currentStart.getTime()) {
    throw new MonthlyReportError(
      'That month is not complete yet. A report can only cover a month that has ended.',
      'PERIOD_NOT_COMPLETE',
      400,
    );
  }

  const earliest = addMonths(currentStart, -12);
  if (period.start.getTime() < earliest.getTime()) {
    throw new MonthlyReportError(
      'Only the last 12 complete months can be issued.',
      'PERIOD_TOO_OLD',
      400,
    );
  }

  if (period.start.getTime() < startOfUtcMonth(clientCreatedAt).getTime()) {
    throw new MonthlyReportError(
      'That month is before this client was created, so there is no evidence for it.',
      'PERIOD_BEFORE_CLIENT',
      400,
    );
  }

  return period;
}

/** A period key for a stored month, used by the scheduler without re-validating it. */
export function periodFromKey(value: string): MonthlyPeriod {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid stored month ${value}.`);
  }
  return periodOf(Number(match[1]), Number(match[2]));
}

/** Human-readable label for a stored key, without constructing a Date. */
export function monthLabelFromKey(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${monthNames[month - 1]} ${match[1]}` : value;
}

/**
 * One decimal place, computed from counts rather than by averaging percentages.
 * A domain with no messages is "no reports", never 0%.
 */
export function percentageText(passed: number, total: number): string {
  if (total <= 0) {
    return 'no reports';
  }
  return `${(Math.round((passed * 1000) / total) / 10).toFixed(1)}%`;
}

/** A filename safe for Content-Disposition, shaped like the compliance pack's. */
export function monthlyReportFilename(clientName: string, period: MonthlyPeriod): string {
  const slug = clientSlug(clientName);
  const safe = `dmarc-report-${slug || 'client'}-${period.year}-${String(period.month).padStart(2, '0')}.pdf`;
  return safe.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
}

function clientSlug(clientName: string): string {
  return clientName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

/** RPT-YYYYMM-CLIENT-<24 hex upper>, the value printed on the report. */
export function monthlyReportReference(clientName: string, period: MonthlyPeriod, suffix?: string): string {
  const slug = clientSlug(clientName).toUpperCase();
  const random = suffix ?? randomSuffix();
  return `RPT-${period.year}${String(period.month).padStart(2, '0')}-${slug || 'CLIENT'}-${random}`;
}

function randomSuffix(): string {
  return randomBytes(12).toString('hex').toUpperCase();
}

export interface MonthlyScheduleShape {
  enabled: boolean;
  dayOfMonth: number;
  sendHourUtc: number;
  lastIssuedPeriod: string | null;
}

/**
 * Whether a schedule's previous-month report is due now.
 *
 * It is due on the configured day after the configured hour, or on any later
 * day. That is what lets a worker that was down on the 2nd catch up on the 3rd
 * without special-casing a missed run.
 */
export function isMonthlyScheduleDue(schedule: MonthlyScheduleShape, now: Date): boolean {
  if (!schedule.enabled) return false;
  const previous = previousCompleteMonth(now);
  if (schedule.lastIssuedPeriod === previous.key) return false;

  const day = now.getUTCDate();
  if (day < schedule.dayOfMonth) return false;
  if (day === schedule.dayOfMonth && now.getUTCHours() < schedule.sendHourUtc) return false;
  return true;
}

/** The next date this schedule will look for the previous complete month. */
export function nextMonthlyIssueDate(
  schedule: Pick<MonthlyScheduleShape, 'dayOfMonth' | 'sendHourUtc'>,
  now = new Date(),
): Date {
  const target = (monthOffset: number): Date =>
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() + monthOffset,
        schedule.dayOfMonth,
        schedule.sendHourUtc,
        0,
        0,
        0,
      ),
    );

  const thisMonth = target(0);
  return thisMonth.getTime() > now.getTime() ? thisMonth : target(1);
}
