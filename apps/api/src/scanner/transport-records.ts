import { organizationalDomain } from '../services/alignment.service.js';
import type {
  DmarcResult,
  MtaStsMode,
  MtaStsResult,
  TlsRptResult,
} from '../models/scan.model.js';

function joined(records: string[][]): string[] {
  return records.map((chunks) => chunks.join('').trim()).filter(Boolean);
}

function tags(record: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of record.split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0) {
      result[part.slice(0, separator).trim().toLowerCase()] = part.slice(separator + 1).trim();
    }
  }
  return result;
}

export function parseMtaStsTxt(records: string[][]): MtaStsResult {
  const candidates = joined(records).filter((record) => record.startsWith('v=STSv1'));
  if (candidates.length === 0) {
    return { status: 'missing', policy: null };
  }

  if (candidates.length > 1) {
    return {
      status: 'found',
      record: candidates.join(' | '),
      recordProblem: 'More than one MTA-STS record is published, so senders treat the domain as having no policy.',
      policy: null,
    };
  }

  const record = candidates[0]!;
  const parsed = tags(record);
  const id = parsed.id ?? '';
  if (!/^[A-Za-z0-9]{1,32}$/.test(id)) {
    return {
      status: 'found',
      record,
      recordProblem: 'The MTA-STS record needs an id of 1 to 32 letters or digits.',
      policy: null,
    };
  }

  return { status: 'found', record, id, policy: null };
}

export interface ParsedMtaStsPolicy {
  valid: boolean;
  mode?: MtaStsMode;
  maxAge?: number;
  mx?: string[];
  problems: string[];
  contentTypeProblem: string | null;
  text: string;
}

/**
 * The hostname rule MTA-STS mx patterns must satisfy.
 *
 * Exported so the hosted policy editor accepts exactly what this parser will
 * accept: a validator that is stricter or looser than the reader would either
 * refuse a policy a sender accepts, or accept one it silently drops.
 */
export const mtaStsHostnamePattern =
  /^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const hostnamePattern = mtaStsHostnamePattern;

export function parseMtaStsPolicy(text: string, contentType: string | null = 'text/plain'): ParsedMtaStsPolicy {
  const mediaType = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const contentTypeProblem =
    mediaType === 'text/plain'
      ? null
      : `Served as ${mediaType || 'no content type'}, not text/plain. Senders that check the media type ignore the policy.`;

  const first = new Map<string, string>();
  const mx: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1]!.toLowerCase();
    const value = match[2] ?? '';
    if (key === 'mx') {
      mx.push(value);
    } else if (!first.has(key)) {
      first.set(key, value);
    }
  }

  const problems: string[] = [];
  if (first.get('version') !== 'STSv1') {
    problems.push('version must be STSv1.');
  }

  const rawMode = first.get('mode');
  const mode = rawMode === 'enforce' || rawMode === 'testing' || rawMode === 'none' ? rawMode : undefined;
  if (!mode) {
    problems.push('mode must be enforce, testing or none.');
  }

  const rawMaxAge = first.get('max_age');
  let maxAge: number | undefined;
  if (!rawMaxAge || !/^\d{1,10}$/.test(rawMaxAge)) {
    problems.push('max_age must be 1 to 10 digits.');
  } else {
    maxAge = Number(rawMaxAge);
    if (maxAge > 31_557_600) {
      problems.push('max_age must be at most 31,557,600 seconds.');
    }
  }

  const cleanMx = mx.map((value) => value.trim().toLowerCase().replace(/\.+$/, '')).filter(Boolean);
  if (mode !== 'none' && cleanMx.length === 0) {
    problems.push('At least one mx host is required unless mode is none.');
  }
  for (const host of cleanMx) {
    if (!hostnamePattern.test(host)) {
      problems.push(`mx ${host} is not a valid hostname.`);
    }
  }

  return {
    valid: contentTypeProblem === null && problems.length === 0,
    ...(mode ? { mode } : {}),
    ...(maxAge !== undefined ? { maxAge } : {}),
    ...(cleanMx.length > 0 ? { mx: cleanMx } : {}),
    problems,
    contentTypeProblem,
    text: text.slice(0, 2_000),
  };
}

export function mxCoveredBy(host: string, patterns: string[]): boolean {
  const cleanHost = host.trim().toLowerCase().replace(/\.+$/, '');
  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim().toLowerCase().replace(/\.+$/, '');
    if (!pattern) continue;
    if (!pattern.startsWith('*.')) {
      if (cleanHost === pattern) {
        return true;
      }
      continue;
    }
    const suffix = pattern.slice(2);
    if (!suffix || !cleanHost.endsWith(`.${suffix}`)) {
      continue;
    }
    const prefix = cleanHost.slice(0, -(suffix.length + 1));
    if (prefix && !prefix.includes('.')) {
      return true;
    }
  }
  return false;
}

export function parseTlsRptTxt(records: string[][]): TlsRptResult {
  const candidates = joined(records).filter((record) => record.startsWith('v=TLSRPTv1'));
  if (candidates.length === 0) {
    return { status: 'missing', valid: false, mailtoTargets: [], httpsTargets: [], problems: [] };
  }
  if (candidates.length > 1) {
    return {
      status: 'found',
      record: candidates.join(' | '),
      valid: false,
      mailtoTargets: [],
      httpsTargets: [],
      problems: ['More than one TLS-RPT record is published, so senders treat the domain as having none.'],
    };
  }

  const record = candidates[0]!;
  const parsed = tags(record);
  const rawRua = parsed.rua;
  if (!rawRua) {
    return {
      status: 'found',
      record,
      valid: false,
      mailtoTargets: [],
      httpsTargets: [],
      problems: ['rua is required and no reporting addresses were listed.'],
    };
  }

  const mailtoTargets: string[] = [];
  const httpsTargets: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const value of rawRua.split(',')) {
    const uri = value.trim();
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    const scheme = uri.split(':', 1)[0]?.toLowerCase();
    if (scheme === 'mailto') {
      mailtoTargets.push(uri);
    } else if (scheme === 'https') {
      httpsTargets.push(uri);
    } else {
      problems.push(`${uri} is not a mailto: or https: address.`);
    }
  }

  if (mailtoTargets.length + httpsTargets.length === 0) {
    problems.push('rua lists no usable reporting address.');
  }

  return {
    status: 'found',
    record,
    valid: problems.length === 0,
    mailtoTargets,
    httpsTargets,
    problems,
  };
}

export interface ParsedBimiTxt {
  status: 'found' | 'missing';
  record?: string;
  multiple: boolean;
  logoUrl: string | null;
  authorityUrl: string | null;
  declined: boolean;
  problems: string[];
}

export function parseBimiTxt(records: string[][]): ParsedBimiTxt {
  const candidates = joined(records).filter((record) => record.startsWith('v=BIMI1'));
  if (candidates.length === 0) {
    return {
      status: 'missing',
      multiple: false,
      logoUrl: null,
      authorityUrl: null,
      declined: false,
      problems: [],
    };
  }

  const record = candidates[0]!;
  if (candidates.length > 1) {
    return {
      status: 'found',
      record: candidates.join(' | '),
      multiple: true,
      logoUrl: null,
      authorityUrl: null,
      declined: false,
      problems: ['More than one BIMI record is published, so mailbox providers treat the domain as having none.'],
    };
  }

  const parsed = tags(record);
  const problems: string[] = [];
  const hasLogo = Object.prototype.hasOwnProperty.call(parsed, 'l');
  const rawLogo = parsed.l ?? '';
  const declined = hasLogo && rawLogo === '';

  let logoUrl: string | null = null;
  if (hasLogo && !declined) {
    try {
      const url = new URL(rawLogo);
      if (url.protocol !== 'https:') {
        problems.push('l must be an https URL.');
      } else {
        logoUrl = rawLogo;
      }
    } catch {
      problems.push('l is not a valid URL.');
    }
  } else if (!hasLogo) {
    problems.push('l is required and no logo URL was published.');
  }

  let authorityUrl: string | null = null;
  if (parsed.a !== undefined) {
    try {
      const url = new URL(parsed.a);
      if (url.protocol !== 'https:') {
        problems.push('a must be an https URL.');
      } else {
        authorityUrl = parsed.a;
      }
    } catch {
      problems.push('a is not a valid URL.');
    }
  }

  return {
    status: 'found',
    record,
    multiple: false,
    logoUrl,
    authorityUrl,
    declined,
    problems,
  };
}

export function bimiDmarcQualification(
  dmarc: Pick<DmarcResult, 'status' | 'policy' | 'effectivePolicy' | 'tags'>,
  domain: string,
): { qualifies: boolean; reasons: string[]; dependsOnParent?: true } {
  const reasons: string[] = [];
  let qualifies = true;
  const effective = dmarc.effectivePolicy ?? dmarc.policy;

  const clean = domain.trim().toLowerCase().replace(/\.+$/, '');
  const org = organizationalDomain(clean);
  const isSubdomain = Boolean(org && org !== clean);

  /**
   * A subdomain with no DMARC record of its own is covered by its parent's
   * record (sp=, falling back to p=). This scan did not read the parent, so it
   * cannot say whether BIMI qualifies, and saying "no DMARC record" would be
   * false: it would raise a warning on every subdomain of an enforced parent.
   */
  if (dmarc.status === 'missing' && isSubdomain) {
    return {
      qualifies: false,
      dependsOnParent: true,
      reasons: [`This domain has no DMARC record of its own, so the record at ${org} applies. Scan ${org} to check it.`],
    };
  }

  if (dmarc.status === 'error') {
    reasons.push('The DMARC record could not be checked: BIMI logos are shown only at quarantine or reject.');
    qualifies = false;
  } else if (dmarc.status !== 'found') {
    reasons.push('No DMARC record is published: BIMI logos are shown only at quarantine or reject.');
    qualifies = false;
  } else if (effective !== 'quarantine' && effective !== 'reject') {
    reasons.push(`p=${effective}: BIMI logos are shown only at quarantine or reject.`);
    qualifies = false;
  }

  const sp = (dmarc.tags?.sp ?? '').trim().toLowerCase();
  if (sp === 'none') {
    reasons.push('sp=none: BIMI requires the subdomain policy not to be none.');
    qualifies = false;
  }

  if (effective === 'quarantine' && dmarc.tags?.pct !== undefined) {
    const pct = Number(dmarc.tags.pct);
    if (!Number.isFinite(pct) || pct !== 100) {
      reasons.push(`pct=${dmarc.tags.pct}: BIMI requires pct=100 when the policy is quarantine.`);
      qualifies = false;
    }
  }

  if (isSubdomain) {
    reasons.push(`The parent domain's DMARC policy must also be at enforcement. Scan ${org} to check.`);
  }

  return { qualifies, reasons };
}

export interface BimiSvgChecks {
  svgRoot: boolean;
  tinyPsProfile: boolean;
  version12: boolean;
  title: boolean;
  noForbiddenElements: boolean;
  noExternalReferences: boolean;
  withinSizeLimit: boolean;
}

export function inspectBimiSvg(bytes: Buffer): BimiSvgChecks {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const withoutProlog = text.replace(
    /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*/i,
    '',
  );
  const rootMatch = /^<svg\b[^>]*>/i.exec(withoutProlog);
  const root = rootMatch?.[0] ?? '';
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text);

  return {
    svgRoot: Boolean(rootMatch),
    tinyPsProfile: /baseProfile\s*=\s*["']tiny-ps["']/i.test(root),
    version12: /version\s*=\s*["']1\.2["']/i.test(root),
    title: Boolean(titleMatch && titleMatch[1]!.trim().length > 0),
    noForbiddenElements:
      !/<(?:script|foreignObject|image|animate|switch)\b/i.test(text) &&
      !/<a(?:\s|>)/i.test(text) &&
      !/<set(?:\s|>)/i.test(text) &&
      !/\son[a-z]+\s*=/i.test(text),
    noExternalReferences: !/(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/)/i.test(text),
    withinSizeLimit: bytes.length <= 32_768,
  };
}
