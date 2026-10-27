import { isOurAddress } from '../report-address.service.js';
import { spfAllQualifier } from '../hosted-dns/spf/terms.js';
import type { DmarcResult, ScanResult } from '../../scanner/types.js';

export type DnsChangeKind =
  | 'DMARC_RECORD'
  | 'DMARC_POLICY'
  | 'DMARC_RUA'
  | 'SPF_RECORD'
  | 'SPF_LOOKUPS'
  | 'SPF_ALL'
  | 'DKIM_SELECTOR'
  | 'MX'
  | 'MTA_STS'
  | 'TLS_RPT'
  | 'BIMI';

export type DnsChangeSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface DnsChangeDraft {
  kind: DnsChangeKind;
  severity: DnsChangeSeverity;
  code: string;
  summary: string;
  before: Record<string, unknown> | unknown[] | null;
  after: Record<string, unknown> | unknown[] | null;
}

const policyLevel = { none: 0, quarantine: 1, reject: 2 } as const;

function levelOf(value: string | undefined | null): number | null {
  if (!value) return null;
  const normalised = value.trim().toLowerCase();
  return normalised in policyLevel ? policyLevel[normalised as keyof typeof policyLevel] : null;
}

function levelName(level: number): string {
  return level === 2 ? 'reject' : level === 1 ? 'quarantine' : 'none';
}

/**
 * The policy receivers actually apply.
 *
 * `effectivePolicy` already accounts for t=y in current scans. An old stored
 * scan may predate that field, so testing is applied here as well rather than
 * treating a missing field as "no change".
 */
function effectivePolicyLevel(dmarc: DmarcResult): number | null {
  const explicit = levelOf(dmarc.effectivePolicy);
  if (explicit !== null) {
    return explicit;
  }
  const base = levelOf(dmarc.policy);
  if (base === null) {
    return null;
  }
  if (dmarc.testing && base > 0) {
    return base - 1;
  }
  return base;
}

function effectiveSpLevel(dmarc: DmarcResult): number | null {
  return levelOf(dmarc.tags?.sp) ?? levelOf(dmarc.tags?.p);
}

function effectiveNpLevel(dmarc: DmarcResult): number | null {
  return levelOf(dmarc.tags?.np) ?? levelOf(dmarc.tags?.sp) ?? levelOf(dmarc.tags?.p);
}

function normaliseRecord(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/\s+/g, ' ').trim();
}

function ruaDataKnown(dmarc: DmarcResult): boolean {
  return Array.isArray(dmarc.aggregateMailtoTargets) && Array.isArray(dmarc.aggregateWebTargets);
}

function ruaUris(dmarc: DmarcResult): string[] {
  return [...(dmarc.aggregateMailtoTargets ?? []), ...(dmarc.aggregateWebTargets ?? [])]
    .map((uri) => uri.trim())
    .filter(Boolean);
}

function nonOurs(uris: string[]): string[] {
  return uris.filter((uri) => !isOurAddress(uri));
}

function sameSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function list(values: string[]): string {
  if (values.length === 0) return 'none';
  if (values.length === 1) return values[0]!;
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

const ALL_PERMISSIVENESS: Record<string, number> = { '-all': 0, '~all': 1, '?all': 2, '+all': 3 };

function mxHosts(mx: ScanResult['mx']): string[] {
  return mx.records.map((record) => record.exchange.trim().toLowerCase()).filter(Boolean).sort();
}

/**
 * Every meaningful difference between two completed scans.
 *
 * Pure and deterministic: no DNS, no clock, no database. A field an old stored
 * scan never wrote is unknown and produces nothing, because turning absence of
 * evidence into "it was removed" is exactly the false alarm this history must
 * not raise.
 */
export function diffScans(previous: ScanResult, current: ScanResult): DnsChangeDraft[] {
  const record: DnsChangeDraft[] = [];
  const policy: DnsChangeDraft[] = [];
  const rua: DnsChangeDraft[] = [];
  const spf: DnsChangeDraft[] = [];
  const lookups: DnsChangeDraft[] = [];
  const spfAll: DnsChangeDraft[] = [];
  const dkim: DnsChangeDraft[] = [];
  const mx: DnsChangeDraft[] = [];
  const mtaSts: DnsChangeDraft[] = [];
  const tlsRpt: DnsChangeDraft[] = [];
  const bimi: DnsChangeDraft[] = [];

  const prevDmarc = previous.dmarc;
  const curDmarc = current.dmarc;

  if (prevDmarc.status === 'found' && curDmarc.status === 'missing') {
    record.push({
      kind: 'DMARC_RECORD',
      severity: 'CRITICAL',
      code: 'dmarc_record_removed',
      summary: 'The DMARC record was removed.',
      before: { record: prevDmarc.record ?? null },
      after: null,
    });
  } else if (prevDmarc.status === 'missing' && curDmarc.status === 'found') {
    record.push({
      kind: 'DMARC_RECORD',
      severity: 'INFO',
      code: 'dmarc_record_added',
      summary: 'A DMARC record was published.',
      before: null,
      after: { record: curDmarc.record ?? null },
    });
  } else if (prevDmarc.status === 'found' && curDmarc.status === 'error' && curDmarc.record) {
    /**
     * Read, but no longer usable.
     *
     * The scanner answers `error` with the record text when a second v=DMARC1
     * record was published, the version tag was mistyped, or the policy no
     * longer applies. Receivers discard such a record, so the domain has no
     * DMARC policy at all: as serious as a removal. `error` without a record
     * is a failed lookup, which is unknown and reports nothing.
     */
    record.push({
      kind: 'DMARC_RECORD',
      severity: 'CRITICAL',
      code: 'dmarc_record_invalid',
      summary: 'The DMARC record is no longer valid, so receivers ignore it and the domain has no DMARC policy.',
      before: { record: prevDmarc.record ?? null },
      after: { record: curDmarc.record },
    });
  } else if (prevDmarc.status === 'error' && prevDmarc.record && curDmarc.status === 'found') {
    record.push({
      kind: 'DMARC_RECORD',
      severity: 'INFO',
      code: 'dmarc_record_repaired',
      summary: 'The DMARC record is valid again.',
      before: { record: prevDmarc.record },
      after: { record: curDmarc.record ?? null },
    });
  }

  if (ruaDataKnown(prevDmarc) && ruaDataKnown(curDmarc)) {
    const prevUris = ruaUris(prevDmarc);
    const curUris = ruaUris(curDmarc);
    const prevOurs = prevUris.some((uri) => isOurAddress(uri));
    const curOurs = curUris.some((uri) => isOurAddress(uri));

    if (prevOurs && !curOurs) {
      rua.push({
        kind: 'DMARC_RUA',
        severity: 'CRITICAL',
        code: 'dmarc_rua_ours_removed',
        summary: 'Our report address was removed from rua.',
        before: { uris: prevUris },
        after: { uris: curUris },
      });
    } else if (!prevOurs && curOurs) {
      rua.push({
        kind: 'DMARC_RUA',
        severity: 'INFO',
        code: 'dmarc_rua_ours_added',
        summary: 'Our report address was added to rua.',
        before: { uris: prevUris },
        after: { uris: curUris },
      });
    }

    const prevOthers = nonOurs(prevUris);
    const curOthers = nonOurs(curUris);
    if (!sameSet(prevOthers, curOthers)) {
      const added = curOthers.filter((uri) => !prevOthers.includes(uri));
      const removed = prevOthers.filter((uri) => !curOthers.includes(uri));
      rua.push({
        kind: 'DMARC_RUA',
        severity: 'INFO',
        code: 'dmarc_rua_changed',
        summary: `Report addresses changed: added ${list(added)}; removed ${list(removed)}.`,
        before: { uris: prevOthers },
        after: { uris: curOthers },
      });
    }
  }

  if (prevDmarc.status === 'found' && curDmarc.status === 'found') {
    const prevLevel = effectivePolicyLevel(prevDmarc);
    const curLevel = effectivePolicyLevel(curDmarc);

    if (prevLevel !== null && curLevel !== null && prevLevel !== curLevel) {
      const weakened = curLevel < prevLevel;
      policy.push({
        kind: 'DMARC_POLICY',
        severity: weakened ? 'CRITICAL' : 'INFO',
        code: weakened ? 'dmarc_policy_weakened' : 'dmarc_policy_strengthened',
        summary: `The DMARC policy ${weakened ? 'weakened' : 'strengthened'} from p=${levelName(prevLevel)} to p=${levelName(curLevel)}.`,
        before: { p: levelName(prevLevel), testing: prevDmarc.testing === true },
        after: { p: levelName(curLevel), testing: curDmarc.testing === true },
      });
    }

    const prevSp = effectiveSpLevel(prevDmarc);
    const curSp = effectiveSpLevel(curDmarc);
    const prevNp = effectiveNpLevel(prevDmarc);
    const curNp = effectiveNpLevel(curDmarc);
    /**
     * Only a subdomain policy that is written down is its own change.
     *
     * With no sp= or np= in either record the subdomain policy is just p, so a
     * p=reject to p=none edit already raised one critical change. Reporting the
     * inherited drop as well sent two alerts for one edit.
     */
    const spWritten = prevDmarc.tags?.sp !== undefined || curDmarc.tags?.sp !== undefined;
    const npWritten = spWritten || prevDmarc.tags?.np !== undefined || curDmarc.tags?.np !== undefined;
    const spDropped = spWritten && prevSp !== null && curSp !== null && curSp < prevSp;
    const npDropped = npWritten && prevNp !== null && curNp !== null && curNp < prevNp;

    if (spDropped || npDropped) {
      const parts: string[] = [];
      if (spDropped) parts.push(`sp=${levelName(prevSp!)} to sp=${levelName(curSp!)}`);
      if (npDropped) parts.push(`np=${levelName(prevNp!)} to np=${levelName(curNp!)}`);
      policy.push({
        kind: 'DMARC_POLICY',
        severity: 'WARNING',
        code: 'dmarc_subdomain_policy_weakened',
        summary: `The subdomain policy weakened (${parts.join('; ')}).`,
        before: {
          sp: prevSp === null ? null : levelName(prevSp),
          np: prevNp === null ? null : levelName(prevNp),
        },
        after: {
          sp: curSp === null ? null : levelName(curSp),
          np: curNp === null ? null : levelName(curNp),
        },
      });
    }

    const prevRecord = normaliseRecord(prevDmarc.record);
    const curRecord = normaliseRecord(curDmarc.record);
    if (prevRecord && curRecord && prevRecord !== curRecord && policy.length === 0 && rua.length === 0) {
      record.push({
        kind: 'DMARC_RECORD',
        severity: 'INFO',
        code: 'dmarc_record_changed',
        summary: 'The DMARC record changed.',
        before: { record: prevDmarc.record ?? null },
        after: { record: curDmarc.record ?? null },
      });
    }
  }

  if (previous.spf.status === 'found' && current.spf.status === 'missing') {
    spf.push({
      kind: 'SPF_RECORD',
      severity: 'CRITICAL',
      code: 'spf_record_removed',
      summary: 'The SPF record was removed.',
      before: { record: previous.spf.record ?? null },
      after: null,
    });
  } else if (previous.spf.status === 'missing' && current.spf.status === 'found') {
    spf.push({
      kind: 'SPF_RECORD',
      severity: 'INFO',
      code: 'spf_record_added',
      summary: 'An SPF record was published.',
      before: null,
      after: { record: current.spf.record ?? null },
    });
  } else if (previous.spf.status === 'found' && current.spf.status === 'error' && current.spf.record) {
    // Two v=spf1 records at one name is a permerror (RFC 7208 section 4.5):
    // receivers stop evaluating SPF, which fails every sender.
    spf.push({
      kind: 'SPF_RECORD',
      severity: 'CRITICAL',
      code: 'spf_record_invalid',
      summary: 'More than one SPF record is now published, so receivers treat SPF as a permanent error.',
      before: { record: previous.spf.record ?? null },
      after: { record: current.spf.record },
    });
  } else if (previous.spf.status === 'found' && current.spf.status === 'found') {
    const prevRecord = normaliseRecord(previous.spf.record);
    const curRecord = normaliseRecord(current.spf.record);
    if (prevRecord && curRecord && prevRecord !== curRecord) {
      spf.push({
        kind: 'SPF_RECORD',
        severity: 'INFO',
        code: 'spf_record_changed',
        summary: 'The SPF record changed.',
        before: { record: previous.spf.record ?? null },
        after: { record: current.spf.record ?? null },
      });
    }
  }

  /**
   * Compared only between scans that counted lookups the same way.
   *
   * Scans stored before recursive SPF counting counted only the top-level
   * terms. Comparing one of those with a recursive count reports "SPF now
   * exceeds the limit" on the first scan after an upgrade when nothing in DNS
   * changed. `lookupTree` is written only by the recursive count.
   */
  if (
    Array.isArray(previous.spf.lookupTree) &&
    Array.isArray(current.spf.lookupTree) &&
    previous.spf.lookupLimitExceeded !== undefined &&
    current.spf.lookupLimitExceeded !== undefined &&
    previous.spf.lookupLimitExceeded !== current.spf.lookupLimitExceeded
  ) {
    const exceeded = current.spf.lookupLimitExceeded;
    lookups.push({
      kind: 'SPF_LOOKUPS',
      severity: exceeded ? 'CRITICAL' : 'INFO',
      code: exceeded ? 'spf_lookup_limit_exceeded' : 'spf_lookup_limit_cleared',
      summary: exceeded
        ? `SPF now exceeds the 10-lookup limit (${current.spf.lookupCount} lookups).`
        : `SPF is back within the 10-lookup limit (${current.spf.lookupCount} lookups).`,
      before: { lookupCount: previous.spf.lookupCount, exceeded: previous.spf.lookupLimitExceeded },
      after: { lookupCount: current.spf.lookupCount, exceeded: current.spf.lookupLimitExceeded },
    });
  }

  if (previous.spf.status === 'found' && current.spf.status === 'found' && previous.spf.record && current.spf.record) {
    const prevAll = spfAllQualifier(previous.spf.record);
    const curAll = spfAllQualifier(current.spf.record);
    if ((ALL_PERMISSIVENESS[curAll] ?? 0) > (ALL_PERMISSIVENESS[prevAll] ?? 0)) {
      spfAll.push({
        kind: 'SPF_ALL',
        severity: 'WARNING',
        code: 'spf_all_weakened',
        summary: `The SPF all qualifier changed from ${prevAll} to ${curAll}, which is more permissive.`,
        before: { all: prevAll },
        after: { all: curAll },
      });
    }
  }

  const prevSelectors = Array.isArray(previous.dkim.selectors) ? previous.dkim.selectors : null;
  const curSelectors = Array.isArray(current.dkim.selectors) ? current.dkim.selectors : null;
  /**
   * A DKIM lookup that errored is unknown, not empty.
   *
   * The scanner has no per-selector error marker, so a failed result and a
   * genuinely absent key produce the same empty selector list. Reporting a
   * removal from that would tell a customer their working key was deleted when
   * the resolver merely timed out.
   */
  if (previous.dkim.status !== 'error' && current.dkim.status !== 'error' && prevSelectors && curSelectors) {
    const checked = Array.isArray(current.dkim.checkedSelectors) ? current.dkim.checkedSelectors : null;
    const skipped = new Set(current.dkim.skippedSelectors ?? []);
    const revoked = new Set(current.dkim.revokedSelectors ?? []);

    if (checked) {
      const checkedSet = new Set(checked);
      for (const selector of prevSelectors) {
        if (!checkedSet.has(selector) || curSelectors.includes(selector) || skipped.has(selector)) {
          continue;
        }
        const wasRevoked = revoked.has(selector);
        dkim.push({
          kind: 'DKIM_SELECTOR',
          severity: 'WARNING',
          code: 'dkim_selector_removed',
          summary: wasRevoked
            ? `DKIM selector ${selector} was removed and its key is now revoked.`
            : `DKIM selector ${selector} was removed.`,
          before: { selector },
          after: wasRevoked ? { selector, revoked: true } : null,
        });
      }
    }

    for (const selector of curSelectors) {
      if (!prevSelectors.includes(selector)) {
        dkim.push({
          kind: 'DKIM_SELECTOR',
          severity: 'INFO',
          code: 'dkim_selector_added',
          summary: `DKIM selector ${selector} was added.`,
          before: null,
          after: { selector },
        });
      }
    }
  }

  if (
    previous.mx.status !== 'error' &&
    current.mx.status !== 'error' &&
    Array.isArray(previous.mx.records) &&
    Array.isArray(current.mx.records)
  ) {
    const prevHosts = mxHosts(previous.mx);
    const curHosts = mxHosts(current.mx);
    if (prevHosts.length > 0 && curHosts.length === 0) {
      mx.push({
        kind: 'MX',
        severity: 'WARNING',
        code: 'mx_removed',
        summary: 'MX records were removed.',
        before: { hosts: prevHosts },
        after: null,
      });
    } else if (!sameSet(prevHosts, curHosts)) {
      mx.push({
        kind: 'MX',
        severity: 'INFO',
        code: 'mx_changed',
        summary: `MX records changed from ${list(prevHosts)} to ${list(curHosts)}.`,
        before: { hosts: prevHosts },
        after: { hosts: curHosts },
      });
    }
  }

  if (
    previous.mtaSts &&
    current.mtaSts &&
    previous.mtaSts.status !== 'error' &&
    current.mtaSts.status !== 'error'
  ) {
    const prev = previous.mtaSts;
    const cur = current.mtaSts;
    if (prev.status === 'found' && cur.status === 'missing') {
      mtaSts.push({
        kind: 'MTA_STS',
        severity: 'WARNING',
        code: 'mta_sts_removed',
        summary: 'The MTA-STS record was removed.',
        before: { record: prev.record ?? null },
        after: null,
      });
    } else if (prev.status === 'missing' && cur.status === 'found') {
      mtaSts.push({
        kind: 'MTA_STS',
        severity: 'INFO',
        code: 'mta_sts_added',
        summary: 'An MTA-STS record was published.',
        before: null,
        after: { record: cur.record ?? null },
      });
    }

    const prevMode = prev.policy?.status === 'fetched' ? prev.policy.mode : undefined;
    const curMode = cur.policy?.status === 'fetched' ? cur.policy.mode : undefined;
    const modeLevel = { none: 0, testing: 1, enforce: 2 } as const;
    if (prevMode && curMode && prevMode !== curMode) {
      const weakened = modeLevel[curMode] < modeLevel[prevMode];
      mtaSts.push({
        kind: 'MTA_STS',
        severity: weakened ? 'WARNING' : 'INFO',
        code: weakened ? 'mta_sts_mode_weakened' : 'mta_sts_mode_strengthened',
        summary: `The MTA-STS policy ${weakened ? 'weakened' : 'strengthened'} from ${prevMode} to ${curMode}.`,
        before: { mode: prevMode },
        after: { mode: curMode },
      });
    }

    if (prev.policy?.status === 'fetched' && cur.policy?.status === 'invalid') {
      mtaSts.push({
        kind: 'MTA_STS',
        severity: 'WARNING',
        code: 'mta_sts_policy_broken',
        summary: 'The MTA-STS policy was fetched before but is now invalid.',
        before: { mode: prev.policy.mode ?? null },
        after: { problems: cur.policy.problems },
      });
    }
  }

  if (
    previous.tlsRpt &&
    current.tlsRpt &&
    previous.tlsRpt.status !== 'error' &&
    current.tlsRpt.status !== 'error'
  ) {
    const prev = previous.tlsRpt;
    const cur = current.tlsRpt;
    if (prev.status === 'found' && cur.status === 'missing') {
      tlsRpt.push({
        kind: 'TLS_RPT',
        severity: 'WARNING',
        code: 'tls_rpt_removed',
        summary: 'The TLS-RPT record was removed.',
        before: { record: prev.record ?? null },
        after: null,
      });
    } else if (prev.status === 'missing' && cur.status === 'found') {
      tlsRpt.push({
        kind: 'TLS_RPT',
        severity: 'INFO',
        code: 'tls_rpt_added',
        summary: 'A TLS-RPT record was published.',
        before: null,
        after: { record: cur.record ?? null },
      });
    } else if (prev.status === 'found' && cur.status === 'found') {
      const prevUris = [...prev.mailtoTargets, ...prev.httpsTargets].sort();
      const curUris = [...cur.mailtoTargets, ...cur.httpsTargets].sort();
      if (!sameSet(prevUris, curUris)) {
        tlsRpt.push({
          kind: 'TLS_RPT',
          severity: 'INFO',
          code: 'tls_rpt_changed',
          summary: `TLS-RPT report addresses changed from ${list(prevUris)} to ${list(curUris)}.`,
          before: { uris: prevUris },
          after: { uris: curUris },
        });
      }
    }
  }

  if (
    previous.bimi &&
    current.bimi &&
    previous.bimi.status !== 'error' &&
    current.bimi.status !== 'error'
  ) {
    const prev = previous.bimi;
    const cur = current.bimi;
    const prevOwn = prev.status === 'found' && !prev.inheritedFrom;
    if (prevOwn && cur.status === 'missing') {
      bimi.push({
        kind: 'BIMI',
        severity: 'WARNING',
        code: 'bimi_removed',
        summary: 'The BIMI record was removed.',
        before: { record: prev.record ?? null },
        after: null,
      });
    } else if (prev.status === 'missing' && cur.status === 'found') {
      bimi.push({
        kind: 'BIMI',
        severity: 'INFO',
        code: 'bimi_added',
        summary: 'A BIMI record was published.',
        before: null,
        after: { record: cur.record ?? null },
      });
    } else if (prev.status === 'found' && cur.status === 'found') {
      if (prev.logoUrl !== cur.logoUrl || prev.authorityUrl !== cur.authorityUrl) {
        bimi.push({
          kind: 'BIMI',
          severity: 'INFO',
          code: 'bimi_changed',
          summary: 'The BIMI logo or certificate URL changed.',
          before: { logoUrl: prev.logoUrl, authorityUrl: prev.authorityUrl },
          after: { logoUrl: cur.logoUrl, authorityUrl: cur.authorityUrl },
        });
      }
    }
  }

  return [...record, ...policy, ...rua, ...spf, ...lookups, ...spfAll, ...dkim, ...mx, ...mtaSts, ...tlsRpt, ...bimi];
}

/** The policy tags published in a scan, for the policy.changed webhook. */
export function policyTags(result: ScanResult): { p: string | null; sp: string | null; np: string | null; testing: boolean } {
  return {
    p: result.dmarc.tags?.p ?? null,
    sp: result.dmarc.tags?.sp ?? null,
    np: result.dmarc.tags?.np ?? null,
    testing: result.dmarc.testing === true,
  };
}

/** Which way a DMARC policy change went, for policy.changed. */
export function policyDirection(
  previous: ScanResult,
  current: ScanResult,
): 'weakened' | 'strengthened' | 'changed' {
  const prev = previous.dmarc;
  const cur = current.dmarc;
  const prevP = effectivePolicyLevel(prev);
  const curP = effectivePolicyLevel(cur);
  const prevSp = effectiveSpLevel(prev);
  const curSp = effectiveSpLevel(cur);
  const prevNp = effectiveNpLevel(prev);
  const curNp = effectiveNpLevel(cur);

  let weaker = false;
  let stronger = false;
  for (const [before, after] of [
    [prevP, curP],
    [prevSp, curSp],
    [prevNp, curNp],
  ] as const) {
    if (before === null || after === null) continue;
    if (after < before) weaker = true;
    if (after > before) stronger = true;
  }

  if (weaker) return 'weakened';
  if (stronger) return 'strengthened';
  return 'changed';
}
