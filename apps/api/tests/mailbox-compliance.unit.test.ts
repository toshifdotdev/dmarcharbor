import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  evaluateMailboxCompliance,
  providerForReport,
  reportInWindow,
  type MailboxComplianceInput,
  type MailboxProviderId,
  type MailboxRecordInput,
  type MailboxReportInput,
  type MailboxScanInput,
} from '../src/services/compliance/mailbox-requirements.js';

const now = new Date('2026-10-26T12:00:00.000Z');

function dkimRecord(bits: number): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return `v=DKIM1; k=rsa; p=${Buffer.from(der).toString('base64')}`;
}

function ed25519Record(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return `v=DKIM1; k=ed25519; p=${Buffer.from(der).toString('base64')}`;
}

// Generating a 2048-bit RSA key takes up to a second, and every evaluate()
// builds a default scan, so the default key is made once.
let defaultDkimRecord: string | null = null;
function defaultDkim(): string {
  defaultDkimRecord ??= dkimRecord(2048);
  return defaultDkimRecord;
}

function scan(overrides: Partial<MailboxScanInput> = {}): MailboxScanInput {
  return {
    dmarc: {
      status: 'found',
      policy: 'none',
      record: 'v=DMARC1; p=none; rua=mailto:reports@example.test',
      hasAggregateReports: true,
      aggregateMailtoTargets: ['mailto:reports@example.test'],
      aggregateWebTargets: [],
    },
    spf: {
      status: 'found',
      valid: true,
      record: 'v=spf1 include:_spf.example.test -all',
    },
    dkim: {
      status: 'found',
      records: { s1: defaultDkim() },
    },
    issues: [],
    ...overrides,
  };
}

function record(overrides: Partial<MailboxRecordInput> = {}): MailboxRecordInput {
  const dkimResult = overrides.dkimResult ?? 'pass';
  const spfResult = overrides.spfResult ?? 'pass';
  return {
    sourceIp: '192.0.2.1',
    messageCount: 100,
    dkimResult,
    spfResult,
    senderKey: 'sender.test',
    senderDomain: 'sender.test',
    spfRawPass: spfResult === 'pass',
    ...overrides,
  };
}

function report(
  provider: MailboxProviderId | null,
  records: MailboxRecordInput[],
  options: {
    begin?: string;
    end?: string | null;
    receivedAt?: string;
  } = {},
): MailboxReportInput {
  return {
    id: `${provider}-${Math.random()}`,
    provider,
    dateRangeBegin: options.begin ? new Date(options.begin) : new Date('2026-10-25T00:00:00.000Z'),
    dateRangeEnd: options.end === null ? null : new Date(options.end ?? '2026-10-25T23:59:59.000Z'),
    receivedAt: new Date(options.receivedAt ?? '2026-10-26T00:00:00.000Z'),
    records,
  };
}

function evaluate(input: Partial<MailboxComplianceInput> = {}) {
  return evaluateMailboxCompliance({
    domain: { id: 'd1', name: 'example.com' },
    scan: { id: 's1', completedAt: '2026-10-25T10:00:00.000Z', result: scan() },
    reports: [],
    reviewStatusBySender: {},
    ipIntel: {},
    now,
    rowsTruncated: false,
    ...input,
  });
}

function check(view: ReturnType<typeof evaluate>, code: string) {
  const found = view.checks.find((item) => item.code === code);
  expect(found, code).toBeDefined();
  return found!;
}

describe('mailbox requirement provider mapping', () => {
  it('matches only the published reporter domains and organisation names', () => {
    expect(providerForReport('dmarc@google.com', null)).toBe('google');
    expect(providerForReport('DMARC@YAHOOINC.COM', null)).toBe('yahoo');
    expect(providerForReport('x@yahoo.com', null)).toBe('yahoo');
    expect(providerForReport('x@outlook.com', null)).toBe('microsoft');
    expect(providerForReport('x@microsoft.com', null)).toBe('microsoft');
    expect(providerForReport(null, ' Google.com ')).toBe('google');
    expect(providerForReport('', 'Yahoo')).toBe('yahoo');
    expect(providerForReport('', 'Enterprise Outlook')).toBe('microsoft');
    expect(providerForReport('x@googlemail.com', null)).toBeNull();
    expect(providerForReport('', 'Some other reporter')).toBeNull();
    expect(providerForReport(null, null)).toBeNull();
  });
});

describe('mailbox report window and volume', () => {
  it('counts reports whose end is in the window, including reports with no end date', () => {
    const old = new Date(now.getTime() - 40 * 86_400_000).toISOString();
    const recent = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    expect(reportInWindow({ dateRangeEnd: new Date(recent), receivedAt: new Date(recent) }, now)).toBe(true);
    expect(reportInWindow({ dateRangeEnd: new Date(old), receivedAt: new Date(recent) }, now)).toBe(false);
    expect(reportInWindow({ dateRangeEnd: null, receivedAt: new Date(recent) }, now)).toBe(true);
    expect(reportInWindow({ dateRangeEnd: null, receivedAt: new Date(old) }, now)).toBe(false);
  });

  it('uses the UTC day of dateRangeBegin and ignores reports longer than 25 hours', () => {
    const view = evaluate({
      reports: [
        report('google', [record({ messageCount: 6_000 })], {
          begin: '2026-10-14T00:00:00.000Z',
          end: '2026-10-14T23:00:00.000Z',
        }),
        report('google', [record({ messageCount: 4_000 })], {
          begin: '2026-10-15T00:00:00.000Z',
          end: '2026-10-15T12:00:00.000Z',
        }),
        report('google', [record({ messageCount: 30_000 })], {
          begin: '2026-10-16T00:00:00.000Z',
          end: '2026-10-18T00:00:00.000Z',
        }),
        report('microsoft', [record({ messageCount: 5_000 })], {
          begin: '2026-10-14T00:00:00.000Z',
          end: '2026-10-14T06:00:00.000Z',
        }),
        report('yahoo', [record({ messageCount: 9_000 })], {
          begin: '2026-10-14T00:00:00.000Z',
          end: '2026-10-14T06:00:00.000Z',
        }),
      ],
    });

    const google = view.providers.find((entry) => entry.id === 'google')!;
    expect(google).toMatchObject({ peakDailyMessages: 6_000, peakDay: '2026-10-14', aboveBulkThreshold: true });
    const microsoft = view.providers.find((entry) => entry.id === 'microsoft')!;
    expect(microsoft).toMatchObject({ peakDailyMessages: 5_000, aboveBulkThreshold: true });
    const yahoo = view.providers.find((entry) => entry.id === 'yahoo')!;
    expect(yahoo).toMatchObject({ peakDailyMessages: 9_000, aboveBulkThreshold: null, bulkThreshold: null });
  });

  it('reports a null peak when no report range qualifies', () => {
    const view = evaluate({
      reports: [
        report('google', [record()], {
          begin: '2026-10-14T00:00:00.000Z',
          end: '2026-10-16T00:00:00.000Z',
        }),
      ],
    });
    expect(view.providers.find((entry) => entry.id === 'google')?.peakDailyMessages).toBeNull();
    expect(view.providers.find((entry) => entry.id === 'google')?.aboveBulkThreshold).toBeNull();
  });

  it('excludes NOT_OURS senders from counts and evidence', () => {
    const view = evaluate({
      reports: [
        report('google', [
          record({ senderKey: 'bad.test', senderDomain: 'bad.test', messageCount: 100, dkimResult: 'fail', spfResult: 'fail' }),
          record({ senderKey: 'good.test', senderDomain: 'good.test', messageCount: 100 }),
        ]),
      ],
      reviewStatusBySender: { 'bad.test': 'NOT_OURS' },
    });

    const provider = view.providers.find((entry) => entry.id === 'google')!;
    expect(provider.messages).toBe(100);
    expect(check(view, 'dmarc_passing').perProvider?.find((entry) => entry.provider === 'google')?.messages).toBe(100);
    expect(JSON.stringify(check(view, 'dmarc_passing'))).not.toContain('bad.test');
  });
});

describe('per-provider report checks', () => {
  it('marks meet, fail and not measured separately, and ignores senders under 50 messages', () => {
    const view = evaluate({
      reports: [
        report('google', [
          record({ senderKey: 'degraded.test', senderDomain: 'degraded.test', messageCount: 98 }),
          record({ senderKey: 'degraded.test', senderDomain: 'degraded.test', messageCount: 2, dkimResult: 'fail', spfResult: 'fail' }),
          record({ senderKey: 'small.test', senderDomain: 'small.test', messageCount: 40, dkimResult: 'fail', spfResult: 'fail' }),
        ]),
        report('yahoo', [
          record({ senderKey: 'bad.test', senderDomain: 'bad.test', messageCount: 90 }),
          record({ senderKey: 'bad.test', senderDomain: 'bad.test', messageCount: 10, dkimResult: 'fail', spfResult: 'fail' }),
        ]),
      ],
    });

    const dmarc = check(view, 'dmarc_passing');
    expect(dmarc.status).toBe('fails');
    expect(dmarc.perProvider).toMatchObject([
      { provider: 'google', status: 'meets', messages: 140 },
      { provider: 'yahoo', status: 'fails', messages: 100 },
      { provider: 'microsoft', status: 'not_measured', messages: 0 },
    ]);
    const yahoo = dmarc.perProvider!.find((entry) => entry.provider === 'yahoo')!;
    expect(yahoo.failingSenders).toMatchObject([
      { senderKey: 'bad.test', label: 'bad.test', messages: 100, failingMessages: 10, failingSharePercent: 10 },
    ]);
    expect(dmarc.fix).toContain('Not ours');
    expect(dmarc.evidence.join(' ')).toContain('degraded.test');
  });

  it('marks a provider with only under-50 senders as too little mail to judge', () => {
    const view = evaluate({
      reports: [
        report('yahoo', [
          record({ senderKey: 'small.test', senderDomain: 'small.test', messageCount: 40, dkimResult: 'fail', spfResult: 'fail' }),
        ]),
      ],
    });
    const yahoo = check(view, 'dmarc_passing').perProvider!.find((entry) => entry.provider === 'yahoo')!;
    expect(yahoo.status).toBe('not_measured');
    expect(yahoo.note).toContain('Fewer than 50 messages');
  });

  it('uses the raw SPF auth result for spf_passing, not the aligned verdict', () => {
    const view = evaluate({
      reports: [
        report('google', [
          record({ senderKey: 'bulk.test', senderDomain: 'bulk.test', messageCount: 100, dkimResult: 'pass', spfResult: 'fail', spfRawPass: true }),
        ]),
      ],
    });

    expect(check(view, 'spf_passing').perProvider!.find((entry) => entry.provider === 'google')?.status).toBe('meets');
    expect(check(view, 'dmarc_passing').perProvider!.find((entry) => entry.provider === 'google')?.status).toBe('meets');
    expect(check(view, 'dkim_passing').perProvider!.find((entry) => entry.provider === 'google')?.status).toBe('meets');
  });
});

describe('DKIM record evidence', () => {
  it('meets from reports when no scan is on record', () => {
    const view = evaluate({
      scan: null,
      reports: [report('google', [record({ messageCount: 100 })])],
    });
    expect(check(view, 'dkim_record').status).toBe('meets');
    expect(check(view, 'dkim_record').summary).toContain('reports');
    expect(check(view, 'spf_or_dkim').status).toBe('meets');
  });

  it('is not measured without a scan or a report that passed DKIM', () => {
    const view = evaluate({ scan: null, reports: [report('google', [record({ dkimResult: 'fail' })])] });
    expect(check(view, 'dkim_record').status).toBe('not_measured');
  });

  it('fails when DNS has no selector and at least 50 messages show no DKIM pass', () => {
    const view = evaluate({
      scan: { id: 's1', completedAt: now.toISOString(), result: scan({ dkim: { status: 'missing', records: {} } }) },
      reports: [report('google', [record({ messageCount: 60, dkimResult: 'fail' })])],
    });
    expect(check(view, 'dkim_record').status).toBe('fails');
  });

  it('is unconfirmed when there is too little mail and no DNS selector', () => {
    const view = evaluate({
      scan: { id: 's1', completedAt: now.toISOString(), result: scan({ dkim: { status: 'missing', records: {} } }) },
      reports: [report('google', [record({ messageCount: 10, dkimResult: 'fail' })])],
    });
    expect(check(view, 'dkim_record').status).toBe('unconfirmed');
  });
});

describe('DMARC record checks', () => {
  it('accepts p=none and shows the testing note', () => {
    const view = evaluate({
      scan: {
        id: 's1',
        completedAt: now.toISOString(),
        result: scan({
          dmarc: {
            status: 'found',
            policy: 'quarantine',
            testing: true,
            record: 'v=DMARC1; p=quarantine; t=y',
            hasAggregateReports: true,
            aggregateMailtoTargets: [],
            aggregateWebTargets: [],
          },
        }),
      },
    });
    const dmarc = check(view, 'dmarc_record');
    expect(dmarc.status).toBe('meets');
    expect(dmarc.summary).toContain('testing mode');
  });

  it('fails when missing on the organisational domain and is unconfirmed on a subdomain', () => {
    const organisation = evaluate({
      domain: { id: 'd1', name: 'example.com' },
      scan: {
        id: 's1',
        completedAt: now.toISOString(),
        result: scan({ dmarc: { status: 'missing', policy: 'unknown', hasAggregateReports: false, aggregateMailtoTargets: [], aggregateWebTargets: [] } }),
      },
    });
    expect(check(organisation, 'dmarc_record').status).toBe('fails');

    const subdomain = evaluate({
      domain: { id: 'd2', name: 'mail.example.com' },
      scan: {
        id: 's1',
        completedAt: now.toISOString(),
        result: scan({ dmarc: { status: 'missing', policy: 'unknown', hasAggregateReports: false, aggregateMailtoTargets: [], aggregateWebTargets: [] } }),
      },
    });
    expect(check(subdomain, 'dmarc_record').status).toBe('unconfirmed');
    expect(check(subdomain, 'dmarc_record').summary).toContain('example.com');
  });
});

describe('DKIM key length', () => {
  it('meets with 1024/2048-bit keys, skips Ed25519, and ignores revoked selectors', () => {
    const view = evaluate({
      scan: {
        id: 's1',
        completedAt: now.toISOString(),
        result: scan({
          dkim: {
            status: 'found',
            records: {
              old: dkimRecord(1024),
              modern: dkimRecord(2048),
              ed: ed25519Record(),
              revoked: dkimRecord(512),
            },
            revokedSelectors: ['revoked'],
          },
        }),
      },
    });

    const result = check(view, 'dkim_key_length');
    expect(result.status).toBe('meets');
    expect(result.evidence.join(' ')).toContain('Ed25519');
    expect(result.evidence.join(' ')).toContain('2048');
    expect(result.evidence.join(' ')).not.toContain('revoked');
  });

  it('fails an RSA key under 1024 bits and names its selector', () => {
    const view = evaluate({
      scan: {
        id: 's1',
        completedAt: now.toISOString(),
        result: scan({ dkim: { status: 'found', records: { short: dkimRecord(512) } } }),
      },
    });
    const result = check(view, 'dkim_key_length');
    expect(result.status).toBe('fails');
    expect(result.summary).toContain('short');
    expect(result.summary).toContain('512');
  });

  it('is not measured without a completed scan', () => {
    expect(check(evaluate({ scan: null }), 'dkim_key_length').status).toBe('not_measured');
  });
});

describe('reverse DNS', () => {
  it('counts only DMARC-passing mail and meets at exactly 5% unconfirmed', () => {
    const view = evaluate({
      reports: [
        report('google', [
          record({ sourceIp: '198.51.100.1', messageCount: 90 }),
          record({ sourceIp: '198.51.100.2', messageCount: 5 }),
          record({ sourceIp: '198.51.100.3', messageCount: 5 }),
          record({ sourceIp: '198.51.100.9', messageCount: 1_000, dkimResult: 'fail', spfResult: 'fail' }),
        ]),
      ],
      ipIntel: {
        '198.51.100.1': { ptr: 'mail.example.com', ptrConfirmed: true, status: 'OK', expiresAt: new Date(now.getTime() + 86_400_000) },
        '198.51.100.2': { ptr: 'bad.example.com', ptrConfirmed: false, status: 'PARTIAL', expiresAt: new Date(now.getTime() + 86_400_000) },
        '198.51.100.3': { ptr: null, ptrConfirmed: false, status: 'FAILED', expiresAt: new Date(now.getTime() - 86_400_000) },
        '198.51.100.9': { ptr: null, ptrConfirmed: false, status: 'PRIVATE', expiresAt: new Date(now.getTime() + 86_400_000) },
      },
    });

    const result = check(view, 'reverse_dns');
    expect(result.status).toBe('meets');
    expect(result.evidence.join(' ')).toContain('lookup is pending');
    expect(result.evidence.join(' ')).toContain('198.51.100.2');
  });

  it('fails above 5%, lists at most ten IPs, and handles all-pending and private addresses', () => {
    const failed = Array.from({ length: 12 }, (_, index) =>
      record({ sourceIp: `203.0.113.${index + 1}`, messageCount: 10 }),
    );
    const intel = Object.fromEntries(
      failed.map((entry) => [
        entry.sourceIp,
        { ptr: null, ptrConfirmed: false, status: 'FAILED' as const, expiresAt: new Date(now.getTime() + 86_400_000) },
      ]),
    );
    const view = evaluate({
      reports: [report('google', [record({ sourceIp: '198.51.100.1', messageCount: 100 }), ...failed])],
      ipIntel: {
        '198.51.100.1': { ptr: 'mail.example.com', ptrConfirmed: true, status: 'OK', expiresAt: new Date(now.getTime() + 86_400_000) },
        ...intel,
      },
    });
    const result = check(view, 'reverse_dns');
    expect(result.status).toBe('fails');
    expect(result.evidence.filter((line) => line.includes('no PTR record')).length).toBeLessThanOrEqual(10);

    const pending = evaluate({
      reports: [report('google', [record({ sourceIp: '198.51.100.1', messageCount: 100 })])],
      ipIntel: {},
    });
    expect(check(pending, 'reverse_dns').status).toBe('not_measured');

    const privateOnly = evaluate({
      reports: [report('google', [record({ sourceIp: '10.0.0.1', messageCount: 100 })])],
      ipIntel: {
        '10.0.0.1': { ptr: null, ptrConfirmed: false, status: 'PRIVATE', expiresAt: new Date(now.getTime() + 86_400_000) },
      },
    });
    expect(check(privateOnly, 'reverse_dns').status).toBe('not_measured');
  });
});

describe('evidence from other receivers', () => {
  it('checks reverse DNS for IPs only another receiver reported, without counting that mail toward a provider', () => {
    const view = evaluate({
      reports: [report(null, [record({ sourceIp: '198.51.100.9', messageCount: 400 })])],
      ipIntel: {
        '198.51.100.9': { ptr: null, ptrConfirmed: false, status: 'FAILED', expiresAt: new Date(now.getTime() + 86_400_000) },
      },
    });

    expect(check(view, 'reverse_dns').status).toBe('fails');
    expect(check(view, 'reverse_dns').evidence.join(' ')).toContain('198.51.100.9');
    expect(view.providers.every((provider) => provider.messages === 0)).toBe(true);
    expect(check(view, 'dmarc_passing').status).toBe('not_measured');
  });
});

describe('checks without a completed scan', () => {
  it('marks the DNS checks not measured and keeps report-only checks available', () => {
    const view = evaluate({
      scan: null,
      reports: [report('google', [record({ messageCount: 100 })])],
    });

    // DKIM passing in the reports is proof enough for "SPF or DKIM".
    expect(check(view, 'spf_or_dkim').status).toBe('meets');
    expect(check(view, 'dkim_key_length').status).toBe('not_measured');
    expect(check(view, 'spf_record').status).toBe('not_measured');
    expect(check(view, 'dmarc_record').status).toBe('not_measured');
    expect(check(view, 'dmarc_reporting').status).toBe('not_measured');
    expect(check(view, 'dmarc_passing').status).toBe('meets');
    expect(check(view, 'dkim_record').status).toBe('meets');
    expect(check(view, 'reverse_dns').status).toBe('not_measured');
  });

  it('adds up and never uses the word compliant', () => {
    const view = evaluate({
      reports: [report('google', [record({ messageCount: 100 })])],
    });
    const total = Object.values(view.counts).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(view.checks.length);
    expect(view.checks).toHaveLength(14);
    expect(view.checks.map((item) => item.status)).toContain('not_checkable');
    expect(JSON.stringify(view).toLowerCase()).not.toContain('compliant');
  });
});
