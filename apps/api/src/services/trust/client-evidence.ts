/**
 * client-evidence.ts — the readings the Trust Center and the evidence pack
 * print about one client's domains, derived from records this service holds.
 *
 * Pure on purpose: no database, no clock, no environment. The service next to
 * it does the queries and passes the rows in; everything here turns a stored
 * scan, a report count or a review row into the words a reader sees. Keeping
 * the two apart means the wording can be unit tested against fixed inputs,
 * and the pack's bytes depend only on what was passed in, which is what lets
 * the same facts produce the same digest.
 *
 * Every reading says what it rests on. A domain that has not been checked is
 * "Not checked yet", never a pass; an optional standard that is not published
 * is "Not published", which is a fact, not a failure; and nothing here infers a
 * control from the absence of a finding.
 */

import type { ScanResult } from '../../models/scan.model.js';

/** How a check reads, and the shape the documents draw beside its word. */
export type CheckState = 'pass' | 'warn' | 'fail' | 'absent' | 'unchecked';

export interface CheckReading {
  state: CheckState;
  /** The state word: short, and never colour alone. */
  word: string;
  /** One plain line on what the word rests on, or null when the word says it all. */
  detail: string | null;
}

export type ReportingTarget = 'this-service' | 'elsewhere' | 'none' | 'unknown';

export interface DmarcReading extends CheckReading {
  /** none, quarantine or reject, as published. Null when there is no usable record. */
  policy: 'none' | 'quarantine' | 'reject' | null;
  /** 0, 1 or 2 for none, quarantine, reject. Drives the strip map. */
  level: 0 | 1 | 2 | null;
  testing: boolean;
  record: string | null;
  reporting: ReportingTarget;
}

export interface DomainPostureReading {
  /** When the check these readings come from completed, or null if none is held. */
  checkedAt: string | null;
  dmarc: DmarcReading;
  spf: CheckReading & { record: string | null };
  dkim: CheckReading & { selectors: string[] };
  mtaSts: CheckReading;
  tlsRpt: CheckReading & { record: string | null };
  bimi: CheckReading & { record: string | null };
  /** Errors and warnings the check raised, newest check only. */
  issues: { severity: 'error' | 'warning'; title: string }[];
}

const unchecked = (detail: string | null = null): CheckReading => ({ state: 'unchecked', word: 'Not checked', detail });
const lookupFailed = (detail?: string): CheckReading => ({
  state: 'unchecked',
  word: 'Lookup failed',
  detail: detail ? clip(detail, 160) : 'DNS did not answer during the check.',
});

function clip(value: string, length: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`;
}

/** The rua targets a record names, as written, mail first. */
function reportTargets(result: ScanResult): string[] {
  const dmarc = result.dmarc;
  const fromTags = (dmarc.tags?.rua ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const listed = [...(dmarc.aggregateMailtoTargets ?? []), ...(dmarc.aggregateWebTargets ?? [])];
  return listed.length > 0 ? listed : fromTags;
}

function readReporting(result: ScanResult, isOurs: (uri: string) => boolean): ReportingTarget {
  if (result.dmarc.status !== 'found') {
    return result.dmarc.status === 'error' ? 'unknown' : 'none';
  }
  const targets = reportTargets(result);
  if (targets.length === 0) return 'none';
  return targets.some((target) => {
    try {
      return isOurs(target);
    } catch {
      return false;
    }
  })
    ? 'this-service'
    : 'elsewhere';
}

const levelOf = { none: 0, quarantine: 1, reject: 2 } as const;

function readDmarc(result: ScanResult, isOurs: (uri: string) => boolean): DmarcReading {
  const dmarc = result.dmarc;
  const base = { policy: null, level: null, testing: false, record: dmarc.record ?? null, reporting: readReporting(result, isOurs) } as const;

  if (dmarc.status === 'error') {
    return { ...base, ...lookupFailed(dmarc.error) };
  }
  if (dmarc.status === 'missing') {
    return { ...base, state: 'fail', word: 'No record', detail: 'No DMARC record is published, so receivers apply no policy.' };
  }
  if (dmarc.policy === 'unknown') {
    return {
      ...base,
      state: 'fail',
      word: 'Not valid',
      detail: 'A record is published but cannot be read as DMARC, so receivers ignore it.',
    };
  }

  const policy = dmarc.policy;
  const testing = dmarc.testing === true;
  const pctText = dmarc.tags?.pct;
  const pct = pctText !== undefined && /^\d{1,3}$/.test(pctText.trim()) ? Number(pctText.trim()) : 100;
  const sp = dmarc.tags?.sp?.trim().toLowerCase();
  // Whole sentences, so each can follow any lead sentence.
  const extras: string[] = [];
  if (pct < 100) extras.push(`Applied to ${pct}% of failing mail (pct=${pct}).`);
  if (sp && sp !== policy) extras.push(`Subdomains: sp=${sp}.`);

  const reading: DmarcReading = { ...base, policy, level: levelOf[policy], testing, state: 'pass', word: `p=${policy}`, detail: null };

  if (policy === 'none') {
    reading.state = 'warn';
    reading.detail = ['Monitoring only: failing mail is delivered as normal.', ...extras].join(' ');
    return reading;
  }

  if (testing) {
    reading.state = 'warn';
    reading.word = `p=${policy}, testing`;
    reading.detail = [
      `t=y is published, so receivers apply ${policy === 'reject' ? 'quarantine' : 'no policy'}.`,
      ...extras,
    ].join(' ');
    return reading;
  }

  if (pct < 100) {
    reading.state = 'warn';
    reading.detail = extras.join(' ');
    return reading;
  }
  reading.detail = ['Enforced on all failing mail.', ...extras].join(' ');
  return reading;
}

function readSpf(result: ScanResult): CheckReading & { record: string | null } {
  const spf = result.spf;
  const record = spf.record ?? null;
  if (spf.status === 'error') return { ...lookupFailed(spf.error), record };
  if (spf.status === 'missing') {
    return { state: 'fail', word: 'No record', detail: 'No SPF record is published.', record };
  }
  if (!spf.valid) {
    return {
      state: 'fail',
      word: 'Not valid',
      detail: spf.problems?.[0] ? clip(spf.problems[0], 160) : 'Receivers treat the record as a permanent error.',
      record,
    };
  }
  if (spf.lookupLimitExceeded) {
    return {
      state: 'fail',
      word: 'Over 10 lookups',
      detail: `${plural(spf.lookupCount, 'DNS lookup')}; receivers return a permanent error and SPF fails.`,
      record,
    };
  }
  const all = /(?:^|\s)([-~?+]?)all(?:\s|$)/i.exec(record ?? '');
  const qualifier = all ? all[1] || '+' : null;
  const lookups = `${spf.lookupCount} of 10 lookups`;
  if (qualifier === '+') {
    return { state: 'fail', word: 'Allows anyone', detail: `Ends in +all, so any server passes SPF. ${lookups}.`, record };
  }
  if (qualifier === '?') {
    return { state: 'warn', word: 'Neutral', detail: `Ends in ?all, which tells receivers nothing. ${lookups}.`, record };
  }
  return {
    state: 'pass',
    word: 'Valid',
    detail: qualifier ? `${lookups}, ends in ${qualifier}all.` : `${lookups}.`,
    record,
  };
}

function readDkim(result: ScanResult): CheckReading & { selectors: string[] } {
  const dkim = result.dkim;
  const selectors = [...(dkim.selectors ?? [])].sort();
  if (dkim.status === 'error' && selectors.length === 0) return { ...lookupFailed(dkim.error), selectors };
  const revoked = dkim.revokedSelectors ?? [];
  if (selectors.length > 0) {
    return {
      state: 'pass',
      word: selectors.length === 1 ? 'Key found' : `${selectors.length} keys found`,
      detail: `Selector${selectors.length === 1 ? '' : 's'} ${selectors.join(', ')}.${revoked.length ? ` Revoked: ${revoked.join(', ')}.` : ''}`,
      selectors,
    };
  }
  const checked = dkim.checkedSelectors?.length ?? 0;
  return {
    state: 'warn',
    word: 'No key found',
    detail: `None of the ${plural(checked, 'selector')} checked publishes a key. A key at a selector that was not checked is not seen.`,
    selectors,
  };
}

function readMtaSts(result: ScanResult): CheckReading {
  const mtaSts = result.mtaSts;
  if (!mtaSts) return unchecked('This check was made before MTA-STS was read.');
  if (mtaSts.status === 'error') return lookupFailed(mtaSts.error);
  if (mtaSts.status === 'missing') return { state: 'absent', word: 'Not published', detail: null };
  if (mtaSts.recordProblem) return { state: 'fail', word: 'Record not valid', detail: clip(mtaSts.recordProblem, 160) };
  const policy = mtaSts.policy;
  if (!policy || policy.status !== 'fetched') {
    return {
      state: 'fail',
      word: 'Policy not readable',
      detail: policy?.detail ? clip(policy.detail, 160) : 'The record is published but its policy file could not be fetched.',
    };
  }
  if (policy.mode === 'enforce') return { state: 'pass', word: 'enforce', detail: 'Sending servers must use verified TLS.' };
  if (policy.mode === 'testing') return { state: 'warn', word: 'testing', detail: 'TLS failures are reported, not refused.' };
  return { state: 'warn', word: policy.mode ?? 'No mode', detail: 'The policy does not ask for TLS.' };
}

function readTlsRpt(result: ScanResult): CheckReading & { record: string | null } {
  const tlsRpt = result.tlsRpt;
  if (!tlsRpt) return { ...unchecked('This check was made before TLS-RPT was read.'), record: null };
  const record = tlsRpt.record ?? null;
  if (tlsRpt.status === 'error') return { ...lookupFailed(tlsRpt.error), record };
  if (tlsRpt.status === 'missing') return { state: 'absent', word: 'Not published', detail: null, record };
  if (!tlsRpt.valid) {
    return { state: 'fail', word: 'Not valid', detail: tlsRpt.problems[0] ? clip(tlsRpt.problems[0], 160) : null, record };
  }
  const targets = tlsRpt.mailtoTargets.length + tlsRpt.httpsTargets.length;
  return { state: 'pass', word: 'Published', detail: `Reports to ${plural(targets, 'address', 'addresses')}.`, record };
}

function readBimi(result: ScanResult): CheckReading & { record: string | null } {
  const bimi = result.bimi;
  if (!bimi) return { ...unchecked('This check was made before BIMI was read.'), record: null };
  const record = bimi.record ?? null;
  if (bimi.status === 'error') return { ...lookupFailed(bimi.error), record };
  if (bimi.status === 'missing') return { state: 'absent', word: 'Not published', detail: null, record };
  if (bimi.declined) return { state: 'absent', word: 'Declined', detail: 'The record opts out of BIMI.', record };
  if (bimi.problems.length > 0 || (bimi.logo && bimi.logo.status !== 'fetched')) {
    return {
      state: 'warn',
      word: 'Has problems',
      detail: bimi.problems[0] ? clip(bimi.problems[0], 160) : 'The logo could not be fetched.',
      record,
    };
  }
  if (!bimi.dmarc.qualifies && !bimi.dmarc.dependsOnParent) {
    return { state: 'warn', word: 'Not shown', detail: 'Published, but the DMARC policy is not strict enough for a logo to show.', record };
  }
  return {
    state: 'pass',
    word: 'Published',
    detail: bimi.authorityUrl ? 'Logo and certificate URL published.' : 'Logo published, without a certificate.',
    record,
  };
}

/**
 * Turns the newest stored check into readings.
 *
 * `isOurs` answers whether a report address is this service's, and is passed
 * in so this file stays free of configuration.
 */
export function readPosture(
  result: ScanResult | null,
  checkedAt: Date | null,
  isOurs: (uri: string) => boolean,
): DomainPostureReading {
  if (!result || !result.dmarc || !result.spf || !result.dkim) {
    const none = unchecked('No completed DNS check is held for this domain yet.');
    return {
      checkedAt: null,
      dmarc: { ...none, word: 'Not checked yet', policy: null, level: null, testing: false, record: null, reporting: 'unknown' },
      spf: { ...none, word: 'Not checked yet', record: null },
      dkim: { ...none, word: 'Not checked yet', selectors: [] },
      mtaSts: { ...none, word: 'Not checked yet' },
      tlsRpt: { ...none, word: 'Not checked yet', record: null },
      bimi: { ...none, word: 'Not checked yet', record: null },
      issues: [],
    };
  }

  return {
    checkedAt: checkedAt ? checkedAt.toISOString() : null,
    dmarc: readDmarc(result, isOurs),
    spf: readSpf(result),
    dkim: readDkim(result),
    mtaSts: readMtaSts(result),
    tlsRpt: readTlsRpt(result),
    bimi: readBimi(result),
    issues: (result.issues ?? [])
      .filter((issue): issue is typeof issue & { severity: 'error' | 'warning' } =>
        issue.severity === 'error' || issue.severity === 'warning',
      )
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
      .slice(0, 8)
      .map((issue) => ({ severity: issue.severity, title: clip(issue.title, 140) })),
  };
}

/**
 * One line of DMARC policy history.
 *
 * The change history is written by the monitor in its own voice ("Our report
 * address..."), which reads wrongly in a document an agency publishes under its
 * own name. Those two sentences are restated; every other summary is quoted.
 */
export function historySummary(code: string, summary: string): string {
  if (code === 'dmarc_rua_ours_removed') return 'The monitoring report address was removed from rua.';
  if (code === 'dmarc_rua_ours_added') return 'The monitoring report address was added to rua.';
  return summary;
}

/** "p=reject" or "p=quarantine, testing", for a proposal's from and to. */
export function policyLabel(policy: string, testing: boolean): string {
  return `p=${policy}${testing ? ', testing' : ''}`;
}

/** Plain English for a sender count line. */
export function senderLine(input: { sources: number; approved: number; notOurs: number; unreviewed: number }): string {
  if (input.sources === 0) return 'No sending sources were seen in the reports.';
  const parts = [
    `${plural(input.approved, 'source')} approved`,
    `${input.notOurs.toLocaleString('en-GB')} marked not ours`,
    `${input.unreviewed.toLocaleString('en-GB')} not yet reviewed`,
  ];
  return `${plural(input.sources, 'sending source')}: ${parts.join(', ')}.`;
}

/**
 * Whole-number percentage with one decimal below 100, never rounded up to 100
 * and never shown for zero messages.
 */
export function shareText(part: number, whole: number): string {
  if (whole <= 0) return 'Nil';
  const value = (part / whole) * 100;
  if (part === whole) return '100%';
  const floored = Math.floor(value * 10) / 10;
  return `${floored.toFixed(1)}%`;
}

/** 4 December 2026, in UTC, so a document reads the same wherever it is opened. */
export function longDate(value: Date | string | null): string {
  if (!value) return 'Nil';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return 'Nil';
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** 4 Dec 2026, for table cells. */
export function shortDate(value: Date | string | null): string {
  if (!value) return 'Nil';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return 'Nil';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** 4 December 2026, 14:05 UTC. */
export function instantText(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${longDate(date)}, ${hh}:${mm} UTC`;
}
