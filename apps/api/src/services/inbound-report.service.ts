import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { simpleParser } from 'mailparser';
import { containsForensicParts, parseForensicReport, ForensicReportParseError } from './forensic-report-parser.service.js';
import { ingestForensicReportByReportedDomain } from './forensic-report.service.js';
import { ingestDmarcReportByPolicyDomain } from './report.service.js';

const decompress = promisify(gunzip);

export type InboundReportStatus = 'created' | 'duplicate' | 'rejected' | 'failed' | 'ignored';
export type InboundReportKind = 'aggregate' | 'forensic';

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

function isReportAttachment(filename: string | undefined, contentType: string | undefined): boolean {
  const name = filename?.toLowerCase() ?? '';
  const type = contentType?.toLowerCase() ?? '';
  return name.endsWith('.xml') || name.endsWith('.xml.gz') || type.includes('xml') || type.includes('gzip');
}

async function attachmentXml(content: Buffer, filename: string | undefined, contentType: string | undefined): Promise<string> {
  const name = filename?.toLowerCase() ?? '';
  const type = contentType?.toLowerCase() ?? '';
  if (name.endsWith('.gz') || type.includes('gzip') || type.includes('compressed')) {
    const decompressed = await decompress(content);
    return decompressed.toString('utf8');
  }

  return content.toString('utf8');
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
  const candidates: string[] = [];

  for (const attachment of parsedEmail.attachments.slice(0, 20)) {
    if (!isReportAttachment(attachment.filename, attachment.contentType)) {
      continue;
    }

    try {
      candidates.push(await attachmentXml(attachment.content, attachment.filename, attachment.contentType));
    } catch {
      candidates.push('');
    }
  }

  const body = parsedEmail.text?.trim() ?? '';
  if (!candidates.length && body.startsWith('<')) {
    candidates.push(body);
  }

  const results: InboundReportResult[] = [];
  for (const xml of candidates) {
    if (!xml) {
      results.push({ kind: 'aggregate', status: 'failed', message: 'The report attachment could not be decoded.' });
      continue;
    }

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

export async function processInboundDmarcEmail(rawEmail: string): Promise<InboundEmailResult> {
  if (containsForensicParts(rawEmail)) {
    return processForensicEmail(rawEmail);
  }

  return processAggregateEmail(rawEmail);
}
