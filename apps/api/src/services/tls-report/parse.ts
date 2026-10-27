/**
 * Parsing a TLS-RPT report (RFC 8460 section 4.4).
 *
 * The report is untrusted JSON from an arbitrary sender. Every collection is
 * bounded before it reaches the database, text fields are cut rather than
 * rejected, and a report that names two different policy domains is refused
 * because routing it to one of them would be a guess.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const maxTlsPolicies = 100;
export const maxTlsFailuresPerPolicy = 1_000;
export const maxTlsSessionCount = 1_000_000_000_000;
export const maxTlsTextLength = 255;
export const maxTlsAdditionalInformationLength = 1_000;
export const maxTlsPolicyStringLength = 2_000;

export class TlsReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TlsReportParseError';
  }
}

export interface ParsedTlsFailure {
  resultType: string;
  sendingMtaIp: string | null;
  receivingMxHostname: string | null;
  receivingMxHelo: string | null;
  receivingIp: string | null;
  failedSessions: number;
  additionalInformation: string | null;
  failureReasonCode: string | null;
}

export interface ParsedTlsPolicy {
  policyType: 'sts' | 'tlsa' | 'no-policy-found';
  policyString: string | null;
  mxHost: string | null;
  successfulSessions: number;
  failedSessions: number;
  failures: ParsedTlsFailure[];
}

export interface ParsedTlsReport {
  fingerprint: string;
  reportIdentity: string;
  organizationName: string;
  contactInfo: string | null;
  reportId: string;
  policyDomain: string;
  dateRangeBegin: Date;
  dateRangeEnd: Date;
  successfulSessions: number;
  failedSessions: number;
  truncated: boolean;
  policies: ParsedTlsPolicy[];
}

const sessionCount = z
  .number()
  .int()
  .min(0, 'must be a non-negative integer no larger than 10^12')
  .max(maxTlsSessionCount, 'must be a non-negative integer no larger than 10^12');

const failureSchema = z.object({
  'result-type': z.string(),
  'sending-mta-ip': z.string().optional(),
  'receiving-mx-hostname': z.string().optional(),
  'receiving-mx-helo': z.string().optional(),
  'receiving-ip': z.string().optional(),
  'failed-session-count': sessionCount,
  'additional-information': z.string().optional(),
  'failure-reason-code': z.string().optional(),
});

const policySchema = z.object({
  policy: z.object({
    'policy-type': z.enum(['sts', 'tlsa', 'no-policy-found']),
    'policy-string': z.array(z.string()).optional(),
    'policy-domain': z.string().min(1),
    // RFC 8460 shows a string, but some reporters send a list of patterns.
    // Refusing the list would drop the whole report over a display field.
    'mx-host': z.union([z.string(), z.array(z.string())]).optional(),
  }),
  summary: z.object({
    'total-successful-session-count': sessionCount,
    'total-failure-session-count': sessionCount,
  }),
  'failure-details': z.array(failureSchema).optional(),
});

const reportSchema = z.object({
  'organization-name': z.string().min(1),
  'date-range': z.object({
    'start-datetime': z.string().datetime({ offset: true }),
    'end-datetime': z.string().datetime({ offset: true }),
  }),
  'contact-info': z.string().optional(),
  'report-id': z.string().min(1),
  policies: z.array(policySchema).min(1).max(maxTlsPolicies),
});

function cut(value: string | undefined, limit = maxTlsTextLength): string | null {
  if (value === undefined) {
    return null;
  }
  return value.slice(0, limit);
}

function normaliseDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

function describeIssue(issue: z.ZodIssue): string {
  const field = issue.path.join('.') || 'report';
  // Zod 4 no longer types `received`; its message ends "received undefined"
  // when the key is absent.
  if (issue.code === 'invalid_type' && /received undefined$/.test(issue.message)) {
    return `The report is missing ${field}.`;
  }
  if (issue.code === 'too_small' && field.includes('session-count')) {
    return `${field} must be a non-negative integer no larger than 10^12.`;
  }
  if (issue.code === 'too_big') {
    if (field === 'policies') {
      return `The report has more than ${maxTlsPolicies} policies.`;
    }
    return `${field} must be a non-negative integer no larger than 10^12.`;
  }
  if (issue.code === 'too_small' && field === 'policies') {
    return 'The report has no policies.';
  }
  if (issue.code === 'invalid_format' && issue.format === 'datetime') {
    return `${field} is not an RFC 3339 date.`;
  }
  if (issue.code === 'invalid_value') {
    return `${field} is not a recognised value.`;
  }
  return `The report has an invalid ${field}.`;
}

export function parseTlsReport(json: string): ParsedTlsReport {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new TlsReportParseError('The TLS report is not valid JSON.');
  }

  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TlsReportParseError(describeIssue(parsed.error.issues[0]!));
  }
  const report = parsed.data;

  const begin = new Date(report['date-range']['start-datetime']);
  const end = new Date(report['date-range']['end-datetime']);
  if (Number.isNaN(begin.getTime()) || Number.isNaN(end.getTime())) {
    throw new TlsReportParseError('The report date range is not an RFC 3339 date.');
  }
  if (end.getTime() < begin.getTime()) {
    throw new TlsReportParseError("The report's date range ends before it starts.");
  }

  const domains = new Set(report.policies.map((policy) => normaliseDomain(policy.policy['policy-domain'])));
  if (domains.size > 1) {
    throw new TlsReportParseError('The report covers more than one domain.');
  }
  const policyDomain = [...domains][0]!;

  let truncated = false;
  let successfulSessions = 0;
  let failedSessions = 0;
  const policies: ParsedTlsPolicy[] = report.policies.map((policy) => {
    successfulSessions += policy.summary['total-successful-session-count'];
    failedSessions += policy.summary['total-failure-session-count'];
    const failures = policy['failure-details'] ?? [];
    if (failures.length > maxTlsFailuresPerPolicy) {
      truncated = true;
    }
    return {
      policyType: policy.policy['policy-type'],
      policyString:
        policy.policy['policy-string'] === undefined
          ? null
          : policy.policy['policy-string'].join('\n').slice(0, maxTlsPolicyStringLength),
      mxHost: cut(
        Array.isArray(policy.policy['mx-host'])
          ? policy.policy['mx-host'].join(', ') || undefined
          : policy.policy['mx-host'],
      ),
      successfulSessions: policy.summary['total-successful-session-count'],
      failedSessions: policy.summary['total-failure-session-count'],
      failures: failures.slice(0, maxTlsFailuresPerPolicy).map((failure) => ({
        resultType: failure['result-type'].slice(0, maxTlsTextLength),
        sendingMtaIp: cut(failure['sending-mta-ip']),
        receivingMxHostname: cut(failure['receiving-mx-hostname']),
        receivingMxHelo: cut(failure['receiving-mx-helo']),
        receivingIp: cut(failure['receiving-ip']),
        failedSessions: failure['failed-session-count'],
        additionalInformation: cut(
          failure['additional-information'],
          maxTlsAdditionalInformationLength,
        ),
        failureReasonCode: cut(failure['failure-reason-code']),
      })),
    };
  });

  const identitySource = [
    report['organization-name'],
    report['report-id'],
    report['date-range']['start-datetime'],
    report['date-range']['end-datetime'],
    policyDomain,
  ]
    .join('|')
    .toLowerCase();

  return {
    fingerprint: createHash('sha256').update(json, 'utf8').digest('hex'),
    reportIdentity: createHash('sha256').update(identitySource, 'utf8').digest('hex'),
    organizationName: report['organization-name'].slice(0, maxTlsTextLength),
    contactInfo: cut(report['contact-info']),
    reportId: report['report-id'].slice(0, maxTlsTextLength),
    policyDomain,
    dateRangeBegin: begin,
    dateRangeEnd: end,
    successfulSessions,
    failedSessions,
    truncated,
    policies,
  };
}
