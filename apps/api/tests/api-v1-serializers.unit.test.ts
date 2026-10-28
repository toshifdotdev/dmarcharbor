import { describe, expect, it } from 'vitest';
import {
  serializeAlert,
  serializeDnsChange,
  serializeDomainDetail,
  serializeMe,
  serializeReport,
  serializeScan,
  serializeSender,
  serializeTlsSummary,
} from '../src/services/api-v1/serializers.js';
import type { ResolvedEntitlements } from '../src/services/entitlements/entitlement.service.js';
import type { SenderBreakdownRow } from '../src/services/sender-breakdown.service.js';
import type { TlsReportSummary } from '../src/services/tls-report/tls-report-query.service.js';

/**
 * The allowlist test.
 *
 * `/api/v1` is a contract with software we cannot redeploy, so a field appearing
 * in a response without anybody deciding it should is a defect. Each case below
 * asserts the **exact** key set of a serialiser. Adding a field to a serialiser
 * therefore fails this suite until it is listed here too, which is the moment
 * somebody asks whether it belongs on the public surface at all.
 *
 * It also proves the reverse: that a column the serializer does not name cannot
 * arrive, because nothing here spreads a database row.
 */

const entitlements: ResolvedEntitlements = {
  plan: 'HARBOR',
  label: 'Harbor',
  status: 'ACTIVE',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  maxClients: 200,
  maxActiveDomains: 500,
  maxMembers: 25,
  activeDomainWindowDays: 30,
  // Only the two flags these cases read; the type wants the whole catalogue.
  features: { 'api.access': true, 'alerts.email': true } as unknown as ResolvedEntitlements['features'],
  overrides: [],
};

describe('serializeMe', () => {
  it('returns exactly the documented keys', () => {
    const body = serializeMe({
      organization: { id: 'org_1', name: 'Northwind', slug: 'northwind' },
      entitlements,
      key: { id: 'key_1', name: 'Integration', scopes: ['read'], expiresAt: new Date('2027-01-01T00:00:00Z') },
    });

    expect(Object.keys(body).sort()).toEqual(['features', 'key', 'limits', 'plan', 'workspace']);
    expect(Object.keys(body.workspace).sort()).toEqual(['id', 'name', 'slug']);
    expect(Object.keys(body.plan).sort()).toEqual(['currentPeriodEnd', 'label', 'status', 'tier']);
    expect(Object.keys(body.limits).sort()).toEqual(['maxActiveDomains', 'maxClients', 'maxMembers']);
    expect(Object.keys(body.key).sort()).toEqual(['expiresAt', 'id', 'name', 'scopes']);
    expect(body.key.expiresAt).toBe('2027-01-01T00:00:00.000Z');
  });

  it('copies the feature flags rather than handing out the internal object', () => {
    const body = serializeMe({
      organization: { id: 'org_1', name: 'Northwind', slug: 'northwind' },
      entitlements,
      key: { id: 'key_1', name: 'Integration', scopes: ['read'], expiresAt: null },
    });

    body.features['api.access'] = false;
    expect(entitlements.features['api.access']).toBe(true);
  });
});

describe('serializeDomainDetail', () => {
  it('returns exactly the documented keys, and coerces JSON columns to string lists', () => {
    const body = serializeDomainDetail({
      id: 'dom_1',
      name: 'example.com',
      slug: 'example-com-abc123',
      status: 'VERIFIED',
      dmarcPolicy: 'reject',
      dmarcRecord: 'v=DMARC1; p=reject',
      verifiedAt: new Date('2026-01-01T00:00:00Z'),
      score: 82,
      collectForensicReports: false,
      lastScanAt: null,
      spfRecord: 'v=spf1 -all',
      mxRecords: ['mx1.example.com', 42, null],
      dkimSelectors: ['default'],
      client: { id: 'cl_1', name: 'Northwind', slug: 'northwind' },
    });

    expect(Object.keys(body).sort()).toEqual([
      'client',
      'collectForensicReports',
      'dkimSelectors',
      'dmarcPolicy',
      'dmarcRecord',
      'id',
      'lastScanAt',
      'mxRecords',
      'name',
      'registration',
      'score',
      'slug',
      'spfRecord',
      'status',
      'verifiedAt',
    ]);
    // Non-string entries in a Json column are dropped rather than serialised as
    // whatever Prisma held.
    expect(body.mxRecords).toEqual(['mx1.example.com']);
    expect(body.lastScanAt).toBeNull();
    expect(body.verifiedAt).toBe('2026-01-01T00:00:00.000Z');
    // Before the first lookup.
    expect(body.registration).toBeNull();
  });

  it('carries the registration expiry, without the lookup error or the warning state', () => {
    const body = serializeDomainDetail({
      id: 'dom_1',
      name: 'example.com',
      slug: 'example-com-abc123',
      status: 'VERIFIED',
      dmarcPolicy: null,
      dmarcRecord: null,
      verifiedAt: null,
      score: null,
      collectForensicReports: false,
      lastScanAt: null,
      spfRecord: null,
      mxRecords: [],
      dkimSelectors: [],
      client: { id: 'cl_1', name: 'Northwind', slug: 'northwind' },
      registration: {
        registrableDomain: 'example.com',
        status: 'ok',
        expiresAt: new Date('2027-08-13T04:00:00Z'),
        registrar: 'Example Registrar',
        checkedAt: new Date('2026-11-25T12:00:00Z'),
      },
    });

    expect(Object.keys(body.registration!).sort()).toEqual([
      'checkedAt',
      'expiresAt',
      'registrableDomain',
      'registrar',
      'status',
    ]);
    expect(body.registration!.expiresAt).toBe('2027-08-13T04:00:00.000Z');
  });
});

describe('serializeScan', () => {
  it('returns exactly the documented keys and never the scanner result', () => {
    const body = serializeScan({
      id: 'scan_1',
      status: 'COMPLETED',
      trigger: 'MANUAL',
      score: 90,
      error: null,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      completedAt: new Date('2026-01-01T00:00:05Z'),
      changeCount: 2,
    });

    expect(Object.keys(body).sort()).toEqual([
      'changeCount',
      'completedAt',
      'error',
      'id',
      'score',
      'startedAt',
      'status',
      'trigger',
    ]);
  });
});

describe('serializeReport', () => {
  it('returns counts, not rows', () => {
    const body = serializeReport({
      id: 'rep_1',
      reportId: 'google.com-123',
      reportingOrganization: 'google.com',
      reportType: 'AGGREGATE',
      dateRangeBegin: new Date('2026-01-01T00:00:00Z'),
      dateRangeEnd: new Date('2026-01-02T00:00:00Z'),
      receivedAt: new Date('2026-01-02T01:00:00Z'),
      recordCount: 2,
      records: [
        { messageCount: 10, dkimResult: 'pass', spfResult: 'fail' },
        { messageCount: 5, dkimResult: 'fail', spfResult: 'fail' },
      ],
    });

    expect(Object.keys(body).sort()).toEqual([
      'dateRangeBegin',
      'dateRangeEnd',
      'failedMessages',
      'id',
      'messageCount',
      'passedMessages',
      'receivedAt',
      'recordCount',
      'reportId',
      'reportType',
      'reportingOrganization',
    ]);

    // DMARC passes when either aligned check passed, which is the rule the rest
    // of the product counts by.
    expect(body.messageCount).toBe(15);
    expect(body.passedMessages).toBe(10);
    expect(body.failedMessages).toBe(5);
    // The source addresses the records carry are nowhere in the response.
    expect(JSON.stringify(body)).not.toContain('sourceIp');
  });
});

describe('serializeSender', () => {
  it('returns exactly the documented keys, without source addresses', () => {
    const row: SenderBreakdownRow = {
      senderKey: 'esp:sendgrid',
      senderDomain: 'sendgrid.net',
      sourceIps: ['203.0.113.10'],
      failingSourceIps: ['203.0.113.10'],
      totalMessages: 100,
      failedMessages: 12,
      failureSharePercent: 12,
      dmarcFailedMessages: 10,
      dmarcFailureSharePercent: 10,
      hasEnoughSignal: true,
      status: 'failing',
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-02T00:00:00.000Z',
      isNew: false,
      newSenderRisk: null,
      dkimPassMessages: 88,
      spfPassMessages: 90,
      service: { id: 'sendgrid', name: 'SendGrid', category: 'transactional' },
      confidence: 'confirmed',
      network: null,
      evidence: ['dkim aligned'],
      intelPending: false,
      review: { status: 'UNREVIEWED', note: null, reviewedAt: null, reviewedBy: null },
      owner: null,
    };

    const body = serializeSender(row);

    expect(Object.keys(body).sort()).toEqual([
      'confidence',
      'dkimPassMessages',
      'dmarcFailedMessages',
      'failedMessages',
      'failureSharePercent',
      'firstSeenAt',
      'isNew',
      'lastSeenAt',
      'review',
      'senderDomain',
      'service',
      'serviceName',
      'spfPassMessages',
      'status',
      'totalMessages',
    ]);
    expect(Object.keys(body.review).sort()).toEqual(['note', 'reviewedAt', 'status']);
    // The addresses are computed by the breakdown and deliberately not published.
    expect(JSON.stringify(body)).not.toContain('203.0.113.10');
  });
});

describe('serializeAlert', () => {
  it('returns exactly the documented keys and one word for the state', () => {
    const base = {
      id: 'evt_1',
      ruleId: 'rule_1',
      metric: 'DMARC_FAILURE_RATE',
      operator: 'GT',
      observedValue: 12,
      threshold: 5,
      windowMinutes: 60,
      summary: 'Failure rate above 5%',
      reminderLevel: 1,
      triggeredAt: new Date('2026-01-01T00:00:00Z'),
      domain: { id: 'dom_1', name: 'example.com', slug: 'example-com-abc123' },
      rule: { id: 'rule_1', name: 'Failures' },
    };

    const open = serializeAlert({ ...base, acknowledgedAt: null, resolvedAt: null });
    expect(Object.keys(open).sort()).toEqual([
      'acknowledgedAt',
      'domain',
      'id',
      'metric',
      'observedValue',
      'operator',
      'reminderLevel',
      'resolvedAt',
      'ruleId',
      'ruleName',
      'state',
      'summary',
      'threshold',
      'triggeredAt',
      'windowMinutes',
    ]);
    expect(open.state).toBe('open');

    expect(serializeAlert({ ...base, acknowledgedAt: new Date(), resolvedAt: null }).state).toBe(
      'acknowledged',
    );
    // Resolved wins over acknowledged: an alert that has resolved is not waiting
    // on anybody, whoever acknowledged it first.
    expect(
      serializeAlert({ ...base, acknowledgedAt: new Date(), resolvedAt: new Date() }).state,
    ).toBe('resolved');
  });
});

describe('serializeDnsChange', () => {
  it('returns exactly the documented keys', () => {
    const body = serializeDnsChange({
      id: 'chg_1',
      kind: 'SPF',
      severity: 'CRITICAL',
      code: 'SPF_REMOVED',
      summary: 'SPF record removed',
      before: 'v=spf1 -all',
      after: null,
      detectedAt: new Date('2026-01-01T00:00:00Z'),
      scanId: 'scan_1',
      acknowledgedAt: null,
      acknowledgedBy: null,
      domain: { id: 'dom_1', name: 'example.com', slug: 'example-com-abc123' },
    });

    expect(Object.keys(body).sort()).toEqual([
      'acknowledgedAt',
      'acknowledgedBy',
      'code',
      'detectedAt',
      'id',
      'kind',
      'scanId',
      'severity',
      'summary',
    ]);
    // `before` and `after` are the raw record values and stay internal.
    expect(JSON.stringify(body)).not.toContain('v=spf1');
  });
});

describe('serializeTlsSummary', () => {
  it('returns exactly the documented keys', () => {
    const summary: TlsReportSummary = {
      days: 30,
      reportCount: 4,
      successfulSessions: 1000,
      failedSessions: 20,
      failureSharePercent: 1.96,
      lastReportAt: '2026-01-02T00:00:00.000Z',
      byResultType: [{ resultType: 'certificate-expired', failedSessions: 20, reporters: ['google.com'] }],
      byMxHost: [
        { receivingMxHostname: 'mx.example.com', failedSessions: 20, resultTypes: ['certificate-expired'] },
      ],
      byPolicyType: [{ policyType: 'sts', successfulSessions: 1000, failedSessions: 20 }],
      record: {
        status: 'ours',
        host: '_smtp._tls.example.com',
        current: 'v=TLSRPTv1; rua=mailto:tls@example.com',
        suggested: 'v=TLSRPTv1; rua=mailto:tls@example.com',
      },
    };

    const body = serializeTlsSummary(summary);

    expect(Object.keys(body).sort()).toEqual([
      'byMxHost',
      'byPolicyType',
      'byResultType',
      'days',
      'failedSessions',
      'failureSharePercent',
      'lastReportAt',
      'record',
      'reportCount',
      'successfulSessions',
    ]);
    expect(Object.keys(body.record).sort()).toEqual(['current', 'host', 'status', 'suggested']);
  });
});
