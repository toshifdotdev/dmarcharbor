import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { normalizeDomain } from '../scanner/domain.js';

export type ParsedAuthType = 'DKIM' | 'SPF';

export interface ParsedAuthResult {
  type: ParsedAuthType;
  domain?: string;
  selector?: string;
  scope?: string;
  result: string;
}

export interface ParsedReportRecord {
  sourceIp: string;
  messageCount: number;
  disposition?: string;
  dkimResult?: string;
  spfResult?: string;
  headerFrom?: string;
  envelopeFrom?: string;
  policyReason?: string;
  authResults: ParsedAuthResult[];
}

export interface ParsedDmarcReport {
  reportType: 'AGGREGATE';
  fingerprint: string;
  reportId?: string;
  reportingOrganization?: string;
  reportingEmail?: string;
  extraContactInfo?: string;
  dateRangeBegin?: Date;
  dateRangeEnd?: Date;
  policyDomain: string;
  policyAdkim?: string;
  policyAspf?: string;
  policyP?: string;
  policySp?: string;
  policyFraction?: number;
  reportError?: string;
  records: ParsedReportRecord[];
}

type XmlRecord = Record<string, unknown>;

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: false,
  isArray: (tagName) => ['record', 'dkim', 'spf', 'reason'].includes(tagName),
});

export class DmarcReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DmarcReportParseError';
  }
}

function asRecord(value: unknown): XmlRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as XmlRecord;
}

function asArray(value: unknown): XmlRecord[] {
  if (Array.isArray(value)) {
    return value.map((item) => asRecord(item)).filter((item): item is XmlRecord => item !== undefined);
  }

  const record = asRecord(value);
  return record ? [record] : [];
}

function text(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = text(item);
      if (result) {
        return result;
      }
    }
    return undefined;
  }

  if (typeof value === 'string') {
    const result = value.trim();
    return result || undefined;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  const record = asRecord(value);
  const textValue = record?.['#text'];
  return typeof textValue === 'string' && textValue.trim() ? textValue.trim() : undefined;
}

function requiredText(value: unknown, fieldName: string): string {
  const result = text(value);
  if (!result) {
    throw new DmarcReportParseError(`The report is missing ${fieldName}.`);
  }
  return result;
}

function optionalDate(value: unknown, fieldName: string): Date | undefined {
  const raw = text(value);
  if (!raw) {
    return undefined;
  }

  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) {
    throw new DmarcReportParseError(`The report has an invalid ${fieldName}.`);
  }

  return new Date(seconds * 1000);
}

function requiredNumber(value: unknown, fieldName: string): number {
  const result = Number(text(value));
  if (!Number.isFinite(result)) {
    throw new DmarcReportParseError(`The report has an invalid ${fieldName}.`);
  }
  return Math.max(0, Math.round(result));
}

function reasonText(value: unknown): string | undefined {
  const reasons = asArray(value)
    .map((reason) => {
      const type = text(reason.type);
      const comment = text(reason.comment);
      return [type, comment].filter(Boolean).join(': ') || text(reason);
    })
    .filter((reason): reason is string => Boolean(reason));

  return reasons.length ? reasons.join('; ') : undefined;
}

function parseAuthResults(value: unknown): ParsedAuthResult[] {
  const authResults = asRecord(value);
  if (!authResults) {
    return [];
  }

  const dkimResults = asArray(authResults.dkim).map((result) => ({
    type: 'DKIM' as const,
    domain: text(result.domain),
    selector: text(result.selector),
    result: text(result.result) ?? 'unknown',
  }));
  const spfResults = asArray(authResults.spf).map((result) => ({
    type: 'SPF' as const,
    domain: text(result.domain),
    scope: text(result.scope),
    result: text(result.result) ?? 'unknown',
  }));

  return [...dkimResults, ...spfResults];
}

function parseRecords(value: unknown): ParsedReportRecord[] {
  const records = asArray(value);
  if (records.length === 0) {
    throw new DmarcReportParseError('The report does not contain any records.');
  }

  return records.map((record) => {
    const row = asRecord(record.row);
    if (!row) {
      throw new DmarcReportParseError('A report record is missing its row data.');
    }

    const policyEvaluated = asRecord(row.policy_evaluated);
    if (!policyEvaluated) {
      throw new DmarcReportParseError('A report record is missing policy evaluation data.');
    }

    const identifiers = asRecord(record.identifiers);
    return {
      sourceIp: requiredText(row.source_ip, 'record source_ip'),
      messageCount: requiredNumber(row.count, 'record count'),
      disposition: text(policyEvaluated.disposition),
      dkimResult: text(policyEvaluated.dkim),
      spfResult: text(policyEvaluated.spf),
      headerFrom: text(identifiers?.header_from),
      envelopeFrom: text(identifiers?.envelope_from),
      policyReason: reasonText(policyEvaluated.reason),
      authResults: parseAuthResults(record.auth_results),
    };
  });
}

export function parseDmarcReport(xml: string): ParsedDmarcReport {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch {
    throw new DmarcReportParseError('The report is not valid XML.');
  }

  const root = asRecord(parsed);
  const feedback = asRecord(root?.feedback);
  if (!feedback) {
    throw new DmarcReportParseError('The XML must have a feedback root element.');
  }

  const policy = asRecord(feedback.policy_published);
  if (!policy) {
    throw new DmarcReportParseError(
      'This endpoint accepts aggregate RUA XML only. Forensic RUF reports are MIME messages and must be submitted as raw email.',
    );
  }

  let policyDomain: string;
  try {
    policyDomain = normalizeDomain(requiredText(policy.domain, 'policy domain'));
  } catch (error) {
    throw new DmarcReportParseError(error instanceof Error ? error.message : 'The report has an invalid policy domain.');
  }

  const metadata = asRecord(feedback.report_metadata);
  const dateRange = asRecord(metadata?.date_range);
  const fractionValue = text(policy.fraction);
  const fraction = fractionValue === undefined ? undefined : requiredNumber(fractionValue, 'policy fraction');

  return {
    reportType: 'AGGREGATE',
    fingerprint: createHash('sha256').update(`${policyDomain}\n${xml}`).digest('hex'),
    reportId: text(metadata?.report_id),
    reportingOrganization: text(metadata?.org_name),
    reportingEmail: text(metadata?.email),
    extraContactInfo: text(metadata?.extra_contact_info),
    dateRangeBegin: optionalDate(dateRange?.begin, 'report begin date'),
    dateRangeEnd: optionalDate(dateRange?.end, 'report end date'),
    policyDomain,
    policyAdkim: text(policy.adkim),
    policyAspf: text(policy.aspf),
    policyP: text(policy.p),
    policySp: text(policy.sp),
    policyFraction: fraction,
    reportError: text(metadata?.error),
    records: parseRecords(feedback.record),
  };
}
