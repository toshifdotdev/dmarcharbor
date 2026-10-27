import { simpleParser } from 'mailparser';
import { containsForensicParts, parseForensicReport, ForensicReportParseError } from './forensic-report-parser.service.js';
import { ingestForensicReportByReportedDomain } from './forensic-report.service.js';
import { ingestDmarcReportByPolicyDomain } from './report.service.js';
import { looksLikeReportAttachment, ReportArchiveError, reportXmlFromAttachment } from './report/report-archive.js';
import { looksLikeTlsReportEmail } from './tls-report/detect.js';
import { tlsReportJsonFromAttachment } from './tls-report/attachment.js';
import { ingestTlsReportByPolicyDomain } from './tls-report/tls-report.service.js';

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

async function processForensicEmail(rawEmail: string): Promise<InboundEmailResult> {
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
    const outcome = await ingestForensicReportByReportedDomain(rawEmail);
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

async function processAggregateEmail(rawEmail: string): Promise<InboundEmailResult> {
  const parsedEmail = await simpleParser(rawEmail);
  // Each candidate is either XML to ingest or the reason an attachment could
  // not be read, which is reported per attachment rather than dropped.
  const candidates: Array<{ xml: string } | { failure: string }> = [];

  for (const attachment of parsedEmail.attachments.slice(0, 20)) {
    if (!looksLikeReportAttachment(attachment.filename, attachment.contentType, attachment.content)) {
      continue;
    }

    try {
      for (const xml of await reportXmlFromAttachment(attachment.content)) {
        candidates.push({ xml });
      }
    } catch (error) {
      candidates.push({
        failure:
          error instanceof ReportArchiveError
            ? `${attachment.filename ?? 'The attachment'}: ${error.message}`
            : 'The report attachment could not be decoded.',
      });
    }
  }

  const body = parsedEmail.text?.trim() ?? '';
  if (!candidates.length && body.startsWith('<')) {
    candidates.push({ xml: body });
  }

  const results: InboundReportResult[] = [];
  for (const candidate of candidates) {
    if ('failure' in candidate) {
      results.push({ kind: 'aggregate', status: 'failed', message: candidate.failure });
      continue;
    }
    const xml = candidate.xml;

    try {
      const outcome = await ingestDmarcReportByPolicyDomain(xml);
      if (outcome.status === 'created' || outcome.status === 'duplicate') {
        results.push({
          kind: 'aggregate',
          status: outcome.status,
          reportId: outcome.report.id,
          reportDomain: outcome.report.policyDomain ?? undefined,
        });
      } else if (outcome.status === 'domain_not_found' || outcome.status === 'ambiguous_domain') {
        results.push({
          kind: 'aggregate',
          status: 'rejected',
          reportDomain: outcome.reportDomain,
          message: `No unique verified workspace domain matched ${outcome.reportDomain}.`,
        });
      } else if (outcome.status === 'not_verified') {
        results.push({ kind: 'aggregate', status: 'rejected', message: 'The matched domain is not verified.' });
      } else if (outcome.status === 'domain_mismatch') {
        results.push({
          kind: 'aggregate',
          status: 'rejected',
          reportDomain: outcome.reportDomain,
          message: 'The report domain did not match the selected domain.',
        });
      } else {
        results.push({ kind: 'aggregate', status: 'rejected', message: 'The report could not be matched to a workspace domain.' });
      }
    } catch (error) {
      results.push({
        kind: 'aggregate',
        status: 'failed',
        message: error instanceof Error ? error.message : 'The report could not be processed.',
      });
    }
  }

  return {
    candidateCount: candidates.length,
    kind: 'aggregate',
    results,
  };
}

async function processTlsReportEmail(rawEmail: string): Promise<InboundEmailResult> {
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
  const decode = async (attachment: (typeof attachments)[number]): Promise<void> => {
    try {
      candidates.push({ json: await tlsReportJsonFromAttachment(attachment.content) });
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
      await decode(attachment);
    }
  } else {
    // Nothing named itself a TLS report. Try every attachment by its bytes, but
    // only keep the ones that actually decode.
    for (const attachment of attachments) {
      try {
        candidates.push({ json: await tlsReportJsonFromAttachment(attachment.content) });
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
      const outcome = await ingestTlsReportByPolicyDomain(candidate.json);
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

export async function processInboundDmarcEmail(rawEmail: string): Promise<InboundEmailResult> {
  if (looksLikeTlsReportEmail(rawEmail)) {
    const tls = await processTlsReportEmail(rawEmail);
    // The detector reads marker strings anywhere in the message, so a DMARC
    // report that merely quotes one (an ARF report carrying the headers of a
    // TLS-RPT message, say) would otherwise be dropped with nothing ingested.
    // Only a message that actually held a TLS report stops here.
    if (tls.candidateCount > 0) {
      return tls;
    }
  }
  if (containsForensicParts(rawEmail)) {
    return processForensicEmail(rawEmail);
  }

  return processAggregateEmail(rawEmail);
}
