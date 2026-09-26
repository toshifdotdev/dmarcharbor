import { createHash } from 'node:crypto';
import { normalizeDomain } from '../scanner/domain.js';
import { normalizeAddress, pseudonymize, pseudonymizeAddress } from './privacy.service.js';

const maxEmailLength = 5_000_000;
const maxParts = 40;
const maxDepth = 4;
const maxPartLength = 262_144;
const maxDiagnosticCodes = 5;

export type ForensicAuthType = 'DKIM' | 'SPF';

export interface ParsedForensicAuthResult {
  type: ForensicAuthType;
  domain?: string;
  selector?: string;
  scope?: string;
  result: string;
}

export interface ParsedForensicIdentifiers {
  recipientAddresses: string[];
  envelopeFrom?: string;
  subjectLine?: string;
}

export interface ParsedForensicReport {
  fingerprint: string;
  feedbackType: string;
  reportedDomain: string;
  sourceIp: string;
  sourcePort?: number;
  disposition?: string;
  deliveryAction?: string;
  deliveryStatus?: string;
  dkimResult?: string;
  spfResult?: string;
  authResults: ParsedForensicAuthResult[];
  reportingMta?: string;
  dsnGateway?: string;
  remoteMta?: string;
  userAgent?: string;
  diagnosticCodes: string[];
  recipientCount: number;
  recipientPseudonyms: string[];
  envelopeFromPseudonym?: string;
  messageIdPseudonym?: string;
  subjectPseudonym?: string;
  originalMessageDate?: Date;
  arrivedAt?: Date;
  hasOriginalHeaders: boolean;
  hasOriginalMessageIncluded: boolean;
  identifiers: ParsedForensicIdentifiers;
}

interface MimePart {
  contentType: string;
  params: Record<string, string>;
  body: string;
}

export class ForensicReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForensicReportParseError';
  }
}

function parseHeaderBlock(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let currentKey: string | undefined;

  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    if (/^[ \t]/.test(line) && currentKey) {
      headers[currentKey] = `${headers[currentKey]} ${line.trim()}`.trim();
      continue;
    }

    const separator = line.indexOf(':');
    if (separator < 1) {
      continue;
    }

    currentKey = line.slice(0, separator).trim().toLowerCase();
    headers[currentKey] = line.slice(separator + 1).trim();
  }

  return headers;
}

function parseContentType(value: string | undefined): { type: string; params: Record<string, string> } {
  if (!value) {
    return { type: '', params: {} };
  }

  const [rawType, ...rest] = value.split(';');
  const params: Record<string, string> = {};

  for (const entry of rest) {
    const separator = entry.indexOf('=');
    if (separator < 1) {
      continue;
    }

    const key = entry.slice(0, separator).trim().toLowerCase();
    params[key] = entry.slice(separator + 1).trim().replace(/^"|"$/g, '');
  }

  return { type: rawType.trim().toLowerCase(), params };
}

function splitEntity(raw: string): { headers: Record<string, string>; body: string } {
  const separator = /\r?\n\r?\n/.exec(raw);
  if (!separator || separator.index === undefined) {
    return { headers: parseHeaderBlock(raw), body: '' };
  }

  return {
    headers: parseHeaderBlock(raw.slice(0, separator.index)),
    body: raw.slice(separator.index + separator[0].length),
  };
}

function splitOnBoundary(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const segments: string[] = [];
  let current: string[] | undefined;

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed === delimiter) {
      if (current) {
        segments.push(current.join('\r\n'));
      }
      current = [];
      continue;
    }

    if (trimmed === `${delimiter}--`) {
      if (current) {
        segments.push(current.join('\r\n'));
      }
      current = undefined;
      break;
    }

    current?.push(line);
  }

  if (current) {
    segments.push(current.join('\r\n'));
  }

  return segments;
}

function decodeQuotedPrintable(body: string): Buffer {
  const joined = body.replace(/=\r?\n/g, '');
  const bytes: number[] = [];

  for (let index = 0; index < joined.length; index += 1) {
    const character = joined[index];
    if (character === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(joined.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }

    bytes.push(character.charCodeAt(0) & 0xff);
  }

  return Buffer.from(bytes);
}

function charsetEncoding(charset: string | undefined): BufferEncoding {
  const value = (charset ?? 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (value === 'us-ascii' || value === 'ascii') {
    return 'ascii';
  }
  if (value === 'iso-8859-1' || value === 'latin1' || value === 'iso8859-1') {
    return 'latin1';
  }
  return 'utf8';
}

function decodeBody(body: string, encoding: string | undefined, charset: string | undefined): string {
  const normalized = (encoding ?? '7bit').trim().toLowerCase();
  const buffer =
    normalized === 'base64'
      ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
      : normalized === 'quoted-printable'
        ? decodeQuotedPrintable(body)
        : Buffer.from(body, 'latin1');

  return buffer.toString(charsetEncoding(charset));
}

function collectParts(raw: string, depth = 0, counter = { count: 0 }): MimePart[] {
  if (counter.count >= maxParts || depth > maxDepth) {
    return [];
  }

  counter.count += 1;
  const { headers, body } = splitEntity(raw);
  const { type, params } = parseContentType(headers['content-type']);
  const boundedBody = body.slice(0, maxPartLength);

  if (type.startsWith('multipart/')) {
    const boundary = params.boundary;
    if (!boundary) {
      return [];
    }

    return splitOnBoundary(boundedBody, boundary).flatMap((segment) => collectParts(segment, depth + 1, counter));
  }

  return [
    {
      contentType: type,
      params,
      body: decodeBody(boundedBody, headers['content-transfer-encoding'], params.charset),
    },
  ];
}

function parseFieldBlocks(text: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  let currentKey: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    if (/^[ \t]/.test(line) && currentKey) {
      const existing = fields.get(currentKey) ?? [];
      existing[existing.length - 1] = `${existing[existing.length - 1]} ${line.trim()}`.trim();
      fields.set(currentKey, existing);
      continue;
    }

    const separator = line.indexOf(':');
    if (separator < 1) {
      continue;
    }

    currentKey = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    fields.set(currentKey, [...(fields.get(currentKey) ?? []), value]);
  }

  return fields;
}

function firstField(fields: Map<string, string[]> | undefined, ...keys: string[]): string | undefined {
  if (!fields) {
    return undefined;
  }

  for (const key of keys) {
    const value = fields.get(key)?.[0]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function allFields(fields: Map<string, string[]> | undefined, ...keys: string[]): string[] {
  if (!fields) {
    return [];
  }

  return keys.flatMap((key) => fields.get(key) ?? []).map((value) => value.trim()).filter(Boolean);
}

function stripTypePrefix(value: string): string {
  const separator = value.indexOf(';');
  return (separator >= 0 ? value.slice(separator + 1) : value).trim();
}

function redactAddresses(value: string): string {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (match) => `[redacted:${pseudonymizeAddress(match)?.slice(0, 12)}]`);
}

function truncate(value: string, length = 300): string {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function parseAuthenticationResults(values: string[]): ParsedForensicAuthResult[] {
  const results: ParsedForensicAuthResult[] = [];

  for (const value of values) {
    for (const mechanism of value.split(';')) {
      const properties: Record<string, string> = {};
      let method: string | undefined;
      let outcome: string | undefined;

      for (const token of mechanism.trim().split(/\s+/)) {
        const separator = token.indexOf('=');
        if (separator < 1) {
          continue;
        }

        const key = token.slice(0, separator).trim().toLowerCase();
        const propertyValue = token.slice(separator + 1).trim().toLowerCase();

        if (key === 'dkim' || key === 'spf') {
          method = key;
          outcome = propertyValue;
          continue;
        }

        properties[key] = propertyValue;
      }

      if (!method || !outcome) {
        continue;
      }

      if (method === 'dkim') {
        const domain = properties['header.d'] ?? properties['header.i']?.replace(/^@/, '');
        results.push({
          type: 'DKIM',
          result: outcome,
          domain: domain ? truncate(domain, 253) : undefined,
          selector: properties['header.s'],
        });
        continue;
      }

      const mailFrom = properties['smtp.mailfrom'] ?? properties['smtp.helo'];
      const domain = mailFrom?.includes('@') ? mailFrom.slice(mailFrom.indexOf('@') + 1) : mailFrom;
      results.push({
        type: 'SPF',
        result: outcome,
        domain: domain ? truncate(domain, 253) : undefined,
        scope: 'mfrom',
      });
    }
  }

  return results;
}

function dispositionFromAction(action: string | undefined): string | undefined {
  const value = (action ?? '').trim().toLowerCase();
  if (value === 'fail' || value === 'reject') {
    return 'reject';
  }
  if (value === 'quarantine') {
    return 'quarantine';
  }
  if (value === 'delay') {
    return 'delayed';
  }
  if (value === 'none' || value === 'accept' || value === 'deliver') {
    return 'none';
  }

  return undefined;
}

function parseOptionalDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const unixSeconds = Number(trimmed);
  if (Number.isFinite(unixSeconds) && /^\d+$/.test(trimmed)) {
    return new Date(unixSeconds * 1000);
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function domainFromAuthenticationResults(results: ParsedForensicAuthResult[]): string | undefined {
  const candidates = [
    ...results.filter((result) => result.type === 'DKIM'),
    ...results.filter((result) => result.type === 'SPF'),
  ];

  for (const result of candidates) {
    if (result.domain) {
      return result.domain;
    }
  }

  return undefined;
}

function buildFingerprint(report: Omit<ParsedForensicReport, 'fingerprint'>): string {
  const canonical = [
    report.reportedDomain,
    report.sourceIp,
    report.sourcePort ?? '',
    report.disposition ?? '',
    report.dkimResult ?? '',
    report.spfResult ?? '',
    report.arrivedAt?.toISOString() ?? '',
    report.originalMessageDate?.toISOString() ?? '',
    report.messageIdPseudonym ?? '',
    report.subjectPseudonym ?? '',
    report.envelopeFromPseudonym ?? '',
    report.recipientPseudonyms.join(','),
  ].join('\n');

  return createHash('sha256').update(canonical).digest('hex');
}

function readMimeParts(rawEmail: string): MimePart[] {
  if (!rawEmail.trim()) {
    throw new ForensicReportParseError('The report email is empty.');
  }

  if (rawEmail.length > maxEmailLength) {
    throw new ForensicReportParseError('The report email is too large to process.');
  }

  return collectParts(rawEmail);
}

export function containsForensicParts(rawEmail: string): boolean {
  return readMimeParts(rawEmail).some((part) => part.contentType === 'application/feedback-report');
}

export function parseForensicReport(rawEmail: string): ParsedForensicReport {
  const parts = readMimeParts(rawEmail);
  const feedbackPart = parts.find((part) => part.contentType === 'application/feedback-report');

  if (!feedbackPart) {
    throw new ForensicReportParseError('The message does not contain an application/feedback-report part.');
  }

  const feedback = parseFieldBlocks(feedbackPart.body);
  const feedbackType = (firstField(feedback, 'feedback-type') ?? '').trim().toLowerCase();

  if (feedbackType && feedbackType !== 'feedback-report' && !feedbackType.includes('dmarc')) {
    throw new ForensicReportParseError(`Unsupported feedback type: ${truncate(feedbackType, 60)}.`);
  }

  const deliveryPart = parts.find((part) => part.contentType === 'message/delivery-status');
  const deliveryBlocks = deliveryPart ? deliveryPart.body.split(/\r?\n\s*\r?\n/).map((block) => parseFieldBlocks(block)) : [];

  const groupFields = deliveryBlocks[0] ?? new Map<string, string[]>();
  const recipientBlocks = deliveryBlocks.slice(1);
  const primaryRecipient = recipientBlocks[0];

  const sourceIpRaw =
    firstField(feedback, 'source-ip', 'source-ip-source') ??
    firstField(groupFields, 'source-ip') ??
    firstField(primaryRecipient, 'source-ip') ??
    '';
  const [sourceIpValue, sourcePortValue] = sourceIpRaw.trim().split(/\s+/);
  const sourceIp = sourceIpValue ?? '';

  if (!sourceIp) {
    throw new ForensicReportParseError('The report is missing the source IP address.');
  }

  const authResults = parseAuthenticationResults(allFields(feedback, 'authentication-results'));
  const reportedDomainRaw =
    firstField(feedback, 'reported-domain') ??
    firstField(groupFields, 'reported-domain') ??
    domainFromAuthenticationResults(authResults) ??
    '';
  const reportedDomain = normalizeDomain(reportedDomainRaw);

  const dkimResult = authResults.find((result) => result.type === 'DKIM' && result.domain === reportedDomain)?.result ??
    authResults.find((result) => result.type === 'DKIM')?.result;
  const spfResult = authResults.find((result) => result.type === 'SPF' && result.domain === reportedDomain)?.result ??
    authResults.find((result) => result.type === 'SPF')?.result;

  const deliveryAction = firstField(primaryRecipient, 'action');
  const recipients = allFields(feedback, 'original-rcpt-to', 'original-recipient')
    .concat(allFields(primaryRecipient, 'final-recipient'))
    .map((entry) => stripTypePrefix(entry))
    .filter(Boolean);
  const envelopeFrom = firstField(feedback, 'original-mail-from', 'original-envelope-id') ??
    firstField(primaryRecipient, 'original-mail-from');

  const originalHeadersPart = parts.find(
    (part) => part.contentType === 'text/rfc822-headers' || part.contentType === 'text/rfc822-header-fields',
  );
  const originalMessagePart = parts.find((part) => part.contentType === 'message/rfc822');
  const originalHeaders = originalHeadersPart
    ? parseHeaderBlock(originalHeadersPart.body)
    : originalMessagePart
      ? splitEntity(originalMessagePart.body).headers
      : undefined;

  const subjectPseudonym = originalHeaders?.subject
    ? pseudonymize(`subject:${originalHeaders.subject.replace(/\s+/g, ' ').trim()}`)
    : undefined;
  const messageIdPseudonym = originalHeaders?.['message-id']
    ? pseudonymize(`message-id:${originalHeaders['message-id'].trim()}`)
    : undefined;
  const originalFromPseudonym = originalHeaders?.from ? pseudonymizeAddress(originalHeaders.from) : undefined;

  const recipientPseudonyms = [
    ...new Set(
      recipients
        .map((recipient) => pseudonymizeAddress(recipient))
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  const recipientAddresses = [
    ...new Set(
      recipients
        .map((recipient) => normalizeAddress(recipient))
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  if (!recipientAddresses.length && originalHeaders?.to) {
    const address = normalizeAddress(originalHeaders.to);
    if (address) {
      recipientAddresses.push(address);
      recipientPseudonyms.push(pseudonymizeAddress(address) as string);
    }
  }

  const parsed: Omit<ParsedForensicReport, 'fingerprint'> = {
    feedbackType: feedbackType || 'feedback-report',
    reportedDomain,
    sourceIp,
    sourcePort: sourcePortValue && Number.isFinite(Number(sourcePortValue)) ? Number(sourcePortValue) : undefined,
    disposition: dispositionFromAction(deliveryAction),
    deliveryAction: deliveryAction?.trim().toLowerCase(),
    deliveryStatus: firstField(primaryRecipient, 'status'),
    dkimResult,
    spfResult,
    authResults,
    reportingMta: stripTypePrefix(firstField(feedback, 'reporting-mta', 'reporting-mta-type') ?? '') || undefined,
    dsnGateway: firstField(feedback, 'dsn-gateway'),
    remoteMta: stripTypePrefix(
      firstField(primaryRecipient, 'remote-mta') ?? firstField(feedback, 'remote-mta') ?? '',
    ) || undefined,
    userAgent: truncate(firstField(feedback, 'user-agent') ?? '', 200) || undefined,
    diagnosticCodes: allFields(primaryRecipient, 'diagnostic-code')
      .slice(0, maxDiagnosticCodes)
      .map((code) => truncate(redactAddresses(code))),
    recipientCount: recipientPseudonyms.length,
    recipientPseudonyms,
    envelopeFromPseudonym: pseudonymizeAddress(envelopeFrom) ?? originalFromPseudonym,
    messageIdPseudonym,
    subjectPseudonym,
    originalMessageDate: parseOptionalDate(originalHeaders?.date),
    arrivedAt: parseOptionalDate(
      firstField(feedback, 'arrival-date') ?? firstField(feedback, 'arrival-time') ?? firstField(groupFields, 'arrival-date'),
    ),
    hasOriginalHeaders: Boolean(originalHeadersPart),
    hasOriginalMessageIncluded: Boolean(originalMessagePart),
    identifiers: {
      recipientAddresses,
      envelopeFrom: normalizeAddress(envelopeFrom) ?? normalizeAddress(originalHeaders?.from),
      subjectLine: originalHeaders?.subject ? originalHeaders.subject.replace(/\s+/g, ' ').trim() : undefined,
    },
  };

  return { ...parsed, fingerprint: buildFingerprint(parsed) };
}
