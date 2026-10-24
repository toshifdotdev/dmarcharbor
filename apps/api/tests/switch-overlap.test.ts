import { describe, expect, it } from 'vitest';
import {
  buildSwitchOverlap,
  cutoverReadiness,
  cutoverThresholds,
  type SwitchOverlap,
  type SwitchOverlapReceiver,
} from '../src/services/switch-kit/overlap.js';

const NOW = new Date('2026-10-16T05:00:00.000Z');
const STARTED = new Date('2026-10-01T00:00:00.000Z');

function report(input: {
  org?: string | null;
  email?: string | null;
  begin?: string | null;
  received?: string;
  messages: number;
}) {
  return {
    reportingOrganization: input.org ?? null,
    reportingEmail: input.email ?? null,
    dateRangeBegin: input.begin ?? null,
    receivedAt: input.received ?? '2026-10-02T00:00:00.000Z',
    messages: input.messages,
  };
}

function receiver(overrides: Partial<SwitchOverlapReceiver> & { label: string; messages: number }): SwitchOverlapReceiver {
  return {
    key: overrides.label.toLowerCase(),
    firstReportDay: '2026-10-01',
    lastReportDay: '2026-10-15',
    reportDays: 14,
    expectedDays: 15,
    coveragePercent: 93,
    sharePercent: 0,
    silentDays: 0,
    ...overrides,
  };
}

function overlap(overrides: {
  receivers: SwitchOverlapReceiver[];
  messages: number;
  dualDays?: number;
  recentReportDays?: number;
}): SwitchOverlap {
  return {
    receivers: overrides.receivers,
    totals: {
      messages: overrides.messages,
      receivers: overrides.receivers.length,
      dualDays: overrides.dualDays ?? 16,
      recentReportDays: overrides.recentReportDays ?? 12,
    },
    note: 'note',
  };
}

describe('building the overlap', () => {
  it('buckets report days in UTC and falls back to receivedAt', () => {
    const result = buildSwitchOverlap(
      [
        report({ org: 'Google LLC', begin: '2026-10-01T23:30:00.000Z', messages: 10 }),
        report({ org: 'Google LLC', received: '2026-10-02T00:30:00.000Z', messages: 10 }),
        report({ org: 'Microsoft', begin: '2026-10-02T00:10:00.000Z', messages: 5 }),
      ],
      { startedAt: STARTED, now: NOW },
    );

    const google = result.receivers.find((entry) => entry.label === 'Google LLC')!;
    const microsoft = result.receivers.find((entry) => entry.label === 'Microsoft')!;

    expect(google.firstReportDay).toBe('2026-10-01');
    expect(google.lastReportDay).toBe('2026-10-02');
    expect(google.reportDays).toBe(2);
    expect(microsoft.firstReportDay).toBe('2026-10-02');
    expect(result.totals).toEqual({
      messages: 25,
      receivers: 2,
      dualDays: 15,
      // Only 2026-10-02 falls inside the 14 complete days ending 2026-10-15.
      recentReportDays: 1,
    });
  });

  it('computes expected days, coverage, shares and silent days', () => {
    const result = buildSwitchOverlap(
      [
        report({ org: 'Google LLC', begin: '2026-10-01T12:00:00.000Z', messages: 75 }),
        report({ org: 'Google LLC', begin: '2026-10-02T12:00:00.000Z', messages: 25 }),
      ],
      { startedAt: STARTED, now: NOW },
    );

    const google = result.receivers[0]!;
    expect(google.expectedDays).toBe(15);
    expect(google.coveragePercent).toBe(13);
    expect(google.sharePercent).toBe(100);
    expect(google.silentDays).toBe(13);
  });

  it('labels a receiver with its most frequent spelling', () => {
    const result = buildSwitchOverlap(
      [
        report({ org: 'Google LLC', messages: 1 }),
        report({ org: 'google llc', messages: 1 }),
        report({ org: 'Google  LLC', messages: 1 }),
        report({ org: 'GOOGLE LLC', messages: 1 }),
        report({ org: 'Google  LLC', messages: 1 }),
      ],
      { startedAt: STARTED, now: NOW },
    );

    expect(result.receivers).toHaveLength(1);
    expect(result.receivers[0]!.label).toBe('Google  LLC');
  });

  it('falls back to the reporting email domain, then unknown', () => {
    const result = buildSwitchOverlap(
      [
        report({ org: null, email: 'reports@mail.example.test', messages: 1 }),
        report({ org: null, email: null, messages: 1 }),
      ],
      { startedAt: STARTED, now: NOW },
    );

    expect(result.receivers.map((entry) => entry.key).sort()).toEqual(['mail.example.test', 'unknown']);
  });

  it('returns an empty overlap before dual reporting began', () => {
    const result = buildSwitchOverlap([report({ org: 'Google LLC', messages: 10 })], {
      startedAt: null,
      now: NOW,
    });

    expect(result.receivers).toEqual([]);
    expect(result.totals).toEqual({ messages: 0, receivers: 0, dualDays: 0, recentReportDays: 0 });
    expect(result.note).toContain('only on days they saw mail');
  });
});

describe('cutover readiness', () => {
  it('is ready when every threshold passes', () => {
    const result = cutoverReadiness(
      'DUAL_REPORTING',
      overlap({ receivers: [receiver({ label: 'Google LLC', messages: 500, silentDays: 1 })], messages: 500 }),
    );

    expect(result).toEqual({ ready: true, blockers: [] });
  });

  it('blocks while the domain is not dual reporting', () => {
    const result = cutoverReadiness(
      'PLANNED',
      overlap({ receivers: [receiver({ label: 'Google LLC', messages: 500 })], messages: 500 }),
    );

    expect(result.ready).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toContain('not started dual reporting');
  });

  it('says only that a finished switch is finished', () => {
    const result = cutoverReadiness('CUT_OVER', overlap({ receivers: [], messages: 0 }));

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(['The domain is already cut over, so there is no overlap period left to judge.']);
  });

  it('blocks an overlap shorter than the minimum', () => {
    const result = cutoverReadiness(
      'DUAL_REPORTING',
      overlap({
        receivers: [receiver({ label: 'Google LLC', messages: 500 })],
        messages: 500,
        dualDays: 5,
      }),
    );

    expect(result.blockers.join(' ')).toContain('5 days');
    expect(result.blockers.join(' ')).toContain(String(cutoverThresholds.minimumDualDays));
  });

  it('blocks too few recent report days', () => {
    const result = cutoverReadiness(
      'DUAL_REPORTING',
      overlap({
        receivers: [receiver({ label: 'Google LLC', messages: 500 })],
        messages: 500,
        recentReportDays: 3,
      }),
    );

    expect(result.blockers.join(' ')).toContain('3 of the last 14 days');
    expect(result.blockers.join(' ')).toContain(String(cutoverThresholds.minimumRecentReportDays));
  });

  it('names a major receiver that has gone silent', () => {
    const result = cutoverReadiness(
      'DUAL_REPORTING',
      overlap({
        receivers: [
          receiver({ label: 'Google LLC', messages: 800, silentDays: 5 }),
          receiver({ label: 'Microsoft', messages: 150, silentDays: 0 }),
          receiver({ label: 'Small Receiver', messages: 50, silentDays: 9 }),
        ],
        messages: 1_000,
      }),
    );

    expect(result.ready).toBe(false);
    expect(result.blockers.join(' ')).toContain('Google LLC');
    expect(result.blockers.join(' ')).toContain('5 days');
    expect(result.blockers.join(' ')).not.toContain('Small Receiver');
  });

  it('adds the low volume blocker but says cutting over is still possible', () => {
    const result = cutoverReadiness(
      'DUAL_REPORTING',
      overlap({ receivers: [receiver({ label: 'Google LLC', messages: 42 })], messages: 42 }),
    );

    expect(result.blockers.join(' ')).toContain('42 messages');
    expect(result.blockers.join(' ')).toContain('too little mail to judge yet');
    expect(result.blockers.join(' ')).toContain('can still cut over');
  });
});
