import type { DmarcPolicy, ScanIssue } from './types.js';

/**
 * Reading a DMARC record the way RFC 9989 (May 2026, which obsoletes RFC 7489)
 * says receivers read it.
 *
 * What changed that matters here:
 * - pct, rf and ri are historic (IANA DMARC Tags registry, RFC 9989 section
 *   9.3). Receivers that follow RFC 9989 ignore them, so pct=10 no longer
 *   limits enforcement to 10% of mail at those receivers: they apply the whole
 *   policy. Receivers still on RFC 7489 keep honouring pct.
 * - t (testing) replaces pct's one reliable use. t=y asks receivers to apply
 *   the policy one level softer: quarantine is handled as none, reject as
 *   quarantine (section 4.7). It is the analogue of pct=0 (appendix A.6).
 * - np sets the policy for subdomains that do not exist.
 * - psd=y is for public suffix operators only (section 5.2).
 * - A record without a valid p, or with an invalid sp or np, is treated as
 *   p=none if it names a valid rua address, and ignored otherwise
 *   (section 4.10.1).
 * - The record must begin with v=DMARC1, exactly: the version is case
 *   sensitive and must be the first tag (section 4.7). Records that do not
 *   begin with it are discarded, and if more than one valid record remains,
 *   all of them are (section 4.10).
 */

const POLICY_VALUES = new Set(['none', 'quarantine', 'reject']);
export const historicDmarcTags = ['pct', 'rf', 'ri'] as const;

/** RFC 9989 section 4.7: "v" first, value exactly "DMARC1". */
export function isDmarcPolicyRecord(record: string): boolean {
  return /^v\s*=\s*DMARC1\s*(;|$)/.test(record.trim());
}

/** Looks like a DMARC record but would be discarded for its version tag. */
export function looksLikeMisversionedDmarc(record: string): boolean {
  return !isDmarcPolicyRecord(record) && /(^|;)\s*v\s*=\s*dmarc1\s*(;|$)/i.test(record.trim());
}

function validPolicy(value: string | undefined): value is 'none' | 'quarantine' | 'reject' {
  return value !== undefined && POLICY_VALUES.has(value.trim().toLowerCase());
}

function oneLevelSofter(policy: 'none' | 'quarantine' | 'reject'): 'none' | 'quarantine' {
  return policy === 'reject' ? 'quarantine' : 'none';
}

export interface DmarcPolicyReading {
  /** The policy receivers that follow RFC 9989 apply, before testing mode. */
  policy: DmarcPolicy;
  /** t=y is published. */
  testing: boolean;
  /** What failing mail actually gets once t=y is taken into account. */
  effectivePolicy: DmarcPolicy;
  /** Whether receivers apply DMARC to this record at all. */
  applies: boolean;
  notices: ScanIssue[];
}

/**
 * The policy receivers apply, and every finding about the record's tags.
 *
 * `hasValidReportingUri` decides the section 4.10.1 fallback: a record whose
 * policy tags are broken still means "p=none" if it asks for reports.
 */
export function readDmarcPolicy(tags: Record<string, string>, hasValidReportingUri: boolean): DmarcPolicyReading {
  const notices: ScanIssue[] = [];
  const p = tags.p?.trim().toLowerCase();
  const sp = tags.sp?.trim().toLowerCase();
  const np = tags.np?.trim().toLowerCase();

  const pValid = validPolicy(p);
  const spValid = sp === undefined || validPolicy(sp);
  const npValid = np === undefined || validPolicy(np);

  let policy: DmarcPolicy;
  let applies = true;

  if (pValid && spValid && npValid) {
    policy = p;
  } else if (hasValidReportingUri) {
    policy = 'none';
    const broken = [!pValid ? (p === undefined ? 'p is missing' : `p=${tags.p} is not a policy`) : null, !spValid ? `sp=${tags.sp} is not a policy` : null, !npValid ? `np=${tags.np} is not a policy` : null]
      .filter(Boolean)
      .join(', ');
    notices.push({
      severity: 'error',
      code: 'dmarc_policy_fallback',
      title: 'Receivers treat this record as p=none',
      message: `${broken[0]!.toUpperCase()}${broken.slice(1)}. Because the record asks for reports, receivers that follow RFC 9989 act as if it said p=none (section 4.10.1): reports still arrive, but no failing mail is blocked.`,
      recommendation: 'Set p, and sp and np if used, to none, quarantine or reject.',
    });
  } else {
    policy = 'unknown';
    applies = false;
  }

  const tValue = tags.t?.trim().toLowerCase();
  const testing = tValue === 'y';
  if (tValue !== undefined && tValue !== 'y' && tValue !== 'n') {
    notices.push({
      severity: 'warning',
      code: 'dmarc_testing_invalid',
      title: 'The t tag has an invalid value',
      message: `t=${tags.t} is neither y nor n, so receivers use the default (n) and apply the policy in full.`,
      recommendation: 'Use t=y while testing a policy, or remove t to apply it.',
    });
  }

  let effectivePolicy: DmarcPolicy = policy;
  if (testing && (policy === 'quarantine' || policy === 'reject')) {
    effectivePolicy = oneLevelSofter(policy);
  } else if (testing && policy === 'none') {
    notices.push({
      severity: 'info',
      code: 'dmarc_testing_without_policy',
      title: 't=y has no effect with p=none',
      message: 'Testing mode softens a quarantine or reject policy by one level; p=none has nothing to soften (RFC 9989 section 4.7).',
      recommendation: 'Remove t=y, or keep it for when the policy moves to quarantine.',
    });
  }

  const pct = tags.pct?.trim();
  if (pct !== undefined) {
    const pctNumber = Number(pct);
    const enforcing = policy === 'quarantine' || policy === 'reject';
    if (pct === '0' && testing) {
      // The transition pair: t=y for RFC 9989 receivers, pct=0 for the ones
      // still on RFC 7489. Both mean "testing", so this is not a fault.
    } else if (enforcing && pct === '0') {
      notices.push({
        severity: 'warning',
        code: 'dmarc_pct_historic',
        title: 'pct=0 no longer means testing everywhere',
        message: `Receivers that follow RFC 9989 ignore pct, so they apply p=${policy} to all failing mail. Only receivers still on RFC 7489 treat pct=0 as a test.`,
        recommendation: 'Add t=y to keep testing mode at every receiver, or remove pct=0 to enforce.',
      });
    } else if (enforcing && Number.isInteger(pctNumber) && pctNumber > 0 && pctNumber < 100) {
      notices.push({
        severity: 'warning',
        code: 'dmarc_pct_historic',
        title: `pct=${pct} applies to all failing mail at newer receivers`,
        message: `pct was retired by RFC 9989. Receivers that follow it ignore the tag and apply p=${policy} to every failing message, while receivers still on RFC 7489 apply it to ${pct}%. The same record now means two different things.`,
        recommendation: `Decide which you want: remove pct to enforce p=${policy} everywhere, or publish t=y to test it everywhere.`,
      });
    } else {
      notices.push({
        severity: 'info',
        code: 'dmarc_historic_tag',
        title: 'pct is a retired tag',
        message: 'RFC 9989 retired pct. It changes nothing at receivers that follow it and can be removed.',
        recommendation: 'Remove pct from the record.',
      });
    }
  }

  for (const tag of ['rf', 'ri'] as const) {
    if (tags[tag] !== undefined) {
      notices.push({
        severity: 'info',
        code: 'dmarc_historic_tag',
        title: `${tag} is a retired tag`,
        message: `RFC 9989 retired ${tag}. Receivers ignore it, so it can be removed.`,
        recommendation: `Remove ${tag} from the record.`,
      });
    }
  }

  const psd = tags.psd?.trim().toLowerCase();
  if (psd === 'y') {
    notices.push({
      severity: 'warning',
      code: 'dmarc_psd_yes',
      title: 'psd=y is for public suffix operators only',
      message:
        'psd=y declares this domain a public suffix, like .com or .co.uk (RFC 9989 section 5.2). On an organisation\'s own domain it makes every subdomain its own organisation, so relaxed alignment between them stops working.',
      recommendation: 'Remove psd=y, or use psd=n to mark this domain as the organisational domain.',
    });
  } else if (psd !== undefined && psd !== 'n' && psd !== 'u') {
    notices.push({
      severity: 'warning',
      code: 'dmarc_psd_invalid',
      title: 'The psd tag has an invalid value',
      message: `psd=${tags.psd} is not y, n or u, so receivers ignore it.`,
      recommendation: 'Remove psd, or set it to n.',
    });
  }

  return { policy, testing, effectivePolicy, applies, notices };
}
