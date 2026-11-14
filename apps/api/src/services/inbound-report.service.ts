import { simpleParser } from 'mailparser';
import { containsForensicParts, parseForensicReport, ForensicReportParseError } from './forensic-report-parser.service.js';
import { ingestForensicReportByReportedDomain } from './forensic-report.service.js';
import { ingestDmarcReportByPolicyDomain } from './report.service.js';
import {
  looksLikeReportAttachment,
  newDecodeBudget,
  ReportArchiveError,
  reportXmlFromAttachment,
  spendBudget,
} from './report/report-archive.js';
import { looksLikeTlsReportEmail } from './tls-report/detect.js';
import { tlsReportJsonFromAttachment } from './tls-report/attachment.js';
import { ingestTlsReportByPolicyDomain } from './tls-report/tls-report.service.js';

/** Limits a mailed report to the domains of one workspace. */
export type IngestScope = { organizationId: string };

export type InboundReportStatus = 'created' | 'duplicate' | 'rejected' | 'failed' | 'ignored';
export type InboundReportKind = 'aggregate' | 'forensic' | 'tlsrpt';

export interface InboundReportResult {
  kind: InboundReportKind;
  status: InboundReportStatus;
  reportId?: string;
  reportDomain?: string;
  message?: string;
}

export interface InboundEmailResult {
  candidateCount: number;
  kind: InboundReportKind;
  results: InboundReportResult[];
}

function describeForensicOutcome(
  outcome: Awaited<ReturnType<typeof ingestForensicReportByReportedDomain>>,
): InboundReportResult {
  if (outcome.status === 'created' || outcome.status === 'duplicate') {
    return {
      kind: 'forensic',
      status: outcome.status,
      reportId: outcome.forensic.id,
      reportDomain: outcome.forensic.reportedDomain,
    };
  }

  if (outcome.status === 'forensics_not_enabled') {
    return {
      kind: 'forensic',
      status: 'rejected',
      message: 'Forensic report collection is disabled for the matched domain.',
    };
  }

  if (outcome.status === 'ruf_not_configured') {
    return {
      kind: 'forensic',
      status: 'rejected',
      message: 'The matched domain does not publish a ruf= reporting address.',
    };
  }

  if (outcome.status === 'not_verified') {
    return { kind: 'forensic', status: 'rejected', message: 'The matched domain is not verified.' };
  }

  if (outcome.status === 'domain_mismatch') {
    return {
      kind: 'forensic',
      status: 'rejected',
      reportDomain: outcome.reportedDomain,
      message: 'The report domain did not match the selected domain.',
    };
  }

  if (outcome.status === 'domain_not_found' || outcome.status === 'ambiguous_domain') {
    return {
      kind: 'forensic',
      status: 'rejected',
      reportDomain: outcome.reportedDomain,
      message: `No unique verified workspace domain matched ${outcome.reportedDomain}.`,
    };
  }

  return { kind: 'forensic', status: 'rejected', message: 'The report could not be matched to a workspace domain.' };
}

async function processForensicEmail(rawEmail: string, scope?: IngestScope): Promise<InboundEmailResult> {
  let reportedDomain: string | undefined;

  try {
    reportedDomain = parseForensicReport(rawEmail).reportedDomain;
  } catch (error) {
    if (error instanceof ForensicReportParseError) {
      return {
        candidateCount: 1,
        kind: 'forensic',
        results: [{ kind: 'forensic', status: 'failed', message: error.message }],
      };
    }

    throw error;
  }

  try {
    const outcome = await ingestForensicReportByReportedDomain(rawEmail, scope);
    return { candidateCount: 1, kind: 'forensic', results: [describeForensicOutcome(outcome)] };
  } catch (error) {
    return {
      candidateCount: 1,
      kind: 'forensic',
      results: [
        {
          kind: 'forensic',
          status: 'failed',
          reportDomain: reportedDomain,
          message: error instanceof Error ? error.message : 'The forensic report could not be processed.',
        },
      ],
    };
  }
}

async function processAggregateEmail(rawEmail: string, scope?: IngestScope): Promise<InboundEmailResult> {
  const parsedEmail = await simpleParser(rawEmail);
  const results: InboundReportResult[] = [];
  let candidateCount = 0;
  // One allowance for the whole message: every attachment and every file in
  // them draws on it (report-archive.ts, maxDecodedBytesPerEmail).
  const budget = newDecodeBudget();

  /**
   * Each report is ingested as soon as it is decoded and then let go.
   *
   * All of them used to be decoded first and held in a list, so the memory a
   * message could take was every report in it at once rather than the largest
   * one. A failure is reported per attachment rather than dropped.
   */
  for (const attachment of parsedEmail.attachments.slice(0, 20)) {
    if (!looksLikeReportAttachment(attachment.filename, attachment.contentType, attachment.content)) {
      continue;
    }

    let decoded: string[];
    try {
      decoded = await reportXmlFromAttachment(attachment.content, budget);
    } catch (error) {
      candidateCount += 1;
      results.push({
        kind: 'aggregate',
        status: 'failed',
        message:
          error instanceof ReportArchiveError
            ? `${attachment.filename ?? 'The attachment'}: ${error.message}`
            : 'The report attachment could not be decoded.',
      });
      if (budget.remaining === 0) {
        break;
      }
      continue;
    }

    while (decoded.length > 0) {
      const xml = decoded.shift() as string;
      candidateCount += 1;
      results.push(await ingestAggregateCandidate(xml, scope));
    }
  }

  const body = parsedEmail.text?.trim() ?? '';
  if (candidateCount === 0 && body.startsWith('<')) {
    candidateCount += 1;
    results.push(await ingestAggregateCandidate(body, scope));
  }

  return { candidateCount, kind: 'aggregate', results };
}

/** One decoded aggregate report, ingested and described. */
async function ingestAggregateCandidate(xml: string, scope?: IngestScope): Promise<InboundReportResult> {
  try {
    const outcome = await ingestDmarcReportByPolicyDomain(xml, scope);
    if (outcome.status === 'created' || outcome.status === 'duplicate') {
      return {
        kind: 'aggregate',
        status: outcome.status,
        reportId: outcome.report.id,
        reportDomain: outcome.report.policyDomain ?? undefined,
      };
    }
    if (outcome.status === 'domain_not_found' || outcome.status === 'ambiguous_domain') {
      return {
        kind: 'aggregate',
        status: 'rejected',
        reportDomain: outcome.reportDomain,
        message: `No unique verified workspace domain matched ${outcome.reportDomain}.`,
      };
    }
    if (outcome.status === 'not_verified') {
      return { kind: 'aggregate', status: 'rejected', message: 'The matched domain is not verified.' };
    }
    if (outcome.status === 'domain_mismatch') {
      return {
        kind: 'aggregate',
        status: 'rejected',
        reportDomain: outcome.reportDomain,
        message: 'The report domain did not match the selected domain.',
      };
    }
    return { kind: 'aggregate', status: 'rejected', message: 'The report could not be matched to a workspace domain.' };
  } catch (error) {
    return {
      kind: 'aggregate',
      status: 'failed',
      message: error instanceof Error ? error.message : 'The report could not be processed.',
    };
  }
}

async function processTlsReportEmail(rawEmail: string, scope?: IngestScope): Promise<InboundEmailResult> {
  const parsedEmail = await simpleParser(rawEmail);
  const attachments = parsedEmail.attachments;
  const qualified = attachments
    .filter((attachment) => {
      const type = (attachment.contentType ?? '').toLowerCase();
      const name = (attachment.filename ?? '').toLowerCase();
      return type.startsWith('application/tlsrpt') || name.endsWith('.json') || name.endsWith('.json.gz');
    })
    .slice(0, 20);

  const candidates: Array<{ json: string } | { failure: string }> = [];
  // The same per-message allowance the aggregate path has. The fallback below
  // used to read every attachment with no count limit, so 700 tiny gzips that
  // each inflate to a few megabytes of spaces fitted in one 5 MB message.
  const budget = newDecodeBudget();
  const decode = async (attachment: (typeof attachments)[number]): Promise<void> => {
    try {
      const json = await tlsReportJsonFromAttachment(attachment.content);
      spendBudget(budget, json.length);
      candidates.push({ json });
    } catch (error) {
      candidates.push({
        failure:
          error instanceof ReportArchiveError
            ? `${attachment.filename ?? 'The attachment'}: ${error.message}`
            : 'The TLS report attachment could not be decoded.',
      });
    }
  };

  if (qualified.length > 0) {
    for (const attachment of qualified) {
      if (budget.remaining === 0) break;
      await decode(attachment);
    }
  } else {
    // Nothing named itself a TLS report. Try the first attachments by their
    // bytes, but only keep the ones that actually decode.
    for (const attachment of attachments.slice(0, 20)) {
      if (budget.remaining === 0) break;
      try {
        const json = await tlsReportJsonFromAttachment(attachment.content);
        spendBudget(budget, json.length);
        candidates.push({ json });
      } catch {
        // Not a TLS report; the aggregate branch will consider it normally.
      }
    }
  }

  const results: InboundReportResult[] = [];
  for (const candidate of candidates) {
    if ('failure' in candidate) {
      results.push({ kind: 'tlsrpt', status: 'failed', message: candidate.failure });
      continue;
    }

    try {
      const outcome = await ingestTlsReportByPolicyDomain(candidate.json, scope);
      if (outcome.status === 'created' || outcome.status === 'duplicate') {
        results.push({
          kind: 'tlsrpt',
          status: outcome.status,
          reportId: outcome.report.id,
          reportDomain: outcome.report.policyDomain,
        });
      } else if (outcome.status === 'domain_not_found' || outcome.status === 'ambiguous_domain') {
        results.push({
          kind: 'tlsrpt',
          status: 'rejected',
          reportDomain: outcome.reportDomain,
          message: `No unique verified workspace domain matched ${outcome.reportDomain}.`,
        });
      } else if (outcome.status === 'not_verified') {
        results.push({ kind: 'tlsrpt', status: 'rejected', message: 'The matched domain is not verified.' });
      } else if (outcome.status === 'domain_mismatch') {
        results.push({
          kind: 'tlsrpt',
          status: 'rejected',
          reportDomain: outcome.reportDomain,
          message: 'The report domain did not match the selected domain.',
        });
      } else {
        results.push({
          kind: 'tlsrpt',
          status: 'rejected',
          message: 'The report could not be matched to a workspace domain.',
        });
      }
    } catch (error) {
      results.push({
        kind: 'tlsrpt',
        status: 'failed',
        message: error instanceof Error ? error.message : 'The TLS report could not be processed.',
      });
    }
  }

  return { candidateCount: candidates.length, kind: 'tlsrpt', results };
}

/**
 * One mailed report, routed to the verified domain it names.
 *
 * Unscoped for our own report addresses (the inbound webhook and the platform
 * mailbox), which serve every workspace. Scoped to one workspace for a mailbox
 * that workspace connected itself, so it can only write to its own domains.
 */
export async function processInboundDmarcEmail(rawEmail: string, scope?: IngestScope): Promise<InboundEmailResult> {
  if (looksLikeTlsReportEmail(rawEmail)) {
    const tls = await processTlsReportEmail(rawEmail, scope);
    // The detector reads marker strings anywhere in the message, so a DMARC
    // report that merely quotes one (an ARF report carrying the headers of a
    // TLS-RPT message, say) would otherwise be dropped with nothing ingested.
    // Only a message that actually held a TLS report stops here.
    if (tls.candidateCount > 0) {
      return tls;
    }
  }
  // The forensic reader refuses a message over its own limit by throwing. That
  // is a reason not to read it as a failure report, not a reason to drop it:
  // an aggregate report mail can be larger, and it has its own limits.
  let forensic: boolean;
  try {
    forensic = containsForensicParts(rawEmail);
  } catch {
    forensic = false;
  }
  if (forensic) {
    return processForensicEmail(rawEmail, scope);
  }

  return processAggregateEmail(rawEmail, scope);
}
