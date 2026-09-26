import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { simpleParser } from 'mailparser';
import { ingestDmarcReportByPolicyDomain } from './report.service.js';

const decompress = promisify(gunzip);

export type InboundReportStatus = 'created' | 'duplicate' | 'rejected' | 'failed' | 'ignored';

export interface InboundReportResult {
  status: InboundReportStatus;
  reportId?: string;
  reportDomain?: string;
  message?: string;
}

export interface InboundEmailResult {
  candidateCount: number;
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

export async function processInboundDmarcEmail(rawEmail: string): Promise<InboundEmailResult> {
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
      results.push({ status: 'failed', message: 'The report attachment could not be decoded.' });
      continue;
    }

    try {
      const outcome = await ingestDmarcReportByPolicyDomain(xml);
      if (outcome.status === 'created') {
        results.push({ status: 'created', reportId: outcome.report.id, reportDomain: outcome.report.policyDomain ?? undefined });
      } else if (outcome.status === 'duplicate') {
        results.push({ status: 'duplicate', reportId: outcome.report.id, reportDomain: outcome.report.policyDomain ?? undefined });
      } else if (outcome.status === 'domain_not_found' || outcome.status === 'ambiguous_domain') {
        results.push({ status: 'rejected', reportDomain: outcome.reportDomain, message: `No unique verified workspace domain matched ${outcome.reportDomain}.` });
      } else if (outcome.status === 'not_verified') {
        results.push({ status: 'rejected', message: 'The matched domain is not verified.' });
      } else if (outcome.status === 'domain_mismatch') {
        results.push({ status: 'rejected', reportDomain: outcome.reportDomain, message: 'The report domain did not match the selected domain.' });
      } else {
        results.push({ status: 'rejected', message: 'The report could not be matched to a workspace domain.' });
      }
    } catch (error) {
      results.push({
        status: 'failed',
        message: error instanceof Error ? error.message : 'The report could not be processed.',
      });
    }
  }

  return {
    candidateCount: candidates.length,
    results,
  };
}
