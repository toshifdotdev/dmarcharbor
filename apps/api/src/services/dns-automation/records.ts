import { createHash } from 'node:crypto';
import type { CloudflareTxtRecord } from './cloudflare.client.js';
import { buildDualRecord, splitDmarcRecord } from '../switch-kit/record-rewrite.js';

export type PublishableKind =
  | 'verification'
  | 'dmarc_suggested'
  | 'dmarc_policy'
  | 'switch_dual'
  | 'switch_cutover';

export type DmarcPublishPolicy = 'none' | 'quarantine' | 'reject';

export interface PublishRecordInput {
  kind: PublishableKind;
  policy?: DmarcPublishPolicy;
  testing?: boolean;
  np?: DmarcPublishPolicy | null;
}

/**
 * Quotes and insignificant whitespace differ between Cloudflare's stored form
 * and the value the server generated. Comparison must not turn that into a
 * spurious update, and the fingerprint must be stable across both.
 */
export function normaliseTxtValue(value: string): string {
  let text = value.trim();
  while (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim();
  }
  return text.replace(/\s+/g, ' ').trim();
}

export function isDmarcRecordValue(value: string): boolean {
  return /^v=dmarc1(?:;|\s|$)/i.test(normaliseTxtValue(value));
}

export function isVerificationRecordValue(value: string): boolean {
  return normaliseTxtValue(value).toLowerCase().startsWith('dmarc-harbor-verification=');
}

export function matchingRecords(
  kind: PublishableKind,
  records: CloudflareTxtRecord[],
): CloudflareTxtRecord[] {
  return records.filter((record) =>
    kind === 'verification'
      ? isVerificationRecordValue(record.content)
      : isDmarcRecordValue(record.content),
  );
}

export function currentValues(records: CloudflareTxtRecord[]): string[] {
  return [...new Set(records.map((record) => normaliseTxtValue(record.content)))].sort();
}

/** SHA-256 over sorted, normalised current values. */
export function fingerprintValues(values: string[]): string {
  return createHash('sha256').update([...values].sort().join('\n')).digest('hex');
}

export type PreviewAction = 'create' | 'update' | 'unchanged' | 'refused';

export interface ActionChoice {
  action: PreviewAction;
  reason: string | null;
  matching: CloudflareTxtRecord | null;
}

/**
 * Chooses one operation. A name may hold unrelated TXT records (Google site
 * verification, for example); only the record kind this feature owns is ever
 * matched, and nothing else at the name is touched.
 */
export function chooseDnsAction(input: {
  kind: PublishableKind;
  records: CloudflareTxtRecord[];
  cname: boolean;
  proposedValue: string;
}): ActionChoice {
  if (input.cname) {
    return {
      action: 'refused',
      reason: 'A CNAME record already exists at this name. Cloudflare will not allow a TXT record there. Remove the CNAME first.',
      matching: null,
    };
  }

  const matches = matchingRecords(input.kind, input.records);
  if (matches.length > 1) {
    return {
      action: 'refused',
      reason:
        input.kind === 'verification'
          ? 'More than one verification record exists at this name. Remove the extra ones in Cloudflare first.'
          : 'More than one DMARC record exists at this name. Receivers ignore all of them. Remove the extras in Cloudflare first.',
      matching: null,
    };
  }

  if (matches.length === 0) {
    return { action: 'create', reason: null, matching: null };
  }

  const existing = matches[0]!;
  return {
    action:
      normaliseTxtValue(existing.content) === normaliseTxtValue(input.proposedValue)
        ? 'unchanged'
        : 'update',
    reason: null,
    matching: existing,
  };
}

/**
 * Puts our report address into a DMARC record that is already published,
 * leaving every other tag exactly as written.
 *
 * Publishing the starter record over an existing one replaced it wholesale:
 * a domain at p=reject was relaxed to p=none, and its sp=, adkim=, ruf= and
 * the previous provider's rua= addresses were dropped in the same write. Over
 * an existing record, "start reporting to DMARC Harbor" means adding the
 * address, nothing else.
 */
export function addReportAddress(record: string, ourAddress: string): string {
  return buildDualRecord(normaliseTxtValue(record), ourAddress).value;
}

/**
 * Changes only the policy tags of a published DMARC record: p=, np= when one
 * is asked for, and the testing pair. rua=, ruf=, sp=, alignment and anything
 * else the domain owner wrote are kept. pct= is dropped unless testing, which
 * writes t=y; pct=0 the same way generated records do (RFC 9989 appendix A.6).
 */
export function rewriteDmarcPolicy(
  record: string,
  ourAddress: string,
  change: { policy: DmarcPublishPolicy; testing: boolean; np: DmarcPublishPolicy | null },
): string {
  const segments = splitDmarcRecord(normaliseTxtValue(record)).filter((segment) => segment.raw.trim() !== '');
  const out: string[] = [];
  let policyWritten = false;
  let npSeen = false;

  for (const segment of segments) {
    if (segment.key === 'p') {
      out.push(`p=${change.policy}`);
      policyWritten = true;
      continue;
    }
    if (segment.key === 't' || segment.key === 'pct') {
      continue;
    }
    if (segment.key === 'np') {
      npSeen = true;
      out.push(change.np ? `np=${change.np}` : segment.raw.trim());
      continue;
    }
    out.push(segment.raw.trim());
  }

  if (!policyWritten) {
    out.splice(Math.min(1, out.length), 0, `p=${change.policy}`);
  }
  if (change.np && !npSeen) {
    out.push(`np=${change.np}`);
  }
  if (change.testing && change.policy !== 'none') {
    out.push('t=y', 'pct=0');
  }

  return addReportAddress(out.join('; '), ourAddress);
}
