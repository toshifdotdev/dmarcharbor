import { describe, expect, it } from 'vitest';
import {
  MonthlyReportError,
  isMonthlyScheduleDue,
  monthlyReportFilename,
  monthlyReportReference,
  nextMonthlyIssueDate,
  parseMonthlyPeriod,
  percentageText,
  previousCompleteMonth,
} from '../src/services/reports/monthly-period.js';
import { monthlyPolicyLabel } from '../src/services/reports/monthly-report.service.js';

const now = new Date('2026-11-05T12:00:00.000Z');
const clientCreated = new Date('2026-01-15T10:00:00.000Z');

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof MonthlyReportError ? error.code : 'OTHER';
  }
}

describe('monthly periods', () => {
  it('names the previous complete month', () => {
    const period = previousCompleteMonth(now);
    expect(period.key).toBe('2026-10');
    expect(period.label).toBe('October 2026');
    expect(period.start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('refuses the current month, months beyond twelve, malformed values and months before the client', () => {
    expect(parseMonthlyPeriod('2026-10', now, clientCreated).key).toBe('2026-10');
    expect(codeOf(() => parseMonthlyPeriod('2026-11', now, clientCreated))).toBe('PERIOD_NOT_COMPLETE');
    expect(codeOf(() => parseMonthlyPeriod('2027-01', now, clientCreated))).toBe('PERIOD_NOT_COMPLETE');
    expect(codeOf(() => parseMonthlyPeriod('2025-10', now, clientCreated))).toBe('PERIOD_TOO_OLD');
    expect(codeOf(() => parseMonthlyPeriod('2025-13', now, clientCreated))).toBe('INVALID_PERIOD');
    expect(codeOf(() => parseMonthlyPeriod('October 2026', now, clientCreated))).toBe('INVALID_PERIOD');
    expect(codeOf(() => parseMonthlyPeriod('2026-03', now, new Date('2026-04-10T00:00:00Z')))).toBe(
      'PERIOD_BEFORE_CLIENT',
    );
    expect(parseMonthlyPeriod('2026-04', now, new Date('2026-04-10T00:00:00Z')).key).toBe('2026-04');
  });

  it('formats a percentage from counts, and never 0% with no reports', () => {
    expect(percentageText(0, 0)).toBe('no reports');
    expect(percentageText(0, 10)).toBe('0.0%');
    expect(percentageText(2, 3)).toBe('66.7%');
    expect(percentageText(1, 3)).toBe('33.3%');
  });

  it('builds a legible reference and filename', () => {
    const period = parseMonthlyPeriod('2026-10', now, clientCreated);
    expect(monthlyReportReference('Acme Freight Ltd', period, 'ABC123')).toMatch(
      /^RPT-202610-ACME-FREIGHT-LTD-ABC123$/,
    );
    expect(monthlyReportFilename('Acme Freight Ltd', period)).toBe(
      'dmarc-report-acme-freight-ltd-2026-10.pdf',
    );
    expect(monthlyReportFilename('../../etc/passwd', period)).not.toContain('/');
  });

  it('prefers a completed scan, then the newest report, then unknown', () => {
    expect(monthlyPolicyLabel({ dmarc: { status: 'found', policy: 'reject', testing: true } }, 'none')).toBe('testing');
    expect(monthlyPolicyLabel({ dmarc: { status: 'found', policy: 'none', testing: true } }, 'reject')).toBe('none');
    expect(monthlyPolicyLabel({ dmarc: { status: 'missing' } }, 'reject')).toBe('no record');
    expect(monthlyPolicyLabel({ dmarc: { status: 'error' } }, 'reject')).toBe('not known');
    expect(monthlyPolicyLabel(null, 'QUARANTINE')).toBe('quarantine');
    expect(monthlyPolicyLabel(null, null)).toBe('not known');
  });

  it('decides whether a schedule is due, including a missed day', () => {
    const base = { enabled: true, dayOfMonth: 2, sendHourUtc: 9, lastIssuedPeriod: null };
    expect(isMonthlyScheduleDue(base, new Date('2026-11-02T08:59:00Z'))).toBe(false);
    expect(isMonthlyScheduleDue(base, new Date('2026-11-02T09:00:00Z'))).toBe(true);
    expect(isMonthlyScheduleDue(base, new Date('2026-11-03T00:00:00Z'))).toBe(true);
    expect(isMonthlyScheduleDue(base, new Date('2026-11-01T23:59:00Z'))).toBe(false);
    expect(isMonthlyScheduleDue({ ...base, lastIssuedPeriod: '2026-10' }, new Date('2026-11-03T12:00:00Z'))).toBe(false);
    expect(isMonthlyScheduleDue({ ...base, enabled: false }, new Date('2026-11-03T12:00:00Z'))).toBe(false);
  });

  it('computes the next issue date from the saved inputs', () => {
    const next = nextMonthlyIssueDate({ dayOfMonth: 2, sendHourUtc: 9 }, new Date('2026-11-01T12:00:00Z'));
    expect(next.toISOString()).toBe('2026-11-02T09:00:00.000Z');

    const nextMonth = nextMonthlyIssueDate({ dayOfMonth: 2, sendHourUtc: 9 }, new Date('2026-11-02T10:00:00Z'));
    expect(nextMonth.toISOString()).toBe('2026-12-02T09:00:00.000Z');
  });
});
