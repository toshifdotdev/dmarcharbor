import { systemDnsReader } from './dns.js';
import { readDmarcRecord } from './dmarc-tags.js';
import { normalizeDomain } from './domain.js';
import { budgetDkimCandidates, dkimCandidates } from './dkim-discovery.js';
import { calculateScore } from '../services/score.service.js';
import type {
  DkimResult,
  DmarcPolicy,
  DmarcResult,
  DnsReader,
  MxResult,
  ScanIssue,
  ScanResult,
  ScanStatus,
  SpfResult,
} from './types.js';

function joinRecords(records: string[][]): string[] {
  return records.map((chunks) => chunks.join('').trim()).filter(Boolean);
}

function parseTags(record: string): Record<string, string> {
  return readDmarcRecord(record).tags;
}

function policyFromTags(tags: Record<string, string>): DmarcPolicy {
  const policy = tags.p?.toLowerCase();
  return policy === 'none' || policy === 'quarantine' || policy === 'reject' ? policy : 'unknown';
}

export function parseDmarcRecords(records: string[][]): DmarcResult {
  const rawRecords = joinRecords(records);

  if (rawRecords.length === 0) {
    return {
      status: 'missing',
      policy: 'unknown',
      tags: {},
      hasAggregateReports: false,
      hasForensicReports: false,
    };
  }

  const record = rawRecords[0];
  const tags = parseTags(record);
  const policy = policyFromTags(tags);

  if (rawRecords.length > 1 || tags.v?.toLowerCase() !== 'dmarc1' || policy === 'unknown') {
    return {
      status: 'error',
      record,
      policy,
      tags,
      hasAggregateReports: readDmarcRecord(record).aggregateTargets.length > 0,
      hasForensicReports: readDmarcRecord(record).forensicTargets.length > 0,
    };
  }

  return {
    status: 'found',
    record,
    policy,
    tags,
    hasAggregateReports: readDmarcRecord(record).aggregateTargets.length > 0,
    hasForensicReports: readDmarcRecord(record).forensicTargets.length > 0,
  };
}

function countSpfLookups(record: string): number {
  const mechanisms = record.trim().split(/\s+/).slice(1);
  return mechanisms.filter((mechanism) =>
    /^(include:|a$|mx$|ptr$|exists:|redirect=)/i.test(mechanism),
  ).length;
}

export function parseSpfRecords(records: string[][]): SpfResult {
  const rawRecords = joinRecords(records);
  const spfRecords = rawRecords.filter((record) => /^v=spf1(?:\s|$)/i.test(record));

  if (spfRecords.length === 0) {
    return { status: 'missing', valid: false, lookupCount: 0 };
  }

  if (spfRecords.length > 1) {
    return { status: 'error', record: spfRecords.join(' | '), valid: false, lookupCount: 0 };
  }

  const record = spfRecords[0];
  return {
    status: 'found',
    record,
    valid: true,
    lookupCount: countSpfLookups(record),
  };
}

/**
 * Probes for DKIM keys, using the SPF record to decide which labels are worth
 * trying rather than guessing a fixed dozen.
 *
 * The SPF record is passed in rather than re-fetched, because the caller already
 * has it and a second lookup for the same name would be pure waste.
 */
async function scanDkim(domain: string, spf: SpfResult, reader: DnsReader): Promise<DkimResult> {
  const { selected, skipped } = budgetDkimCandidates(dkimCandidates(spf.record));
  const discoveredVia: Record<string, string> = {};

  for (const candidate of selected) {
    discoveredVia[candidate.selector] = candidate.source;
  }

  const lookups = await Promise.all(
    selected.map(async ({ selector }) => {
      const result = await reader.resolveTxt(`_domainkey.${selector}.${domain}`);
      return { selector, result };
    }),
  );

  const records: Record<string, string> = {};
  let hadError = false;

  for (const { selector, result } of lookups) {
    if (result.status === 'found' && result.value) {
      const value = joinRecords(result.value)[0];
      if (value) {
        records[selector] = value;
      }
    }
    if (result.status === 'error') {
      hadError = true;
    }
  }

  const selectors = Object.keys(records);
  const skippedSelectors = skipped.map((candidate) => candidate.selector);

  if (selectors.length > 0) {
    return {
      status: 'found',
      selectors,
      checkedSelectors: selected.map((candidate) => candidate.selector),
      records,
      discoveredVia,
      ...(skippedSelectors.length > 0 ? { skippedSelectors } : {}),
    };
  }

  // Nothing found. Only reported as an error when every lookup actually failed,
  // because a scan that ran and found nothing is a different, and more useful,
  // answer than a scan that could not run.
  return {
    status: hadError && selected.length > 0 ? 'error' : 'missing',
    selectors: [],
    checkedSelectors: selected.map((candidate) => candidate.selector),
    records,
    discoveredVia,
    ...(skippedSelectors.length > 0 ? { skippedSelectors } : {}),
    error: hadError ? 'One or more DKIM lookups failed.' : undefined,
  };
}

function addIssue(issues: ScanIssue[], issue: ScanIssue): void {
  issues.push(issue);
}

function buildIssues(dmarc: DmarcResult, spf: SpfResult, dkim: DkimResult, mx: MxResult): ScanIssue[] {
  const issues: ScanIssue[] = [];

  if (dmarc.status === 'missing') {
    addIssue(issues, {
      severity: 'error',
      code: 'dmarc_missing',
      title: 'DMARC record missing',
      message: 'Receiving servers do not have your domain policy for failed authentication.',
      recommendation: 'Publish a DMARC record with p=none while you collect reports.',
    });
  } else if (dmarc.status === 'error') {
    addIssue(issues, {
      severity: 'error',
      code: 'dmarc_invalid',
      title: 'DMARC record needs review',
      message: 'The record is missing, duplicated, or contains an invalid version or policy.',
      recommendation: 'Keep one valid DMARC TXT record at _dmarc.yourdomain.com.',
    });
  } else {
    if (dmarc.policy === 'none') {
      addIssue(issues, {
        severity: 'warning',
        code: 'dmarc_monitor_only',
        title: 'DMARC is monitoring only',
        message: 'The policy observes failures but does not ask receivers to quarantine or reject them.',
        recommendation: 'Review all legitimate senders before moving to quarantine or reject.',
      });
    }
    if (!dmarc.hasAggregateReports) {
      addIssue(issues, {
        severity: 'warning',
        code: 'dmarc_no_aggregate_reports',
        title: 'Aggregate reporting is not configured',
        message: 'You will not receive a regular summary of sources trying to send as your domain.',
        recommendation: 'Add a rua=mailto: reporting address after choosing a report destination.',
      });
    }
  }

  if (spf.status === 'missing') {
    addIssue(issues, {
      severity: 'error',
      code: 'spf_missing',
      title: 'SPF record missing',
      message: 'The domain does not publish a list of authorized sending servers.',
      recommendation: 'Review the services that send email and publish one SPF record.',
    });
  } else if (spf.status === 'error') {
    addIssue(issues, {
      severity: 'error',
      code: 'spf_invalid',
      title: 'SPF record needs review',
      message: 'More than one SPF record was found or the record could not be read cleanly.',
      recommendation: 'Keep one SPF record and remove duplicate or conflicting entries.',
    });
  } else if (spf.lookupCount > 10) {
    addIssue(issues, {
      severity: 'warning',
      code: 'spf_lookup_limit',
      title: 'SPF uses many DNS lookups',
      message: `The record appears to use ${spf.lookupCount} mechanisms that can trigger the 10-lookup limit.`,
      recommendation: 'Flatten unused includes carefully or remove unused sending services.',
    });
  }

  if (dkim.status === 'missing') {
    addIssue(issues, {
      severity: 'warning',
      code: 'dkim_missing',
      title: 'No DKIM key found',
      message: `No DKIM public key was found at any of the ${dkim.checkedSelectors.length} selectors checked, derived from the SPF record and standard provider conventions. A custom selector not named in SPF would not appear here.`,
      recommendation: 'Confirm each email provider has a DKIM selector and public key in DNS.',
    });
  } else if (dkim.status === 'error') {
    addIssue(issues, {
      severity: 'warning',
      code: 'dkim_lookup_error',
      title: 'Some DKIM lookups failed',
      message: 'The scan could not complete every common DKIM selector check.',
      recommendation: 'Check the provider-specific selector directly before changing DNS.',
    });
  }

  if (mx.status === 'missing') {
    addIssue(issues, {
      severity: 'warning',
      code: 'mx_missing',
      title: 'No MX records found',
      message: 'The domain does not advertise a mail exchanger in this scan.',
      recommendation: 'Confirm whether the domain is intentionally used only for sending.',
    });
  }

  return issues;
}

function calculateStatus(dmarc: DmarcResult, spf: SpfResult, dkim: DkimResult, issues: ScanIssue[]): ScanStatus {
  if (dmarc.status === 'missing' && spf.status === 'missing' && dkim.status === 'missing') {
    return 'missing';
  }

  if (issues.some((issue) => issue.severity === 'error')) {
    return 'needs_attention';
  }

  if (issues.length === 0) {
    return 'healthy';
  }

  return 'needs_attention';
}

function errorResult(domain: string, message: string): ScanResult {
  const emptyDmarc: DmarcResult = {
    status: 'error',
    policy: 'unknown',
    tags: {},
    hasAggregateReports: false,
    hasForensicReports: false,
    error: message,
  };
  const emptySpf: SpfResult = { status: 'error', valid: false, lookupCount: 0, error: message };
  const emptyDkim: DkimResult = {
    status: 'error',
    selectors: [],
    checkedSelectors: [],
    records: {},
    error: message,
  };
  const emptyMx: MxResult = { status: 'error', records: [], error: message };

  return {
    domain,
    scannedAt: new Date().toISOString(),
    status: 'error',
    score: 0,
    scoreBreakdown: { base: 100, final: 0, factors: [] },
    dmarc: emptyDmarc,
    spf: emptySpf,
    dkim: emptyDkim,
    mx: emptyMx,
    issues: [
      {
        severity: 'error',
        code: 'scan_failed',
        title: 'Scan could not be completed',
        message,
      },
    ],
    recommendations: ['Try again later or verify the domain and DNS configuration.'],
  };
}

export async function scanDomain(input: string, reader: DnsReader = systemDnsReader): Promise<ScanResult> {
  const domain = normalizeDomain(input);

  try {
    const [dmarcLookup, spfLookup, mxLookup] = await Promise.all([
      reader.resolveTxt(`_dmarc.${domain}`),
      reader.resolveTxt(domain),
      reader.resolveMx(domain),
    ]);

    const dmarc = parseDmarcRecords(dmarcLookup.value ?? []);
    const spf = parseSpfRecords(spfLookup.value ?? []);
    const dkim = await scanDkim(domain, spf, reader);
    const mx: MxResult = mxLookup.status === 'found'
      ? { status: 'found', records: mxLookup.value ?? [] }
      : { status: mxLookup.status, records: [], error: mxLookup.error };

    const issues = buildIssues(dmarc, spf, dkim, mx);
    const scoreBreakdown = calculateScore(dmarc, spf, dkim, mx);
    return {
      domain,
      scannedAt: new Date().toISOString(),
      status: calculateStatus(dmarc, spf, dkim, issues),
      score: scoreBreakdown.final,
      scoreBreakdown,
      dmarc,
      spf,
      dkim,
      mx,
      issues,
      recommendations: issues.flatMap((issue) => (issue.recommendation ? [issue.recommendation] : [])),
    };
  } catch (error) {
    return errorResult(domain, error instanceof Error ? error.message : 'The scan failed unexpectedly.');
  }
}

