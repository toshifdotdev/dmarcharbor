import { createPublicKey } from 'node:crypto';
import { organizationalDomain, passesDmarc } from '../alignment.service.js';
import {
  classifySender,
  senderBreakdownThresholds,
} from '../sender-breakdown.service.js';

export type MailboxProviderId = 'google' | 'yahoo' | 'microsoft';
export type RequirementLevel = 'every_sender' | 'bulk' | 'recommended';
export type CheckStatus = 'meets' | 'fails' | 'unconfirmed' | 'not_measured' | 'not_checkable';

export const mailboxWindowDays = 30;
export const mailboxRecordCap = 50_000;
export const mailboxDailyRangeHours = 25;

export interface MailboxProviderDefinition {
  id: MailboxProviderId;
  name: 'Google' | 'Yahoo' | 'Microsoft';
  covers: string;
  bulkThreshold: number | null;
  bulkThresholdRule: string;
  source: string;
}

export const MAILBOX_PROVIDERS: Record<MailboxProviderId, MailboxProviderDefinition> = {
  google: {
    id: 'google',
    name: 'Google',
    covers: 'Gmail and Google Workspace',
    bulkThreshold: 5_000,
    bulkThresholdRule: 'more than 5,000 a day',
    source: 'https://support.google.com/a/answer/81126',
  },
  yahoo: {
    id: 'yahoo',
    name: 'Yahoo',
    covers: 'Yahoo Mail',
    bulkThreshold: null,
    bulkThresholdRule: 'Yahoo publishes no volume figure',
    source: 'https://senders.yahooinc.com/best-practices/',
  },
  microsoft: {
    id: 'microsoft',
    name: 'Microsoft',
    covers: 'Outlook.com and Microsoft 365',
    bulkThreshold: 5_000,
    bulkThresholdRule: '5,000 or more',
    source: 'https://support.microsoft.com/en-us/outlook/fix-ndr-error-550-5-7-515-in-outlook-com',
  },
};

/**
 * The only reporter-to-provider mapping. Anything not named here is not one of
 * the three providers, even if it looks similar.
 */
export const MAILBOX_REPORT_PROVIDERS = {
  emailDomains: {
    'google.com': 'google',
    'yahooinc.com': 'yahoo',
    'yahoo.com': 'yahoo',
    'microsoft.com': 'microsoft',
    'outlook.com': 'microsoft',
  },
  organizations: {
    'google.com': 'google',
    yahoo: 'yahoo',
    'outlook.com': 'microsoft',
    'enterprise outlook': 'microsoft',
  },
} as const satisfies {
  emailDomains: Record<string, MailboxProviderId>;
  organizations: Record<string, MailboxProviderId>;
};

export function providerForReport(
  reportingEmail: string | null | undefined,
  reportingOrganization: string | null | undefined,
): MailboxProviderId | null {
  const email = (reportingEmail ?? '').trim().toLowerCase();
  if (email) {
    const domain = email.includes('@') ? email.split('@').pop() ?? '' : email;
    return MAILBOX_REPORT_PROVIDERS.emailDomains[domain as keyof typeof MAILBOX_REPORT_PROVIDERS.emailDomains] ?? null;
  }

  const organisation = (reportingOrganization ?? '').trim().toLowerCase();
  return (
    MAILBOX_REPORT_PROVIDERS.organizations[
      organisation as keyof typeof MAILBOX_REPORT_PROVIDERS.organizations
    ] ?? null
  );
}

export interface MailboxRecordInput {
  sourceIp: string;
  messageCount: number;
  dkimResult: string | null;
  spfResult: string | null;
  senderKey: string | null;
  senderDomain: string | null;
  /** Raw SPF pass: an SPF auth result with scope null or mfrom. */
  spfRawPass: boolean;
}

export interface MailboxReportInput {
  id: string;
  /**
   * Null for every other receiver. Those reports still count toward the
   * reverse-DNS and DKIM evidence: a sending IP's PTR, and whether the domain
   * signs with DKIM, do not depend on which receiver reported the mail.
   */
  provider: MailboxProviderId | null;
  dateRangeBegin: Date | null;
  dateRangeEnd: Date | null;
  receivedAt: Date;
  records: MailboxRecordInput[];
}

export interface MailboxIpIntel {
  ptr: string | null;
  ptrConfirmed: boolean;
  status: 'OK' | 'PARTIAL' | 'FAILED' | 'PRIVATE';
  expiresAt: Date;
}

export interface MailboxScanInput {
  dmarc: {
    status: string;
    policy: string;
    record?: string;
    hasAggregateReports: boolean;
    aggregateMailtoTargets: string[];
    aggregateWebTargets: string[];
    testing?: boolean;
  };
  spf: {
    status: string;
    valid: boolean;
    record?: string;
    lookupLimitExceeded?: boolean;
    voidLookupLimitExceeded?: boolean;
  };
  dkim: {
    status: string;
    records: Record<string, string>;
    revokedSelectors?: string[];
  };
  issues: Array<{
    code: string;
    severity?: string;
    title: string;
    message?: string;
    recommendation?: string;
  }>;
}

export interface MailboxComplianceInput {
  domain: { id: string; name: string };
  scan: { id: string; completedAt: string; result: MailboxScanInput } | null;
  reports: MailboxReportInput[];
  reviewStatusBySender: Record<string, 'APPROVED' | 'NOT_OURS' | null>;
  ipIntel: Record<string, MailboxIpIntel | null | undefined>;
  now: Date;
  rowsTruncated: boolean;
}

export interface MailboxFailingSender {
  senderKey: string;
  label: string;
  messages: number;
  failingMessages: number;
  failingSharePercent: number;
  sourceIps: string[];
}

export interface MailboxPerProvider {
  provider: MailboxProviderId;
  status: CheckStatus;
  messages: number;
  failingMessages: number;
  failingSharePercent: number | null;
  failingSenders: MailboxFailingSender[];
  note: string | null;
}

export interface MailboxCheck {
  code: string;
  group: RequirementLevel;
  title: string;
  requiredBy: Array<{ provider: MailboxProviderId; level: RequirementLevel; source: string }>;
  status: CheckStatus;
  summary: string;
  evidence: string[];
  fix: string | null;
  whereToCheck: Array<{ label: string; url: string }>;
  perProvider: MailboxPerProvider[] | null;
}

export interface MailboxComplianceView {
  domain: { id: string; name: string };
  generatedAt: string;
  windowDays: 30;
  thresholds: { minimumMessagesForSignal: number; maximumFailureSharePercent: number };
  scan: { id: string; completedAt: string } | null;
  rowsTruncated: boolean;
  providers: Array<{
    id: MailboxProviderId;
    name: 'Google' | 'Yahoo' | 'Microsoft';
    covers: string;
    bulkThreshold: number | null;
    bulkThresholdRule: string;
    reportCount: number;
    messages: number;
    peakDailyMessages: number | null;
    peakDay: string | null;
    aboveBulkThreshold: boolean | null;
    lastReportAt: string | null;
    source: string;
  }>;
  checks: MailboxCheck[];
  counts: { meets: number; fails: number; unconfirmed: number; notMeasured: number; notCheckable: number };
}

const statusOrder: CheckStatus[] = ['fails', 'unconfirmed', 'meets', 'not_measured'];

export function worstStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.length === 0) {
    return 'not_measured';
  }
  return [...statuses].sort((left, right) => statusOrder.indexOf(left) - statusOrder.indexOf(right))[0]!;
}

function roundShare(value: number): number {
  return Math.round(value * 10) / 10;
}

function pass(value: string | null): boolean {
  return (value ?? '').trim().toLowerCase() === 'pass';
}

function startOfWindow(now: Date): Date {
  return new Date(now.getTime() - mailboxWindowDays * 24 * 60 * 60 * 1000);
}

export function reportInWindow(
  report: Pick<MailboxReportInput, 'dateRangeEnd' | 'receivedAt'>,
  now: Date,
): boolean {
  const start = startOfWindow(now);
  return report.dateRangeEnd
    ? report.dateRangeEnd.getTime() >= start.getTime()
    : report.receivedAt.getTime() >= start.getTime();
}

function senderKeyFor(record: MailboxRecordInput): string {
  return record.senderKey ?? `${record.sourceIp}|unknown`;
}

function isCounted(
  record: MailboxRecordInput,
  reviewStatusBySender: MailboxComplianceInput['reviewStatusBySender'],
): boolean {
  return reviewStatusBySender[senderKeyFor(record)] !== 'NOT_OURS';
}

interface SenderAggregate {
  senderKey: string;
  senderDomain: string | null;
  messages: number;
  failingMessages: number;
  sourceIps: Set<string>;
}

function providerRecords(
  reports: Array<MailboxReportInput & { inWindow: boolean }>,
  provider: MailboxProviderId,
  reviewStatusBySender: MailboxComplianceInput['reviewStatusBySender'],
): MailboxRecordInput[] {
  return reports
    .filter((report) => report.inWindow && report.provider === provider)
    .flatMap((report) => report.records)
    .filter((record) => isCounted(record, reviewStatusBySender));
}

function senderAggregates(
  records: MailboxRecordInput[],
  isFailure: (record: MailboxRecordInput) => boolean,
): SenderAggregate[] {
  const groups = new Map<string, SenderAggregate>();
  for (const record of records) {
    const key = senderKeyFor(record);
    const group = groups.get(key) ?? {
      senderKey: key,
      senderDomain: record.senderDomain,
      messages: 0,
      failingMessages: 0,
      sourceIps: new Set<string>(),
    };
    group.messages += record.messageCount;
    if (isFailure(record)) {
      group.failingMessages += record.messageCount;
    }
    group.sourceIps.add(record.sourceIp);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function failingSenderView(group: SenderAggregate): MailboxFailingSender {
  return {
    senderKey: group.senderKey,
    label: group.senderDomain ?? group.senderKey,
    messages: group.messages,
    failingMessages: group.failingMessages,
    failingSharePercent: group.messages ? roundShare((group.failingMessages / group.messages) * 100) : 0,
    sourceIps: [...group.sourceIps].slice(0, 5),
  };
}

function required(
  provider: MailboxProviderId,
  level: RequirementLevel,
): { provider: MailboxProviderId; level: RequirementLevel; source: string } {
  return { provider, level, source: MAILBOX_PROVIDERS[provider].source };
}

function check(
  input: Pick<MailboxCheck, 'code' | 'group' | 'title' | 'status' | 'summary' | 'evidence' | 'fix'>,
  requiredBy: MailboxCheck['requiredBy'],
  perProvider: MailboxPerProvider[] | null = null,
  whereToCheck: MailboxCheck['whereToCheck'] = [],
): MailboxCheck {
  return { ...input, requiredBy, perProvider, whereToCheck };
}

function issueFor(scan: MailboxScanInput | null, code: string) {
  return scan?.issues.find((issue) => issue.code === code) ?? null;
}

function providerCheck(
  code: string,
  title: string,
  isFailure: (record: MailboxRecordInput) => boolean,
  reports: Array<MailboxReportInput & { inWindow: boolean }>,
  reviewStatusBySender: MailboxComplianceInput['reviewStatusBySender'],
): MailboxCheck {
  const perProvider = (Object.keys(MAILBOX_PROVIDERS) as MailboxProviderId[]).map((provider): MailboxPerProvider => {
    const definition = MAILBOX_PROVIDERS[provider];
    const reportsForProvider = reports.filter((report) => report.inWindow && report.provider === provider);
    const records = providerRecords(reports, provider, reviewStatusBySender);
    const messages = records.reduce((total, record) => total + record.messageCount, 0);
    const failingMessages = records.reduce(
      (total, record) => total + (isFailure(record) ? record.messageCount : 0),
      0,
    );
    const groups = senderAggregates(records, isFailure);
    const judged = groups.filter(
      (group) => group.messages >= senderBreakdownThresholds.minimumMessagesForSignal,
    );

    let status: CheckStatus;
    let note: string | null = null;
    if (reportsForProvider.length === 0) {
      status = 'not_measured';
      note = `${definition.name} sent no aggregate report for this domain in the last 30 days. That can mean no mail went to ${definition.name}, or that reports are not reaching us.`;
    } else if (judged.length === 0) {
      status = 'not_measured';
      note = 'Fewer than 50 messages from any one sender: too little to judge.';
    } else if (
      judged.some(
        (group) =>
          classifySender(group.messages, group.failingMessages) === 'failing',
      )
    ) {
      status = 'fails';
    } else {
      status = 'meets';
    }

    const failingSenders = judged
      .filter((group) => classifySender(group.messages, group.failingMessages) === 'failing')
      .map(failingSenderView)
      .sort((left, right) => right.failingMessages - left.failingMessages || right.messages - left.messages);

    return {
      provider,
      status,
      messages,
      failingMessages,
      failingSharePercent: messages ? roundShare((failingMessages / messages) * 100) : null,
      failingSenders,
      note,
    };
  });

  const status = worstStatus(perProvider.map((entry) => entry.status));
  const failing = perProvider.filter((entry) => entry.status === 'fails');
  const measured = perProvider.filter((entry) => entry.status === 'meets');
  const degradedEvidence = perProvider.flatMap((entry) => {
    const provider = MAILBOX_PROVIDERS[entry.provider];
    const records = providerRecords(reports, entry.provider, reviewStatusBySender);
    const groups = senderAggregates(records, isFailure).filter(
      (group) =>
        group.messages >= senderBreakdownThresholds.minimumMessagesForSignal &&
        group.failingMessages > 0 &&
        classifySender(group.messages, group.failingMessages) === 'degraded',
    );
    return groups.map(
      (group) =>
        `${provider.name}: ${group.senderDomain ?? group.senderKey} failed ${group.failingMessages} of ${group.messages} messages (${roundShare((group.failingMessages / group.messages) * 100)}%), within the ${senderBreakdownThresholds.maximumFailureSharePercent}% DMARC Harbor threshold.`,
    );
  });

  let summary: string;
  if (status === 'fails') {
    summary = failing
      .map(
        (entry) =>
          `${MAILBOX_PROVIDERS[entry.provider].name}: ${entry.failingSenders.length} sender${entry.failingSenders.length === 1 ? '' : 's'} failed on more than ${senderBreakdownThresholds.maximumFailureSharePercent}% of ${entry.failingSenders.length === 1 ? 'its' : 'their'} messages.`,
      )
      .join(' ');
  } else if (status === 'meets') {
    summary = `No judged sender failed more than ${senderBreakdownThresholds.maximumFailureSharePercent}% of its messages for ${measured.map((entry) => MAILBOX_PROVIDERS[entry.provider].name).join(', ')}.`;
  } else {
    summary = perProvider
      .filter((entry) => entry.status === 'not_measured')
      .map((entry) => entry.note)
      .filter((note): note is string => Boolean(note))
      .join(' ');
  }

  return check(
    {
      code,
      group: 'bulk',
      title,
      status,
      summary,
      evidence: degradedEvidence,
      fix:
        status === 'fails'
          ? 'Fix the failing sender’s SPF or DKIM, or mark it “Not ours” on the Senders tab. Until a sender is marked Not ours, its failures count against this domain.'
          : status === 'not_measured'
            ? 'Wait for reports from this provider, and confirm the domain’s rua= address is receiving them.'
            : null,
    },
    [required('google', 'bulk'), required('yahoo', 'bulk'), required('microsoft', 'bulk')],
    perProvider,
  );
}

interface KeyFact {
  selector: string;
  bits: number;
}

function dkimTags(record: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of record.split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0) {
      tags[part.slice(0, separator).trim().toLowerCase()] = part
        .slice(separator + 1)
        .replace(/\s+/g, '')
        .trim();
    }
  }
  return tags;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function parseRsaKey(record: string): number | null {
  const tags = dkimTags(stripQuotes(record));
  const keyType = tags.k?.toLowerCase();
  if (keyType === 'ed25519') {
    return null;
  }
  const encoded = tags.p;
  if (!encoded) {
    return null;
  }
  const der = Buffer.from(encoded, 'base64');
  for (const type of ['spki', 'pkcs1'] as const) {
    try {
      const key = createPublicKey({ key: der, format: 'der', type });
      const bits = key.asymmetricKeyDetails?.modulusLength;
      if (typeof bits === 'number') {
        return bits;
      }
    } catch {
      // Try the next encoding, then give up on this selector.
    }
  }
  return null;
}

function isEd25519(record: string): boolean {
  return dkimTags(stripQuotes(record)).k?.toLowerCase() === 'ed25519';
}

function dkimKeyLengthCheck(scan: MailboxScanInput | null): MailboxCheck {
  const base = {
    code: 'dkim_key_length',
    group: 'every_sender' as const,
    title: 'DKIM RSA keys are at least 1024 bits',
    requiredBy: [required('google', 'every_sender'), required('yahoo', 'recommended')],
    whereToCheck: [] as Array<{ label: string; url: string }>,
  };

  if (!scan) {
    return check(
      {
        ...base,
        status: 'not_measured',
        summary: 'No completed DNS scan yet. Run a scan from the DNS scans tab.',
        evidence: [],
        fix: 'Run a DNS scan from the DNS scans tab.',
      },
      base.requiredBy,
    );
  }

  const revoked = new Set(scan.dkim.revokedSelectors ?? []);
  const keys: KeyFact[] = [];
  const ed25519: string[] = [];
  const unparsed: string[] = [];
  for (const [selector, record] of Object.entries(scan.dkim.records ?? {})) {
    if (revoked.has(selector)) {
      continue;
    }
    if (isEd25519(record)) {
      ed25519.push(`Selector ${selector}: Ed25519 key, length rule applies to RSA keys.`);
      continue;
    }
    const bits = parseRsaKey(record);
    if (bits === null) {
      unparsed.push(`Selector ${selector}: the key could not be read.`);
    } else {
      keys.push({ selector, bits });
    }
  }

  if (keys.length === 0) {
    return check(
      {
        ...base,
        status: 'unconfirmed',
        summary:
          ed25519.length > 0
            ? 'No RSA DKIM key was found to measure. The Ed25519 key was skipped.'
            : 'No RSA DKIM key could be read from the completed scan. The scanner may have missed a custom selector.',
        evidence: [...ed25519, ...unparsed],
        fix: 'Check the selector published by your email provider and scan again.',
      },
      base.requiredBy,
    );
  }

  const tooShort = keys.filter((key) => key.bits < 1024);
  const recommended: string[] = keys
    .filter((key) => key.bits >= 1024 && key.bits < 2048)
    .map((key) => `Selector ${key.selector}: ${key.bits}-bit RSA key. Google recommends 2048 bits.`);
  const measured = keys.map((key) => `Selector ${key.selector}: ${key.bits}-bit RSA key.`);

  return check(
    {
      ...base,
      status: tooShort.length > 0 ? 'fails' : 'meets',
      summary:
        tooShort.length > 0
          ? `${tooShort.map((key) => `${key.selector} is ${key.bits} bits`).join('; ')}. Google requires at least 1024 bits.`
          : `Every RSA key found is at least 1024 bits${recommended.length > 0 ? '; Google recommends 2048' : ''}.`,
      evidence: [...measured, ...recommended, ...ed25519, ...unparsed],
      fix:
        tooShort.length > 0
          ? 'Rotate the DKIM key to at least 1024 bits, preferably 2048, with your email provider.'
          : null,
    },
    base.requiredBy,
  );
}

function reverseDnsCheck(
  counted: MailboxRecordInput[],
  ipIntel: MailboxComplianceInput['ipIntel'],
  now: Date,
): MailboxCheck {
  const base = {
    code: 'reverse_dns',
    group: 'every_sender' as const,
    title: 'Sending IPs have confirmed reverse DNS',
    requiredBy: [required('google', 'every_sender'), required('yahoo', 'every_sender')],
    whereToCheck: [] as Array<{ label: string; url: string }>,
  };

  const passing = counted.filter((record) => passesDmarc(record));
  if (passing.length === 0) {
    return check(
      {
        ...base,
        status: 'not_measured',
        summary: 'No DMARC-passing mail was seen in the last 30 days.',
        evidence: [],
        fix: null,
      },
      base.requiredBy,
    );
  }

  const byIp = new Map<string, number>();
  for (const record of passing) {
    byIp.set(record.sourceIp, (byIp.get(record.sourceIp) ?? 0) + record.messageCount);
  }

  let consideredMessages = 0;
  let pendingMessages = 0;
  let notConfirmedMessages = 0;
  const notConfirmed: Array<{ ip: string; messages: number; ptr: string | null }> = [];
  const pending: string[] = [];

  for (const [ip, messages] of byIp) {
    const intel = ipIntel[ip];
    if (intel?.status === 'PRIVATE') {
      continue;
    }
    consideredMessages += messages;
    if (!intel || intel.expiresAt.getTime() <= now.getTime()) {
      pendingMessages += messages;
      pending.push(`${ip}: lookup pending.`);
      continue;
    }
    if (intel.ptrConfirmed) {
      continue;
    }
    notConfirmedMessages += messages;
    notConfirmed.push({ ip, messages, ptr: intel.ptr });
  }

  if (consideredMessages === 0) {
    return check(
      {
        ...base,
        status: 'not_measured',
        summary: 'No public sending IP was seen in DMARC-passing mail.',
        evidence: [],
        fix: null,
      },
      base.requiredBy,
    );
  }

  if (pendingMessages === consideredMessages) {
    return check(
      {
        ...base,
        status: 'not_measured',
        summary: 'Reverse DNS lookups for every sending IP are still pending.',
        evidence: pending.slice(0, 10),
        fix: 'The sender-intelligence job will fill these in automatically.',
      },
      base.requiredBy,
    );
  }

  notConfirmed.sort((left, right) => right.messages - left.messages);
  const evidence = [
    ...notConfirmed.slice(0, 10).map(
      (entry) =>
        `${entry.ip}: ${entry.messages} message${entry.messages === 1 ? '' : 's'}, ${entry.ptr ? `PTR ${entry.ptr} does not resolve back to this IP` : 'no PTR record found'}.`,
    ),
  ];
  if (pendingMessages > 0) {
    evidence.push(
      `${roundShare((pendingMessages / consideredMessages) * 100)}% of these messages came from IPs whose lookup is pending.`,
    );
  }

  const share = (notConfirmedMessages / consideredMessages) * 100;
  return check(
    {
      ...base,
      status: share > 5 ? 'fails' : 'meets',
      summary:
        share > 5
          ? `${roundShare(share)}% of DMARC-passing mail came from IPs without a confirmed, matching reverse DNS record.`
          : `Reverse DNS is confirmed for ${roundShare(100 - share)}% of DMARC-passing mail.${pendingMessages > 0 ? ` ${roundShare((pendingMessages / consideredMessages) * 100)}% is still pending.` : ''}`,
      evidence,
      fix:
        share > 5
          ? 'Ask the sending service to publish a PTR record that forward-resolves to the same IP, or correct the PTR at the IP owner.'
          : null,
    },
    base.requiredBy,
  );
}

function spfRecordCheck(scan: MailboxScanInput | null): MailboxCheck {
  const requiredBy = [required('google', 'bulk'), required('yahoo', 'bulk'), required('microsoft', 'bulk')];
  if (!scan) {
    return check(
      {
        code: 'spf_record',
        group: 'bulk',
        title: 'SPF record published',
        status: 'not_measured',
        summary: 'No completed DNS scan yet. Run a scan from the DNS scans tab.',
        evidence: [],
        fix: 'Run a DNS scan from the DNS scans tab.',
      },
      requiredBy,
    );
  }

  const includeBroken = issueFor(scan, 'spf_include_broken');
  const lookupIssue = issueFor(scan, 'spf_lookup_limit');
  const voidIssue = issueFor(scan, 'spf_void_lookup_limit');
  const invalidIssue = issueFor(scan, 'spf_invalid');
  const missingIssue = issueFor(scan, 'spf_missing');

  const reason =
    scan.spf.status === 'missing'
      ? missingIssue
      : !scan.spf.valid || scan.spf.status === 'error'
        ? invalidIssue
        : scan.spf.lookupLimitExceeded
          ? lookupIssue
          : scan.spf.voidLookupLimitExceeded
            ? voidIssue
            : includeBroken;
  const meets =
    scan.spf.status === 'found' &&
    scan.spf.valid &&
    !scan.spf.lookupLimitExceeded &&
    !scan.spf.voidLookupLimitExceeded &&
    !includeBroken;

  return check(
    {
      code: 'spf_record',
      group: 'bulk',
      title: 'SPF record published',
      status: meets ? 'meets' : 'fails',
      summary: meets
        ? 'The completed scan found one valid SPF record within the receiver lookup limits.'
        : (reason?.title ?? 'The SPF record could not be read cleanly.'),
      evidence: scan.spf.record ? [scan.spf.record] : reason?.message ? [reason.message] : [],
      fix: meets ? null : (reason?.recommendation ?? 'Publish one valid SPF record for the services that send for this domain.'),
    },
    requiredBy,
  );
}

function dmarcRecordCheck(scan: MailboxScanInput | null, domainName: string): MailboxCheck {
  const requiredBy = [required('google', 'bulk'), required('yahoo', 'bulk'), required('microsoft', 'bulk')];
  if (!scan) {
    return check(
      {
        code: 'dmarc_record',
        group: 'bulk',
        title: 'DMARC record published',
        status: 'not_measured',
        summary: 'No completed DNS scan yet. Run a scan from the DNS scans tab.',
        evidence: [],
        fix: 'Run a DNS scan from the DNS scans tab.',
      },
      requiredBy,
    );
  }

  if (scan.dmarc.status === 'found') {
    const testing = scan.dmarc.testing === true;
    return check(
      {
        code: 'dmarc_record',
        group: 'bulk',
        title: 'DMARC record published',
        status: 'meets',
        summary: `A DMARC record is published with p=${scan.dmarc.policy}${testing ? ', in testing mode (t=y)' : ''}.`,
        evidence: scan.dmarc.record ? [scan.dmarc.record] : [],
        fix: null,
      },
      requiredBy,
    );
  }

  const org = organizationalDomain(domainName);
  if (scan.dmarc.status === 'missing' && org && org !== domainName.trim().toLowerCase().replace(/\.+$/, '')) {
    return check(
      {
        code: 'dmarc_record',
        group: 'bulk',
        title: 'DMARC record published',
        status: 'unconfirmed',
        summary: `The parent domain’s record may apply. Scan ${org} to confirm.`,
        evidence: [],
        fix: `Run a DNS scan against ${org}.`,
      },
      requiredBy,
    );
  }

  if (scan.dmarc.status === 'missing') {
    return check(
      {
        code: 'dmarc_record',
        group: 'bulk',
        title: 'DMARC record published',
        status: 'fails',
        summary: 'No DMARC record was found for this organisational domain.',
        evidence: [],
        fix: 'Publish a DMARC record with p=none while you collect reports.',
      },
      requiredBy,
    );
  }

  const invalid = issueFor(scan, 'dmarc_invalid');
  return check(
    {
      code: 'dmarc_record',
      group: 'bulk',
      title: 'DMARC record published',
      status: 'fails',
      summary: invalid?.title ?? 'The DMARC record could not be read cleanly.',
      evidence: invalid?.message ? [invalid.message] : [],
      fix: invalid?.recommendation ?? 'Keep one valid DMARC TXT record at _dmarc.yourdomain.com.',
    },
    requiredBy,
  );
}

function dkimRecordCheck(
  scan: MailboxScanInput | null,
  counted: MailboxRecordInput[],
): MailboxCheck {
  const requiredBy = [required('google', 'bulk'), required('yahoo', 'bulk'), required('microsoft', 'bulk')];
  const revoked = new Set(scan?.dkim.revokedSelectors ?? []);
  const selectors = Object.keys(scan?.dkim.records ?? {}).filter((selector) => !revoked.has(selector));
  const reportPass = counted.some((record) => pass(record.dkimResult));
  const countedMessages = counted.reduce((total, record) => total + record.messageCount, 0);

  if (!scan) {
    if (reportPass) {
      return check(
        {
          code: 'dkim_record',
          group: 'bulk',
          title: 'DKIM key published',
          status: 'meets',
          summary: 'Aggregate reports show DKIM passing, even though no completed DNS scan is on record.',
          evidence: ['DKIM passed in aggregate reports from this domain.'],
          fix: null,
        },
        requiredBy,
      );
    }
    return check(
      {
        code: 'dkim_record',
        group: 'bulk',
        title: 'DKIM key published',
        status: 'not_measured',
        summary: 'No completed DNS scan yet. Run a scan from the DNS scans tab.',
        evidence: [],
        fix: 'Run a DNS scan from the DNS scans tab.',
      },
      requiredBy,
    );
  }

  if (selectors.length > 0) {
    return check(
      {
        code: 'dkim_record',
        group: 'bulk',
        title: 'DKIM key published',
        status: 'meets',
        summary: `The completed scan found a DKIM key at selector${selectors.length === 1 ? '' : 's'} ${selectors.join(', ')}.`,
        evidence: selectors.map((selector) => `Selector ${selector}.`),
        fix: null,
      },
      requiredBy,
    );
  }

  if (reportPass) {
    return check(
      {
        code: 'dkim_record',
        group: 'bulk',
        title: 'DKIM key published',
        status: 'meets',
        summary: 'Aggregate reports show DKIM passing for this domain, even though the scanner did not find a selector.',
        evidence: ['DKIM passed in aggregate reports from this domain.'],
        fix: null,
      },
      requiredBy,
    );
  }

  if (countedMessages >= senderBreakdownThresholds.minimumMessagesForSignal) {
    return check(
      {
        code: 'dkim_record',
        group: 'bulk',
        title: 'DKIM key published',
        status: 'fails',
        summary: `No DKIM key was found in DNS, and none of the ${countedMessages} counted messages passed DKIM.`,
        evidence: [],
        fix: 'Set up DKIM with your email provider and publish the selector’s public key.',
      },
      requiredBy,
    );
  }

  return check(
    {
      code: 'dkim_record',
      group: 'bulk',
      title: 'DKIM key published',
      status: 'unconfirmed',
      summary: 'No DKIM key was found in DNS, and there is too little report evidence to confirm one is in use.',
      evidence: [],
      fix: 'Check the custom selector with your email provider, then scan again.',
    },
    requiredBy,
  );
}

function dmarcReportingCheck(scan: MailboxScanInput | null): MailboxCheck {
  const requiredBy = [required('google', 'recommended'), required('yahoo', 'recommended')];
  if (!scan) {
    return check(
      {
        code: 'dmarc_reporting',
        group: 'recommended',
        title: 'DMARC aggregate reporting is configured',
        status: 'not_measured',
        summary: 'No completed DNS scan yet. Run a scan from the DNS scans tab.',
        evidence: [],
        fix: 'Run a DNS scan from the DNS scans tab.',
      },
      requiredBy,
    );
  }

  if (scan.dmarc.hasAggregateReports) {
    const webOnly =
      scan.dmarc.aggregateWebTargets.length > 0 && scan.dmarc.aggregateMailtoTargets.length === 0;
    const issue = webOnly ? issueFor(scan, 'dmarc_aggregate_reports_not_collected') : null;
    return check(
      {
        code: 'dmarc_reporting',
        group: 'recommended',
        title: 'DMARC aggregate reporting is configured',
        status: 'meets',
        summary: issue?.title ?? 'The DMARC record publishes an aggregate reporting address.',
        evidence: issue?.message ? [issue.message] : scan.dmarc.record ? [scan.dmarc.record] : [],
        fix: null,
      },
      requiredBy,
    );
  }

  const webOnly =
    scan.dmarc.aggregateWebTargets.length > 0 && scan.dmarc.aggregateMailtoTargets.length === 0;
  const issue = webOnly
    ? issueFor(scan, 'dmarc_aggregate_reports_not_collected')
    : issueFor(scan, 'dmarc_no_aggregate_reports');

  return check(
    {
      code: 'dmarc_reporting',
      group: 'recommended',
      title: 'DMARC aggregate reporting is configured',
      status: 'fails',
      summary: issue?.title ?? 'The DMARC record publishes no aggregate reporting address.',
      evidence: issue?.message ? [issue.message] : [],
      fix: issue?.recommendation ?? 'Add a rua=mailto: reporting address to the DMARC record.',
    },
    requiredBy,
  );
}

function notCheckable(input: {
  code: string;
  group: RequirementLevel;
  title: string;
  summary: string;
  fix: string;
  requiredBy: MailboxCheck['requiredBy'];
  whereToCheck?: MailboxCheck['whereToCheck'];
}): MailboxCheck {
  return check(
    {
      code: input.code,
      group: input.group,
      title: input.title,
      status: 'not_checkable',
      summary: input.summary,
      evidence: [],
      fix: input.fix,
    },
    input.requiredBy,
    null,
    input.whereToCheck ?? [],
  );
}

export function evaluateMailboxCompliance(input: MailboxComplianceInput): MailboxComplianceView {
  const now = input.now;
  const reports = input.reports.map((report) => ({ ...report, inWindow: reportInWindow(report, now) }));
  const inWindow = reports.filter((report) => report.inWindow);
  const counted: MailboxRecordInput[] = inWindow
    .flatMap((report) => report.records)
    .filter((record) => isCounted(record, input.reviewStatusBySender));

  const providers = (Object.keys(MAILBOX_PROVIDERS) as MailboxProviderId[]).map((provider) => {
    const definition = MAILBOX_PROVIDERS[provider];
    const providerReports = inWindow.filter((report) => report.provider === provider);
    const records = providerRecords(reports, provider, input.reviewStatusBySender);
    const messages = records.reduce((total, record) => total + record.messageCount, 0);

    const peakByDay = new Map<string, number>();
    for (const report of providerReports) {
      if (!report.dateRangeBegin || !report.dateRangeEnd) {
        continue;
      }
      const duration = report.dateRangeEnd.getTime() - report.dateRangeBegin.getTime();
      if (duration > mailboxDailyRangeHours * 60 * 60 * 1000) {
        continue;
      }
      const day = report.dateRangeBegin.toISOString().slice(0, 10);
      const dayMessages = report.records
        .filter((record) => isCounted(record, input.reviewStatusBySender))
        .reduce((total, record) => total + record.messageCount, 0);
      peakByDay.set(day, (peakByDay.get(day) ?? 0) + dayMessages);
    }

    let peakDailyMessages: number | null = null;
    let peakDay: string | null = null;
    for (const day of [...peakByDay.keys()].sort()) {
      const count = peakByDay.get(day)!;
      if (peakDailyMessages === null || count > peakDailyMessages) {
        peakDailyMessages = count;
        peakDay = day;
      }
    }

    const aboveBulkThreshold =
      definition.bulkThreshold === null || peakDailyMessages === null
        ? null
        : provider === 'google'
          ? peakDailyMessages > definition.bulkThreshold
          : peakDailyMessages >= definition.bulkThreshold;

    return {
      id: definition.id,
      name: definition.name,
      covers: definition.covers,
      bulkThreshold: definition.bulkThreshold,
      bulkThresholdRule: definition.bulkThresholdRule,
      reportCount: providerReports.length,
      messages,
      peakDailyMessages,
      peakDay,
      aboveBulkThreshold,
      lastReportAt:
        providerReports.length > 0
          ? new Date(
              Math.max(...providerReports.map((report) => report.receivedAt.getTime())),
            ).toISOString()
          : null,
      source: definition.source,
    };
  });

  const spfRecord = spfRecordCheck(input.scan?.result ?? null);
  const dmarcRecord = dmarcRecordCheck(input.scan?.result ?? null, input.domain.name);
  const dkimRecord = dkimRecordCheck(input.scan?.result ?? null, counted);
  const dkimKeyLength = dkimKeyLengthCheck(input.scan?.result ?? null);
  const dmarcReporting = dmarcReportingCheck(input.scan?.result ?? null);
  const reverseDns = reverseDnsCheck(counted, input.ipIntel, now);

  const noScan = input.scan === null;

  const spfMeets = spfRecord.status === 'meets';
  const dkimMeets = dkimRecord.status === 'meets';
  // Without a scan, DKIM can still be proved by the reports, and one proof is
  // all "SPF or DKIM" asks for.
  const spfOrDkim: MailboxCheck = noScan && !dkimMeets
    ? check(
        {
          code: 'spf_or_dkim',
          group: 'every_sender',
          title: 'SPF or DKIM is published',
          status: 'not_measured',
          summary: 'No completed DNS scan yet. Run a scan from the DNS scans tab.',
          evidence: [],
          fix: 'Run a DNS scan from the DNS scans tab.',
        },
        [required('google', 'every_sender'), required('yahoo', 'every_sender')],
      )
    : check(
        {
          code: 'spf_or_dkim',
          group: 'every_sender',
          title: 'SPF or DKIM is published',
          status:
            spfMeets || dkimMeets
              ? 'meets'
              : spfRecord.status === 'fails' && dkimRecord.status === 'fails'
                ? 'fails'
                : 'unconfirmed',
          summary:
            spfMeets && dkimMeets
              ? 'SPF and DKIM are both in place.'
              : spfMeets
                ? 'SPF is in place. DKIM is not confirmed, which is enough for this rule but not for the 5,000-a-day rules.'
                : dkimMeets
                  ? 'DKIM is in place. SPF is not confirmed, which is enough for this rule but not for the 5,000-a-day rules.'
                  : spfRecord.status === 'fails' && dkimRecord.status === 'fails'
                    ? 'Neither a working SPF record nor a DKIM key was found.'
                    : 'Neither SPF nor DKIM could be confirmed.',
          evidence: [...spfRecord.evidence, ...dkimRecord.evidence],
          fix:
            spfMeets || dkimMeets
              ? null
              : spfRecord.status === 'fails' && dkimRecord.status === 'fails'
                ? 'Publish one valid SPF record or set up DKIM with your email provider.'
                : 'Confirm the DKIM selector with your email provider, fix SPF if it is listed below, then scan again.',
        },
        [required('google', 'every_sender'), required('yahoo', 'every_sender')],
      );

  const dmarcPassing = providerCheck(
    'dmarc_passing',
    'DMARC passes for this provider',
    (record) => !passesDmarc(record),
    reports,
    input.reviewStatusBySender,
  );
  const dkimPassing = providerCheck(
    'dkim_passing',
    'DKIM passes for this provider',
    (record) => !pass(record.dkimResult),
    reports,
    input.reviewStatusBySender,
  );
  const spfPassing = providerCheck(
    'spf_passing',
    'SPF passes for this provider',
    (record) => !record.spfRawPass,
    reports,
    input.reviewStatusBySender,
  );

  const checks: MailboxCheck[] = [
    spfOrDkim,
    dkimKeyLength,
    reverseDns,
    notCheckable({
      code: 'tls',
      group: 'every_sender',
      title: 'TLS is used for transmission',
      summary: 'TLS delivery cannot be seen in DNS or DMARC reports.',
      fix: 'Read the TLS delivery figures in Google Postmaster Tools.',
      requiredBy: [required('google', 'every_sender')],
      whereToCheck: [{ label: 'Google Postmaster Tools', url: 'https://postmaster.google.com/' }],
    }),
    notCheckable({
      code: 'spam_rate',
      group: 'every_sender',
      title: 'Spam rate is below 0.3%',
      summary: 'Spam rates are computed by the mailbox providers, not by DMARC Harbor.',
      fix: 'Check Google Postmaster Tools and Yahoo Sender Hub for this domain’s spam rate.',
      requiredBy: [required('google', 'every_sender'), required('yahoo', 'every_sender')],
      whereToCheck: [
        { label: 'Google Postmaster Tools', url: 'https://postmaster.google.com/' },
        { label: 'Yahoo Sender Hub', url: 'https://senders.yahooinc.com/' },
      ],
    }),
    notCheckable({
      code: 'message_format',
      group: 'every_sender',
      title: 'Messages follow RFC 5322',
      summary: 'Message formatting cannot be seen in DNS or DMARC reports.',
      fix: 'Send a test message to a Gmail address and read “Show original” to inspect the headers.',
      requiredBy: [required('google', 'every_sender'), required('yahoo', 'every_sender')],
    }),
    spfRecord,
    dkimRecord,
    dmarcRecord,
    dmarcPassing,
    dkimPassing,
    spfPassing,
    notCheckable({
      code: 'one_click_unsubscribe',
      group: 'bulk',
      title: 'One-click unsubscribe is supported',
      summary: 'Unsubscribe headers cannot be seen in DNS or DMARC reports.',
      fix: 'For marketing and subscribed mail, publish List-Unsubscribe and List-Unsubscribe-Post: List-Unsubscribe=One-Click as described by RFC 8058.',
      requiredBy: [required('google', 'bulk'), required('yahoo', 'bulk')],
    }),
    dmarcReporting,
  ];

  // The no-scan rule is explicit for these checks; dkim_record is the one that
  // may still meet from report evidence and was handled above.
  const dnsNotMeasured = new Set(['dkim_key_length', 'spf_record', 'dmarc_record', 'dmarc_reporting']);
  if (noScan) {
    for (const item of checks) {
      if (dnsNotMeasured.has(item.code)) {
        item.status = 'not_measured';
        item.summary = 'No completed DNS scan yet. Run a scan from the DNS scans tab.';
        item.fix = 'Run a DNS scan from the DNS scans tab.';
      }
    }
  }

  const counts = {
    meets: checks.filter((item) => item.status === 'meets').length,
    fails: checks.filter((item) => item.status === 'fails').length,
    unconfirmed: checks.filter((item) => item.status === 'unconfirmed').length,
    notMeasured: checks.filter((item) => item.status === 'not_measured').length,
    notCheckable: checks.filter((item) => item.status === 'not_checkable').length,
  };

  return {
    domain: input.domain,
    generatedAt: now.toISOString(),
    windowDays: 30,
    thresholds: {
      minimumMessagesForSignal: senderBreakdownThresholds.minimumMessagesForSignal,
      maximumFailureSharePercent: senderBreakdownThresholds.maximumFailureSharePercent,
    },
    scan: input.scan ? { id: input.scan.id, completedAt: input.scan.completedAt } : null,
    rowsTruncated: input.rowsTruncated,
    providers,
    checks,
    counts,
  };
}
