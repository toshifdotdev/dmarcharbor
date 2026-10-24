import { parseDmarcTags } from '../../scanner/dmarc-tags.js';
import { isOurAddress, normaliseReportUri } from '../report-address.service.js';
import { readRuaUris } from './record-rewrite.js';

export type SwitchStatus = 'PLANNED' | 'DUAL_REPORTING' | 'CUT_OVER';

export type SwitchIssueCode =
  | 'our_address_missing'
  | 'incumbent_reappeared'
  | 'record_missing'
  | 'multiple_records'
  | 'authorization_missing'
  | 'lookup_failed';

/** One fixed sentence per code, returned as `{ code, message }` by the API. */
export const switchIssueMessages: Record<SwitchIssueCode, string> = {
  our_address_missing: 'The DMARC record in DNS no longer includes the DMARC Harbor report address.',
  incumbent_reappeared: "The previous provider's report address is back in the record after cutover.",
  record_missing: 'No DMARC record is published at _dmarc for this domain.',
  multiple_records: 'More than one DMARC record is published, so receivers ignore all of them.',
  authorization_missing: 'The report domain has not authorised this domain to send it reports.',
  lookup_failed: 'The DNS lookup failed. Try again in a few minutes.',
};

export type SwitchRecordObservation =
  | { kind: 'found'; record: string }
  | { kind: 'no_record' }
  | { kind: 'multiple_records' }
  | { kind: 'lookup_failed' };

export interface SwitchStateRow {
  status: SwitchStatus;
  startedAt: Date | null;
  cutOverAt: Date | null;
  /**
   * The rua URIs recorded as the incumbent's when the switch was planned.
   *
   * The incumbent is these addresses, not "anything that is not ours". An
   * address the customer adds later (an email platform, their own mailbox)
   * would otherwise hold a domain in dual reporting for ever, or report a
   * finished cutover as the incumbent reappearing. Empty falls back to any
   * address that is not ours, for a row planned without targets.
   */
  incumbentTargets?: readonly string[];
}

/** One comparable form for a report URI: the bare address, or the lowercased URI. */
function comparableUri(uri: string): string {
  return normaliseReportUri(uri) ?? uri.trim().toLowerCase();
}

export interface SwitchState {
  status: SwitchStatus;
  startedAt: Date | null;
  cutOverAt: Date | null;
  issues: SwitchIssueCode[];
  transitioned: 'started' | 'cut_over' | null;
}

function ruaUris(record: string): string[] {
  return readRuaUris(parseDmarcTags(record).rua ?? '');
}

/**
 * Moves a switch row according to what DNS shows now.
 *
 * The record decides the state, never a button. A user can skip dual reporting
 * by publishing the cutover record directly, and a cutover cannot be undone by
 * a stale page: if an incumbent address reappears afterwards the row stays
 * CUT_OVER and says so, because going backwards is a decision for a person.
 */
export function nextSwitchState(
  row: SwitchStateRow,
  observation: SwitchRecordObservation,
  now: Date,
): SwitchState {
  const base = {
    status: row.status,
    startedAt: row.startedAt,
    cutOverAt: row.cutOverAt,
    issues: [] as SwitchIssueCode[],
    transitioned: null as 'started' | 'cut_over' | null,
  };

  if (observation.kind === 'no_record') {
    return { ...base, issues: ['record_missing'] };
  }

  if (observation.kind === 'multiple_records') {
    return { ...base, issues: ['multiple_records'] };
  }

  if (observation.kind === 'lookup_failed') {
    return { ...base, issues: ['lookup_failed'] };
  }

  const uris = ruaUris(observation.record);
  const ours = uris.some((uri) => isOurAddress(uri));
  const incumbent = new Set((row.incumbentTargets ?? []).map(comparableUri));
  const hasIncumbent =
    incumbent.size > 0
      ? uris.some((uri) => incumbent.has(comparableUri(uri)))
      : uris.some((uri) => !isOurAddress(uri));

  if (!ours) {
    const issues: SwitchIssueCode[] = ['our_address_missing'];
    if (row.status === 'CUT_OVER' && hasIncumbent) {
      issues.push('incumbent_reappeared');
    }
    return { ...base, issues };
  }

  if (hasIncumbent) {
    if (row.status === 'CUT_OVER') {
      return { ...base, issues: ['incumbent_reappeared'] };
    }

    if (row.status === 'DUAL_REPORTING') {
      return base;
    }

    return {
      ...base,
      status: 'DUAL_REPORTING',
      startedAt: row.startedAt ?? now,
      transitioned: 'started',
    };
  }

  return {
    ...base,
    status: 'CUT_OVER',
    cutOverAt: row.cutOverAt ?? now,
    transitioned: row.status === 'CUT_OVER' ? null : 'cut_over',
  };
}

/**
 * What a completed scan saw at _dmarc, in the terms a switch row understands.
 *
 * The scanner reports two published records as `error` with both joined into
 * `record`, and a resolver failure as `error` with no record. Passing the raw
 * `record` on would read the joined string as one record, and read a failed
 * lookup as "no record", which is a different and alarming issue.
 */
export function switchObservationFromScan(dmarc: {
  status: string;
  record?: string;
  notices?: readonly { code: string }[];
}): SwitchRecordObservation {
  if (dmarc.status === 'found' && dmarc.record?.trim()) {
    return { kind: 'found', record: dmarc.record };
  }

  if (dmarc.status === 'missing') {
    return { kind: 'no_record' };
  }

  const codes = new Set((dmarc.notices ?? []).map((notice) => notice.code));
  if (codes.has('dmarc_multiple_records')) {
    return { kind: 'multiple_records' };
  }

  // A record the scanner read but receivers discard (it does not begin with
  // v=DMARC1, or its policy does not apply) is, for a switch, the same as no
  // record at all: nothing will report from it.
  if (dmarc.record?.trim()) {
    return { kind: 'no_record' };
  }

  return { kind: 'lookup_failed' };
}
