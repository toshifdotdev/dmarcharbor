import { isIP } from 'node:net';
import { prisma } from '../database/prisma.js';
import type { DnsReader, SpfLookupNode } from '../models/scan.model.js';
import { systemDnsReader } from '../scanner/dns.js';
import { parseSpfRecords } from '../scanner/scanner.js';
import { evaluateSpfLookups } from '../scanner/spf-evaluate.js';
import { domainRef } from './domain-ref.js';
import { sourcesFromRecord } from './hosted-dns/spf/apex.js';
import { flattenSources, type SourceOutcome, type SpfSource } from './hosted-dns/spf/flatten.js';
import { contains, parseCidr, type ParsedCidr } from './hosted-dns/spf/networks.js';
import { normaliseIpAddress } from './senders/ip-intel.service.js';

/**
 * Which parts of a domain's SPF record carried any mail.
 *
 * Every source in the record (include, a, mx, ip4, ip6) is resolved to the
 * networks it authorises, and the sending addresses in the domain's aggregate
 * reports are matched against them. A source no reported message came from in
 * the window is a candidate to remove: an include left behind by a service the
 * client stopped using still costs DNS lookups toward the limit of 10, and
 * still authorises that service's whole network to send as the client.
 *
 * Deliberately cautious about calling something unused:
 *  - only after reports on at least `minimumReportDays` days of the window,
 *    so a new domain is never told to delete its mail provider;
 *  - a source whose networks cannot be known in advance (exists, ptr, a
 *    macro, a lookup that failed) is "unresolved", never "unused";
 *  - matching is by address only, whatever SPF said for that message, so a
 *    service sending with its own bounce domain still counts as used.
 *
 * A domain on managed SPF is read from its managed sources and the networks
 * last resolved for them, with no DNS lookups. Any other domain is read from
 * the SPF record published right now.
 */

export const spfUsageWindowDays = 90;
export const minimumReportDays = 14;
/** The busiest addresses only; a domain rarely has more distinct senders. */
const ipLimit = 20_000;

export type SpfSourceStatus = 'used' | 'unused' | 'insufficient_data' | 'unresolved';

export interface SpfSourceUsage {
  /** The term as it reads in a record, e.g. include:_spf.google.com. */
  term: string;
  kind: SpfSource['kind'];
  value: string;
  status: SpfSourceStatus;
  /** Networks the source resolved to. */
  networkCount: number;
  messages: number;
  /** Of those, messages the receiver's DMARC evaluation recorded as an SPF pass. */
  spfPassMessages: number;
  /** Distinct sending addresses inside the source's networks. */
  matchedIps: number;
  /** DNS lookups the source costs a receiver; removing it frees these. */
  lookups: number | null;
  /** Why a source is unresolved, in plain words. */
  reason: string | null;
}

export interface SpfUsage {
  domain: { id: string; name: string };
  /** Where the sources came from, or null when there is nothing to analyse. */
  origin: 'managed' | 'published' | null;
  record: string | null;
  windowDays: number;
  evidence: { reportDays: number; messages: number; ips: number; enough: boolean };
  /** Lookups the whole record costs; null for a managed record, which is flattened. */
  lookupCount: number | null;
  sources: SpfSourceUsage[];
  /** Mail from addresses no source covers: a sender missing from SPF, or a spoofer. */
  uncovered: { messages: number; ips: number };
  /** Why nothing could be analysed (no record, a record that cannot be read). */
  problem: string | null;
  checkedAt: string;
}

export class SpfUsageError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'SpfUsageError';
    this.code = code;
    this.status = status;
  }
}

let readerOverride: DnsReader | null = null;

/** Test seam for the DNS reads a published record needs. */
export function setSpfUsageReaderForTests(reader: DnsReader | null): void {
  readerOverride = reader;
}

function termOf(source: SpfSource): string {
  return `${source.kind}:${source.value}`;
}

/** include:x and redirect=x are the same cost key; a and mx key on their host. */
function lookupKey(kind: string, target: string): string {
  return `${kind}:${target.split('/')[0]!.trim().toLowerCase().replace(/\.$/, '')}`;
}

function keyOfNode(node: SpfLookupNode, domain: string): string | null {
  const term = node.term.replace(/^[+\-~?]/, '');
  const lower = term.toLowerCase();
  if (lower.startsWith('include:')) return lookupKey('include', term.slice('include:'.length));
  if (lower.startsWith('redirect=')) return lookupKey('include', term.slice('redirect='.length));
  for (const kind of ['a', 'mx'] as const) {
    if (lower === kind || lower.startsWith(`${kind}/`)) return lookupKey(kind, domain);
    if (lower.startsWith(`${kind}:`)) return lookupKey(kind, term.slice(kind.length + 1));
  }
  return null;
}

function keyOfSource(source: SpfSource, domain: string): string | null {
  if (source.kind === 'ip4' || source.kind === 'ip6') return null;
  const value = source.value.startsWith('/') ? domain : source.value;
  return lookupKey(source.kind, value);
}

function parseNetworks(list: string[]): ParsedCidr[] {
  return list
    .map((value) => {
      const family = isIP(value.split('/')[0]!.trim());
      return family === 4 || family === 6 ? parseCidr(value, family) : null;
    })
    .filter((network): network is ParsedCidr => network !== null);
}

interface Analysed {
  origin: 'managed' | 'published';
  record: string;
  outcomes: SourceOutcome[];
  lookupCount: number | null;
  lookupsBySource: Map<string, number>;
}

async function fromManaged(domainId: string): Promise<Analysed | null> {
  const row = await prisma.hostedSpfRecord.findUnique({
    where: { domainId },
    select: { status: true, sources: true, allQualifier: true, sourceState: true },
  });
  if (!row || (row.status !== 'ACTIVE' && row.status !== 'RELEASING')) return null;

  const sources = Array.isArray(row.sources)
    ? (row.sources as Array<Record<string, unknown>>).filter(
        (entry): entry is SpfSource =>
          Boolean(entry) &&
          typeof entry.value === 'string' &&
          ['include', 'ip4', 'ip6', 'a', 'mx'].includes(entry.kind as string),
      )
    : [];
  const state =
    row.sourceState && typeof row.sourceState === 'object' && !Array.isArray(row.sourceState)
      ? (row.sourceState as Record<string, { networks?: string[]; mode?: SourceOutcome['mode']; lookups?: number; reason?: string | null }>)
      : {};

  const lookupsBySource = new Map<string, number>();
  const outcomes = sources.map((source): SourceOutcome => {
    const saved = state[termOf(source)];
    const networks = Array.isArray(saved?.networks) ? saved.networks : [];
    lookupsBySource.set(termOf(source), saved?.lookups ?? 0);
    return {
      source,
      // A source whose last flatten failed keeps its last good networks, which
      // is also what the published chain still authorises.
      mode: networks.length > 0 ? 'flattened' : (saved?.mode ?? 'error'),
      networks,
      lookups: saved?.lookups ?? 0,
      reason: networks.length > 0 ? null : (saved?.reason ?? 'Not resolved yet.'),
    };
  });

  const record = ['v=spf1', ...sources.map(termOf), row.allQualifier].join(' ');
  return { origin: 'managed', record, outcomes, lookupCount: null, lookupsBySource };
}

async function fromPublished(domainName: string, reader: DnsReader): Promise<Analysed | { problem: string; record: string | null }> {
  const txt = await reader.resolveTxt(domainName);
  if (txt.status === 'error') {
    return { problem: 'The SPF record could not be read just now (DNS error). Try again in a few minutes.', record: null };
  }
  const spf = parseSpfRecords(txt.status === 'found' ? (txt.value ?? []) : []);
  if (spf.status === 'missing') {
    return { problem: `${domainName} publishes no SPF record.`, record: null };
  }
  if (spf.status !== 'found' || !spf.record) {
    return { problem: spf.error ?? `${domainName} publishes more than one SPF record, which receivers treat as an error.`, record: null };
  }

  const imported = sourcesFromRecord(spf.record, domainName);
  if (imported.error) {
    return { problem: imported.error.replace(/ Add sources by hand\.$/, ''), record: spf.record };
  }

  const [outcomes, evaluation] = await Promise.all([
    flattenSources(imported.sources, reader, { customerDomain: domainName, maxQueries: 120, deadlineMs: 10_000 }),
    evaluateSpfLookups(domainName, spf.record, reader, { maxQueries: 60, deadlineMs: 8_000 }),
  ]);

  const byKey = new Map<string, number>();
  for (const node of evaluation.tree) {
    const key = keyOfNode(node, domainName);
    if (key) byKey.set(key, (byKey.get(key) ?? 0) + node.lookups);
  }
  const lookupsBySource = new Map<string, number>();
  for (const source of imported.sources) {
    const key = keyOfSource(source, domainName);
    lookupsBySource.set(termOf(source), key ? (byKey.get(key) ?? 1) : 0);
  }

  return {
    origin: 'published',
    record: spf.record,
    outcomes,
    lookupCount: evaluation.complete ? evaluation.lookupCount : null,
    lookupsBySource,
  };
}

export async function analyseSpfUsage(
  organizationId: string,
  domainIdOrSlug: string,
  now = new Date(),
): Promise<SpfUsage> {
  const domain = await prisma.domain.findFirst({
    where: { client: { organizationId }, ...domainRef(domainIdOrSlug) },
    select: { id: true, name: true },
  });
  if (!domain) {
    throw new SpfUsageError('That domain is not in this workspace.', 'NOT_FOUND', 404);
  }

  const since = new Date(now.getTime() - spfUsageWindowDays * 24 * 60 * 60 * 1000);
  const [ipRows, dayRows] = await Promise.all([
    prisma.$queryRaw<Array<{ ip: string; messages: bigint; spfPass: bigint }>>`
      SELECT btrim(lower(rec."sourceIp")) AS "ip",
             SUM(rec."messageCount")::bigint AS "messages",
             SUM(CASE WHEN lower(rec."spfResult") = 'pass' THEN rec."messageCount" ELSE 0 END)::bigint AS "spfPass"
      FROM "dmarc_report_record" rec
      JOIN "dmarc_report" r ON r.id = rec."reportId"
      WHERE r."domainId" = ${domain.id}
        AND r."reportType" = 'AGGREGATE'
        AND r."dateRangeBegin" >= ${since}
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT ${ipLimit}
    `,
    prisma.$queryRaw<Array<{ days: bigint }>>`
      SELECT COUNT(DISTINCT date_trunc('day', r."dateRangeBegin"))::bigint AS "days"
      FROM "dmarc_report" r
      WHERE r."domainId" = ${domain.id}
        AND r."reportType" = 'AGGREGATE'
        AND r."dateRangeBegin" >= ${since}
    `,
  ]);

  const senders = ipRows
    .map((row) => {
      const ip = normaliseIpAddress(row.ip) ?? row.ip;
      const family = isIP(ip);
      const network = family === 4 || family === 6 ? parseCidr(ip, family) : null;
      return network ? { network, messages: Number(row.messages), spfPass: Number(row.spfPass) } : null;
    })
    .filter((row): row is { network: ParsedCidr; messages: number; spfPass: number } => row !== null);
  const reportDays = Number(dayRows[0]?.days ?? 0);
  const totalMessages = senders.reduce((sum, row) => sum + row.messages, 0);
  const enough = reportDays >= minimumReportDays;
  const evidence = { reportDays, messages: totalMessages, ips: senders.length, enough };

  const base = {
    domain,
    windowDays: spfUsageWindowDays,
    evidence,
    checkedAt: now.toISOString(),
  };

  const analysed =
    (await fromManaged(domain.id)) ?? (await fromPublished(domain.name, readerOverride ?? systemDnsReader));
  if ('problem' in analysed) {
    return {
      ...base,
      origin: analysed.record ? 'published' : null,
      record: analysed.record,
      lookupCount: null,
      sources: [],
      uncovered: { messages: totalMessages, ips: senders.length },
      problem: analysed.problem,
    };
  }

  const covered = new Set<number>();
  const sources = analysed.outcomes.map((outcome): SpfSourceUsage => {
    const networks = outcome.mode === 'flattened' ? parseNetworks(outcome.networks) : [];
    let messages = 0;
    let spfPassMessages = 0;
    let matchedIps = 0;
    senders.forEach((sender, index) => {
      if (!networks.some((network) => contains(network, sender.network))) return;
      covered.add(index);
      messages += sender.messages;
      spfPassMessages += sender.spfPass;
      matchedIps += 1;
    });

    const resolved = outcome.mode === 'flattened' && networks.length > 0;
    const status: SpfSourceStatus = !resolved
      ? 'unresolved'
      : messages > 0
        ? 'used'
        : enough
          ? 'unused'
          : 'insufficient_data';

    return {
      term: termOf(outcome.source),
      kind: outcome.source.kind,
      value: outcome.source.value,
      status,
      networkCount: networks.length,
      messages,
      spfPassMessages,
      matchedIps,
      lookups: analysed.lookupsBySource.get(termOf(outcome.source)) ?? null,
      reason: resolved
        ? null
        : (outcome.reason ?? 'The networks this source authorises could not be worked out in advance.'),
    };
  });

  let uncoveredMessages = 0;
  senders.forEach((sender, index) => {
    if (!covered.has(index)) uncoveredMessages += sender.messages;
  });

  return {
    ...base,
    origin: analysed.origin,
    record: analysed.record,
    lookupCount: analysed.lookupCount,
    sources,
    uncovered: { messages: uncoveredMessages, ips: senders.length - covered.size },
    problem: null,
  };
}
