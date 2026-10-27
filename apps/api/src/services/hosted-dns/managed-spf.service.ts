import { isIP } from 'node:net';
import type { HostedSpfRecord } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { systemDnsReader } from '../../scanner/dns.js';
import { evaluateSpfLookups } from '../../scanner/spf-evaluate.js';
import type { DnsReader } from '../../scanner/types.js';
import { normaliseTxtValue } from '../dns-automation/records.js';
import { recordAuditEvent } from '../audit.service.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { hostedDnsProvider, type HostedDnsProvider } from './provider.js';
import { uniqueHostedToken, usedHostedRecords } from './hosted-dmarc.service.js';
import { apexPointsAtUs, apexRecordFor, sourcesFromRecord } from './spf/apex.js';
import { buildSpfChain, type SpfPart } from './spf/chain.js';
import {
  flattenSources,
  parseHostSpec,
  type SourceOutcome,
  type SpfSource,
} from './spf/flatten.js';
import {
  formatCidr,
  isPrivateOrReservedNetwork,
  mergeNetworks,
  parseCidr,
  type ParsedCidr,
} from './spf/networks.js';

export const hostedSpfCommentPrefix = 'dmarc-harbor hosted-spf ';

export class ManagedSpfError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ManagedSpfError';
  }
}

export interface StoredSpfPart extends SpfPart {
  providerRecordId: string | null;
}

interface SourceState {
  networks: string[];
  failingSince: string | null;
  lastError: string | null;
  lastGoodAt: string | null;
  mode: SourceOutcome['mode'];
  lookups: number;
  reason: string | null;
}

type SourceStateMap = Record<string, SourceState>;

export type ManagedSpfOutcomeView = SourceOutcome & { failingSince: string | null };

export interface ManagedSpfChangeView {
  id: string;
  reason: string;
  actor: { id: string; name: string } | null;
  createdAt: string;
  added: string[];
  removed: string[];
}

export interface ManagedSpfView {
  available: boolean;
  managed: null | {
    status: HostedSpfRecord['status'];
    paused: boolean;
    apex: { host: string; type: 'TXT'; value: string };
    sources: SpfSource[];
    allQualifier: string;
    version: number;
    outcomes: ManagedSpfOutcomeView[];
    parts: Array<{ name: string; content: string }>;
    lookupCount: number;
    lastFlattenedAt: string | null;
    lastFlattenError: string | null;
    capacityBlocked: boolean;
    delegated: boolean;
    delegationCheckedAt: string | null;
    republish: {
      host: string;
      type: 'TXT';
      value: string;
      lookupCount: number;
      overLimit: boolean;
    } | null;
    changes: ManagedSpfChangeView[];
  };
  capacity: { full: boolean };
}

export interface ManagedSpfPreview {
  outcomes: ManagedSpfOutcomeView[];
  parts: SpfPart[];
  lookupCount: number;
  ip4Count: number;
  ip6Count: number;
  errors: string[];
}

let readerOverride: DnsReader | null = null;
let networkCheckOverride: ((network: ParsedCidr) => boolean) | null = null;

/** Test seam for the DNS reads start, preview, check and refresh make. */
export function setManagedSpfReaderForTests(reader: DnsReader | null): void {
  readerOverride = reader;
}

/**
 * Test seam for the reserved-network check. Documentation ranges are reserved
 * by isNonPublicIp, so integration tests opt them into "public" explicitly.
 */
export function setManagedSpfNetworkCheckForTests(
  check: ((network: ParsedCidr) => boolean) | null,
): void {
  networkCheckOverride = check;
}

function dnsReader(reader?: DnsReader): DnsReader {
  return reader ?? readerOverride ?? systemDnsReader;
}

function networkCheck(network: ParsedCidr): boolean {
  return networkCheckOverride ? networkCheckOverride(network) : isPrivateOrReservedNetwork(network);
}

function commentFor(row: { id: string }): string {
  return `${hostedSpfCommentPrefix}${row.id}`;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function cleanHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

function validHostname(value: string): boolean {
  if (isIP(value) !== 0) {
    return false;
  }
  // SPF includes commonly use service labels such as _spf.google.com, so an
  // underscore is allowed in non-final labels. The final label stays a normal
  // hostname label.
  return /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
    value,
  );
}

function sourceKey(source: SpfSource): string {
  return `${source.kind}:${source.value}`;
}

export function sourceLabel(source: SpfSource): string {
  return `${source.kind}:${source.value}`;
}

/** Audit labels deliberately omit CIDR lengths and addresses. */
function auditLabel(source: SpfSource): string {
  if (source.kind === 'ip4' || source.kind === 'ip6') {
    return source.kind;
  }
  const slash = source.value.indexOf('/');
  return `${source.kind}:${slash < 0 ? source.value : source.value.slice(0, slash)}`;
}

function resolveDomainValue(kind: 'a' | 'mx', value: string, domain: string): string {
  const spec = parseHostSpec(value);
  if (!spec) {
    throw new ManagedSpfError(`"${kind}:${value}" has an invalid CIDR suffix.`, 'INVALID_SOURCES', 400);
  }
  const host = spec.host || cleanHost(domain);
  if (!validHostname(host)) {
    throw new ManagedSpfError(`"${host}" is not a hostname.`, 'INVALID_SOURCES', 400);
  }
  let normalised = host;
  if (spec.v4Prefix !== null) {
    normalised += `/${spec.v4Prefix}`;
  }
  if (spec.v6Prefix !== null) {
    normalised += `//${spec.v6Prefix}`;
  }
  return normalised;
}

/**
 * Validates and canonicalises a source list before it is stored. Limits and
 * hostname checks happen here so both preview and save answer the same 400 for
 * the same input.
 */
export function normaliseSources(input: unknown, domain: string): SpfSource[] {
  if (!Array.isArray(input)) {
    throw new ManagedSpfError('Sources must be a list.', 'INVALID_SOURCES', 400);
  }
  if (input.length > 30) {
    throw new ManagedSpfError('A managed SPF record can list at most 30 sources.', 'INVALID_SOURCES', 400);
  }
  const sources: SpfSource[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      throw new ManagedSpfError('Each source needs a kind and a value.', 'INVALID_SOURCES', 400);
    }
    const kind = (entry as { kind?: unknown }).kind;
    const rawValue = (entry as { value?: unknown }).value;
    if (typeof kind !== 'string' || typeof rawValue !== 'string') {
      throw new ManagedSpfError('Each source needs a kind and a value.', 'INVALID_SOURCES', 400);
    }
    let source: SpfSource;
    if (kind === 'include') {
      const value = cleanHost(rawValue);
      if (!validHostname(value)) {
        throw new ManagedSpfError(`"${rawValue}" is not a hostname to include.`, 'INVALID_SOURCES', 400);
      }
      source = { kind, value };
    } else if (kind === 'ip4' || kind === 'ip6') {
      const family = kind === 'ip4' ? 4 : 6;
      const network = parseCidr(rawValue, family);
      if (!network) {
        throw new ManagedSpfError(`"${rawValue}" is not a valid IPv${family} network.`, 'INVALID_SOURCES', 400);
      }
      source = { kind, value: formatCidr(network) };
    } else if (kind === 'a' || kind === 'mx') {
      source = { kind, value: resolveDomainValue(kind, rawValue, domain) };
    } else {
      throw new ManagedSpfError(`"${kind}" is not a source kind.`, 'INVALID_SOURCES', 400);
    }
    const key = sourceKey(source);
    if (seen.has(key)) {
      throw new ManagedSpfError('The same source is listed twice.', 'INVALID_SOURCES', 400);
    }
    seen.add(key);
    sources.push(source);
  }
  return sources;
}

function sourcesOf(row: HostedSpfRecord): SpfSource[] {
  if (!Array.isArray(row.sources)) {
    return [];
  }
  return (row.sources as unknown as Array<Record<string, unknown>>)
    .filter(
      (source) =>
        source &&
        typeof source.kind === 'string' &&
        ['include', 'ip4', 'ip6', 'a', 'mx'].includes(source.kind) &&
        typeof source.value === 'string',
    )
    .map((source) => ({ kind: source.kind, value: source.value } as SpfSource));
}

function partsOf(row: { parts: Prisma.JsonValue }): StoredSpfPart[] {
  if (!Array.isArray(row.parts)) {
    return [];
  }
  return (row.parts as unknown as Array<Record<string, unknown>>)
    .filter(
      (part) =>
        part &&
        typeof part.name === 'string' &&
        typeof part.content === 'string',
    )
    .map((part) => ({
      name: part.name as string,
      content: part.content as string,
      providerRecordId:
        typeof part.providerRecordId === 'string' ? (part.providerRecordId as string) : null,
    }));
}

function stateOf(row: HostedSpfRecord): SourceStateMap {
  if (!row.sourceState || typeof row.sourceState !== 'object' || Array.isArray(row.sourceState)) {
    return {};
  }
  return row.sourceState as unknown as SourceStateMap;
}

function unflattenedTerm(source: SpfSource, domain: string): string {
  if (source.kind === 'include') {
    return `include:${source.value}`;
  }
  if (source.kind === 'ip4' || source.kind === 'ip6') {
    return `${source.kind}:${source.value}`;
  }
  const value = source.value.startsWith('/') ? `${cleanHost(domain)}${source.value}` : source.value;
  return `${source.kind}:${value}`;
}

/** The record the customer can publish at their own DNS host on release. */
export function unflattenedRecord(
  sources: SpfSource[],
  allQualifier: string,
  domain: string,
): string {
  const terms = sources.map((source) => unflattenedTerm(source, domain));
  return ['v=spf1', ...terms, allQualifier].join(' ');
}

async function verifyRepublish(
  sources: SpfSource[],
  allQualifier: string,
  domain: string,
  reader: DnsReader,
): Promise<{
  host: string;
  type: 'TXT';
  value: string;
  lookupCount: number;
  overLimit: boolean;
}> {
  const value = unflattenedRecord(sources, allQualifier, domain);
  const evaluation = await evaluateSpfLookups(domain, value, reader, {
    maxQueries: 60,
    deadlineMs: 5_000,
  });
  return {
    host: domain,
    type: 'TXT',
    value,
    lookupCount: evaluation.lookupCount,
    overLimit: evaluation.lookupCount > 10,
  };
}

async function domainFor(organizationId: string, domainRefOrId: string) {
  return prisma.domain.findFirst({
    where: {
      client: { organizationId },
      OR: [{ id: domainRefOrId }, { slug: domainRefOrId }],
    },
    select: { id: true, name: true, slug: true, status: true },
  });
}

function hostedZone(): string {
  if (!env.HOSTED_DNS_ZONE) {
    throw new ManagedSpfError(
      'Hosted DNS records are not set up on this deployment.',
      'HOSTED_DNS_UNAVAILABLE',
      503,
    );
  }
  return env.HOSTED_DNS_ZONE;
}

function capacityWarning(used: number): void {
  if (used / env.HOSTED_DNS_RECORD_LIMIT >= 0.85) {
    console.warn(
      `[hosted-spf] ${used} of ${env.HOSTED_DNS_RECORD_LIMIT} hosted DNS records are in use; new hosting will be refused at the limit.`,
    );
  }
}

async function uniqueSpfToken(): Promise<string> {
  return uniqueHostedToken(async (candidate) => {
    const [dmarc, spf] = await Promise.all([
      prisma.hostedDmarcRecord.findUnique({ where: { token: candidate }, select: { id: true } }),
      prisma.hostedSpfRecord.findUnique({ where: { token: candidate }, select: { id: true } }),
    ]);
    return Boolean(dmarc || spf);
  });
}

interface Flattened {
  outcomes: ManagedSpfOutcomeView[];
  state: SourceStateMap;
  networks: string[];
  passthrough: string[];
  passthroughLookups: number[];
  errors: string[];
  unusable: boolean;
  chain?: { parts: SpfPart[]; lookupCount: number };
  chainError?: { error: 'TOO_MANY_LOOKUPS' | 'TOO_MANY_PARTS'; lookupCount: number };
}

async function flattenAndBuild(input: {
  sources: SpfSource[];
  domainName: string;
  token: string;
  zone: string;
  allQualifier: '-all' | '~all';
  reader: DnsReader;
  previousState: SourceStateMap;
  allowLastGood: boolean;
}): Promise<Flattened> {
  const raw = await flattenSources(input.sources, input.reader, {
    customerDomain: input.domainName,
    isUnusableNetwork: networkCheck,
  });
  const now = new Date().toISOString();
  const state: SourceStateMap = {};
  const outcomes: ManagedSpfOutcomeView[] = [];
  const networks: string[] = [];
  const passthrough: string[] = [];
  const passthroughLookups: number[] = [];
  const errors: string[] = [];
  let unusable = false;

  for (const outcome of raw) {
    const key = sourceKey(outcome.source);
    const previous = input.previousState[key];
    const previousNetworks = previous?.networks?.length ? previous.networks : [];

    if (outcome.mode === 'flattened') {
      const next: SourceState = {
        networks: outcome.networks,
        failingSince: null,
        lastError: null,
        lastGoodAt: now,
        mode: 'flattened',
        lookups: 0,
        reason: null,
      };
      state[key] = next;
      networks.push(...outcome.networks);
      outcomes.push({ ...outcome, failingSince: null });
      continue;
    }

    if (outcome.mode === 'passthrough') {
      state[key] = {
        networks: [],
        failingSince: null,
        lastError: null,
        lastGoodAt: null,
        mode: 'passthrough',
        lookups: outcome.lookups,
        reason: outcome.reason,
      };
      passthrough.push(`include:${outcome.source.value}`);
      passthroughLookups.push(outcome.lookups);
      outcomes.push({ ...outcome, failingSince: null });
      continue;
    }

    errors.push(`${sourceLabel(outcome.source)}: ${outcome.reason ?? 'This source failed.'}`);
    if (input.allowLastGood && previousNetworks.length > 0) {
      const failingSince = previous.failingSince ?? now;
      state[key] = {
        networks: previousNetworks,
        failingSince,
        lastError: outcome.reason,
        lastGoodAt: previous.lastGoodAt,
        mode: outcome.mode,
        lookups: 0,
        reason: outcome.reason,
      };
      networks.push(...previousNetworks);
      outcomes.push({
        ...outcome,
        networks: previousNetworks,
        failingSince,
      });
    } else {
      unusable = true;
      state[key] = {
        networks: [],
        failingSince: previous?.failingSince ?? now,
        lastError: outcome.reason,
        lastGoodAt: previous?.lastGoodAt ?? null,
        mode: outcome.mode,
        lookups: 0,
        reason: outcome.reason,
      };
      outcomes.push({ ...outcome, networks: [], failingSince: previous?.failingSince ?? now });
    }
  }

  const merged = mergeNetworks(networks);
  if (unusable) {
    return { outcomes, state, networks: merged, passthrough, passthroughLookups, errors, unusable };
  }

  const chain = buildSpfChain({
    token: input.token,
    zone: input.zone,
    allQualifier: input.allQualifier,
    networks: merged,
    passthrough,
    passthroughLookups,
  });
  if ('error' in chain) {
    const message =
      chain.error === 'TOO_MANY_LOOKUPS'
        ? `This record needs ${chain.lookupCount} lookups; receivers allow 10.`
        : 'This record needs more than 9 DNS record parts.';
    errors.push(message);
    return {
      outcomes,
      state,
      networks: merged,
      passthrough,
      passthroughLookups,
      errors,
      unusable,
      chainError: chain,
    };
  }
  return {
    outcomes,
    state,
    networks: merged,
    passthrough,
    passthroughLookups,
    errors,
    unusable,
    chain,
  };
}

function sameParts(a: StoredSpfPart[], b: SpfPart[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (part, index) =>
        part.name === b[index]!.name &&
        normaliseTxtValue(part.content) === normaliseTxtValue(b[index]!.content),
    )
  );
}

async function syncParts(
  row: HostedSpfRecord,
  desired: SpfPart[],
  provider: HostedDnsProvider,
): Promise<{ ok: true; parts: StoredSpfPart[] } | { ok: false; error: string }> {
  const previous = partsOf(row);
  const previousByName = new Map(previous.map((part) => [part.name, part]));
  const comment = commentFor(row);
  const parts: StoredSpfPart[] = [];

  try {
    /**
     * Continuations first, the entry record last.
     *
     * The entry is the only record receivers start from, and it names each
     * continuation with include:. Writing it first would publish an include of
     * a name that does not exist yet, which is a permanent error: SPF fails for
     * every message until the continuation lands. In this order a receiver sees
     * either the old chain or the new one, never a half-written one. Obsolete
     * continuations are removed after the entry stops naming them, below.
     */
    const ordered = [...desired.slice(1), ...desired.slice(0, 1)];
    const written = new Map<string, StoredSpfPart>();
    for (const part of ordered) {
      const old = previousByName.get(part.name);
      const records = await provider.get(part.name);
      const managed = records.filter(
        (record) =>
          record.comment === comment || record.id === old?.providerRecordId,
      );
      let chosen = managed.find((record) => record.id === old?.providerRecordId) ?? managed[0] ?? null;
      if (!chosen) {
        chosen = await provider.create(part.name, part.content, comment);
      } else if (normaliseTxtValue(chosen.content) !== normaliseTxtValue(part.content)) {
        chosen = await provider.update(chosen, part.content);
      }
      for (const extra of managed) {
        if (extra.id !== chosen.id) {
          await provider.remove(extra.id);
        }
      }
      written.set(part.name, { ...part, providerRecordId: chosen.id });
    }
    // Stored in chain order, entry first, whatever order they were written in.
    for (const part of desired) {
      parts.push(written.get(part.name)!);
    }

    const desiredNames = new Set(desired.map((part) => part.name));
    for (const old of previous) {
      if (desiredNames.has(old.name)) {
        continue;
      }
      const records = await provider.get(old.name);
      const managed = records.filter(
        (record) =>
          record.comment === comment || record.id === old.providerRecordId,
      );
      for (const record of managed) {
        await provider.remove(record.id);
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The DNS provider refused the change.',
    };
  }

  await prisma.hostedSpfRecord.update({
    where: { id: row.id },
    data: { parts: asJson(parts) },
  });
  return { ok: true, parts };
}

async function removeOurRecords(
  provider: HostedDnsProvider,
  target: { id: string; token: string },
  names: string[],
  knownIds: string[] = [],
): Promise<void> {
  const comment = `${hostedSpfCommentPrefix}${target.id}`;
  const ids = new Set(knownIds.filter(Boolean));
  for (const name of [...new Set(names)]) {
    const records = await provider.get(name);
    for (const record of records) {
      if (record.comment === comment || ids.has(record.id)) {
        await provider.remove(record.id);
      }
    }
  }
}

async function removeAllParts(provider: HostedDnsProvider, row: HostedSpfRecord): Promise<void> {
  const parts = partsOf(row);
  await removeOurRecords(
    provider,
    row,
    parts.map((part) => part.name),
    parts.map((part) => part.providerRecordId).filter((id): id is string => Boolean(id)),
  );
}

async function trimChanges(recordId: string): Promise<void> {
  const keep = await prisma.hostedSpfChange.findMany({
    where: { recordId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: 50,
    select: { id: true },
  });
  if (keep.length > 0) {
    await prisma.hostedSpfChange.deleteMany({ where: { id: { in: keep.map((row) => row.id) } } });
  }
}

function outcomesFor(row: HostedSpfRecord): ManagedSpfOutcomeView[] {
  const sources = sourcesOf(row);
  const state = stateOf(row);
  return sources.map((source) => {
    const entry = state[sourceKey(source)];
    return {
      source,
      mode: entry?.mode ?? 'error',
      networks: entry?.networks ?? [],
      lookups: entry?.lookups ?? 0,
      reason: entry?.reason ?? entry?.lastError ?? null,
      failingSince: entry?.failingSince ?? null,
    };
  });
}

function sourceList(value: unknown): SpfSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (source): source is SpfSource =>
      Boolean(source) &&
      typeof source === 'object' &&
      typeof (source as { kind?: unknown }).kind === 'string' &&
      typeof (source as { value?: unknown }).value === 'string',
  );
}

function diffLabelsWith(
  before: unknown,
  after: unknown,
  labeler: (source: SpfSource) => string,
): { added: string[]; removed: string[] } {
  const oldCounts = new Map<string, number>();
  for (const source of sourceList(before)) {
    const label = labeler(source);
    oldCounts.set(label, (oldCounts.get(label) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const source of sourceList(after)) {
    const label = labeler(source);
    const count = oldCounts.get(label) ?? 0;
    if (count > 0) {
      oldCounts.set(label, count - 1);
    } else {
      added.push(label);
    }
  }
  const removed: string[] = [];
  for (const [label, count] of oldCounts) {
    for (let index = 0; index < count; index += 1) {
      removed.push(label);
    }
  }
  return { added, removed };
}

function diffLabels(before: unknown, after: unknown): { added: string[]; removed: string[] } {
  return diffLabelsWith(before, after, sourceLabel);
}

async function changesFor(row: HostedSpfRecord): Promise<ManagedSpfChangeView[]> {
  const changes = await prisma.hostedSpfChange.findMany({
    where: { recordId: row.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
    select: {
      id: true,
      reason: true,
      previousSources: true,
      newSources: true,
      actorUserId: true,
      createdAt: true,
    },
  });
  const actorIds = [
    ...new Set(changes.map((change) => change.actorUserId).filter((id): id is string => Boolean(id))),
  ];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));
  return changes.map((change) => {
    const diff = diffLabels(change.previousSources, change.newSources);
    return {
      id: change.id,
      reason: change.reason,
      actor: change.actorUserId
        ? {
            id: change.actorUserId,
            name: actorById.get(change.actorUserId)?.name ?? 'A former member',
          }
        : null,
      createdAt: change.createdAt.toISOString(),
      added: diff.added,
      removed: diff.removed,
    };
  });
}

async function viewFor(
  organizationId: string,
  domain: { id: string; name: string },
  row: HostedSpfRecord | null,
  reader?: DnsReader,
): Promise<ManagedSpfView> {
  const provider = hostedDnsProvider();
  const used = await usedHostedRecords();
  const capacity = { full: used >= env.HOSTED_DNS_RECORD_LIMIT };
  if (!provider) {
    return { available: false, managed: null, capacity };
  }
  if (!row) {
    return { available: true, managed: null, capacity };
  }

  const entitlements = await resolveEntitlements(organizationId);
  const paused = entitlements.features['dns.managedSpf'] !== true;
  const zone = hostedZone();
  const sources = sourcesOf(row);
  const allQualifier = row.allQualifier;
  const republish =
    row.status === 'RELEASING'
      ? await verifyRepublish(sources, allQualifier, domain.name, dnsReader(reader))
      : null;

  return {
    available: true,
    managed: {
      status: row.status,
      paused,
      apex: { host: domain.name, type: 'TXT', value: apexRecordFor(row.token, zone) },
      sources,
      allQualifier,
      version: row.version,
      outcomes: outcomesFor(row),
      parts: partsOf(row).map((part) => ({ name: part.name, content: part.content })),
      lookupCount: row.lookupCount,
      lastFlattenedAt: row.lastFlattenedAt?.toISOString() ?? null,
      lastFlattenError: row.lastFlattenError,
      capacityBlocked: row.capacityBlocked,
      delegated: row.delegated,
      delegationCheckedAt: row.delegationCheckedAt?.toISOString() ?? null,
      republish,
      changes: await changesFor(row),
    },
    capacity,
  };
}

export async function managedSpfView(
  organizationId: string,
  domainRefOrId: string,
  reader?: DnsReader,
): Promise<ManagedSpfView> {
  const domain = await domainFor(organizationId, domainRefOrId);
  if (!domain) {
    throw new ManagedSpfError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedSpfRecord.findUnique({ where: { domainId: domain.id } });
  return viewFor(organizationId, domain, row, reader);
}

async function readApex(
  domainName: string,
  reader: DnsReader,
): Promise<{ records: string[] }> {
  const lookup = await reader.resolveTxt(domainName);
  if (lookup.status === 'error') {
    throw new ManagedSpfError(
      `The DNS lookup for ${domainName} failed. Nothing was created; try again.`,
      'DNS_LOOKUP_FAILED',
      503,
    );
  }
  const records = (lookup.value ?? [])
    .map((chunks) => chunks.join('').trim())
    .filter((record) => /^v=spf1(?:\s|$)/i.test(record));
  return { records };
}

async function capacityFor(partsCount: number, row?: HostedSpfRecord): Promise<boolean> {
  const used = await usedHostedRecords();
  const current = row ? partsOf(row).length : 0;
  return partsCount <= env.HOSTED_DNS_RECORD_LIMIT - (used - current);
}

function fullError(): ManagedSpfError {
  return new ManagedSpfError(
    'Hosting is full on this deployment right now. Publish the SPF record yourself.',
    'HOSTED_DNS_FULL',
    503,
  );
}

export async function startManagedSpf(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
  reader?: DnsReader;
}): Promise<ManagedSpfView> {
  const provider = hostedDnsProvider();
  if (!provider) {
    throw new ManagedSpfError(
      'Managed SPF is not set up on this deployment.',
      'HOSTED_DNS_UNAVAILABLE',
      503,
    );
  }
  const zone = hostedZone();
  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new ManagedSpfError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  if (domain.status !== 'VERIFIED') {
    throw new ManagedSpfError('Verify the domain before managing its SPF record.', 'DOMAIN_NOT_VERIFIED', 409);
  }

  const existing = await prisma.hostedSpfRecord.findUnique({ where: { domainId: domain.id } });
  if (existing && existing.status !== 'RELEASED') {
    throw new ManagedSpfError('This domain already has a managed SPF record.', 'ALREADY_MANAGED', 409);
  }

  const reader = dnsReader(input.reader);
  const apex = await readApex(domain.name, reader);
  if (apex.records.length > 1) {
    throw new ManagedSpfError(
      'More than one SPF record is published, so receivers ignore all of them.',
      'MULTIPLE_SPF_RECORDS',
      409,
    );
  }

  let sources: SpfSource[] = [];
  let allQualifier: '-all' | '~all' = '~all';
  let importNotes: string[] = [];
  if (apex.records.length === 1) {
    const imported = sourcesFromRecord(apex.records[0]!, domain.name);
    if (imported.error) {
      throw new ManagedSpfError(imported.error, 'SOURCE_NOT_USABLE', 409, {
        reason: imported.error,
        notes: imported.notes,
      });
    }
    sources = imported.sources;
    allQualifier = imported.allQualifier;
    importNotes = imported.notes;
  }

  const token = await uniqueSpfToken();
  const flattened = await flattenAndBuild({
    sources,
    domainName: domain.name,
    token,
    zone,
    allQualifier,
    reader,
    previousState: {},
    allowLastGood: false,
  });
  if (flattened.unusable || flattened.chainError || !flattened.chain) {
    throw new ManagedSpfError(
      flattened.errors[0] ?? 'This SPF record cannot be managed yet.',
      flattened.chainError?.error === 'TOO_MANY_LOOKUPS'
        ? 'TOO_MANY_LOOKUPS'
        : flattened.chainError?.error === 'TOO_MANY_PARTS'
          ? 'TOO_MANY_PARTS'
          : 'SOURCE_NOT_USABLE',
      409,
      {
        outcomes: flattened.outcomes,
        lookupCount: flattened.chainError?.lookupCount,
        partCount: flattened.chain?.parts.length,
        notes: importNotes,
        errors: flattened.errors,
      },
    );
  }

  if (!(await capacityFor(flattened.chain.parts.length))) {
    throw fullError();
  }

  if (existing) {
    await prisma.hostedSpfRecord.delete({ where: { id: existing.id } });
  }

  const row = await prisma.hostedSpfRecord.create({
    data: {
      organizationId: input.organizationId,
      domainId: domain.id,
      token,
      status: 'PENDING',
      sources: asJson(sources),
      allQualifier,
      sourceState: asJson(flattened.state),
      parts: asJson([]),
      lookupCount: flattened.chain.lookupCount,
      lastFlattenedAt: new Date(),
      createdById: input.actorUserId,
    },
  });

  const synced = await syncParts(row, flattened.chain.parts, provider);
  if (!synced.ok) {
    await removeOurRecords(
      provider,
      row,
      flattened.chain.parts.map((part) => part.name),
    ).catch(() => undefined);
    await prisma.hostedSpfRecord.delete({ where: { id: row.id } }).catch(() => undefined);
    throw new ManagedSpfError(
      synced.error,
      'HOSTED_DNS_PROVIDER_FAILED',
      502,
    );
  }

  await prisma.hostedSpfChange.create({
    data: {
      recordId: row.id,
      organizationId: input.organizationId,
      reason: 'created',
      previousSources: Prisma.DbNull,
      newSources: asJson(sources),
      previousParts: Prisma.DbNull,
      newParts: asJson(synced.parts),
      actorUserId: input.actorUserId,
    },
  });
  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'MANAGED_SPF_CREATED',
    targetType: 'domain',
    targetId: domain.id,
    detail: { domainName: domain.name },
  });
  capacityWarning(await usedHostedRecords());

  const fresh = await prisma.hostedSpfRecord.findUniqueOrThrow({ where: { id: row.id } });
  return viewFor(input.organizationId, domain, fresh, reader);
}

export async function previewManagedSpf(input: {
  organizationId: string;
  domainId: string;
  sources: unknown;
  allQualifier: string;
  reader?: DnsReader;
}): Promise<ManagedSpfPreview> {
  if (!hostedDnsProvider()) {
    throw new ManagedSpfError(
      'Managed SPF is not set up on this deployment.',
      'HOSTED_DNS_UNAVAILABLE',
      503,
    );
  }
  const zone = hostedZone();
  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new ManagedSpfError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  if (input.allQualifier !== '-all' && input.allQualifier !== '~all') {
    throw new ManagedSpfError('The all qualifier must be -all or ~all.', 'INVALID_SOURCES', 400);
  }
  const sources = normaliseSources(input.sources, domain.name);
  const row = await prisma.hostedSpfRecord.findUnique({ where: { domainId: domain.id } });
  const token = row?.token ?? (await uniqueSpfToken());
  const flattened = await flattenAndBuild({
    sources,
    domainName: domain.name,
    token,
    zone,
    allQualifier: input.allQualifier,
    reader: dnsReader(input.reader),
    previousState: row ? stateOf(row) : {},
    allowLastGood: true,
  });
  const merged = flattened.networks;
  return {
    outcomes: flattened.outcomes,
    parts: flattened.chain?.parts ?? [],
    lookupCount: flattened.chain?.lookupCount ?? flattened.chainError?.lookupCount ?? 0,
    ip4Count: merged.filter((network) => !network.includes(':')).length,
    ip6Count: merged.filter((network) => network.includes(':')).length,
    errors: flattened.errors,
  };
}

async function versionConflict(
  organizationId: string,
  domain: { id: string; name: string },
): Promise<never> {
  const current = await prisma.hostedSpfRecord.findUnique({ where: { domainId: domain.id } });
  const view = await viewFor(organizationId, domain, current);
  throw new ManagedSpfError(
    'Someone else changed this record. Reload and try again.',
    'VERSION_CHANGED',
    409,
    { view },
  );
}

export async function updateManagedSpf(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
  expectedVersion: number;
  sources: unknown;
  allQualifier: string;
  reader?: DnsReader;
}): Promise<ManagedSpfView & { action: 'updated' | 'unchanged' }> {
  const provider = hostedDnsProvider();
  if (!provider) {
    throw new ManagedSpfError(
      'Managed SPF is not set up on this deployment.',
      'HOSTED_DNS_UNAVAILABLE',
      503,
    );
  }
  const zone = hostedZone();
  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new ManagedSpfError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedSpfRecord.findUnique({ where: { domainId: domain.id } });
  if (!row) {
    throw new ManagedSpfError('This domain does not have a managed SPF record.', 'NOT_MANAGED', 404);
  }
  if (row.status === 'RELEASING' || row.status === 'RELEASED') {
    throw new ManagedSpfError(
      'This record is being released and cannot be changed.',
      'SPF_RELEASING',
      409,
    );
  }
  if (input.expectedVersion !== row.version) {
    return versionConflict(input.organizationId, domain);
  }
  if (input.allQualifier !== '-all' && input.allQualifier !== '~all') {
    throw new ManagedSpfError('The all qualifier must be -all or ~all.', 'INVALID_SOURCES', 400);
  }
  const sources = normaliseSources(input.sources, domain.name);
  const previousSources = sourcesOf(row);
  const previousParts = partsOf(row);

  if (
    JSON.stringify(sources.map(sourceKey).sort()) ===
      JSON.stringify(previousSources.map(sourceKey).sort()) &&
    input.allQualifier === row.allQualifier
  ) {
    return { ...(await viewFor(input.organizationId, domain, row, input.reader)), action: 'unchanged' };
  }

  const flattened = await flattenAndBuild({
    sources,
    domainName: domain.name,
    token: row.token,
    zone,
    allQualifier: input.allQualifier,
    reader: dnsReader(input.reader),
    previousState: stateOf(row),
    allowLastGood: true,
  });
  if (flattened.unusable || flattened.chainError || !flattened.chain) {
    throw new ManagedSpfError(
      flattened.errors[0] ?? 'This SPF record cannot be managed yet.',
      flattened.chainError?.error === 'TOO_MANY_LOOKUPS'
        ? 'TOO_MANY_LOOKUPS'
        : flattened.chainError?.error === 'TOO_MANY_PARTS'
          ? 'TOO_MANY_PARTS'
          : 'SOURCE_NOT_USABLE',
      409,
      {
        outcomes: flattened.outcomes,
        lookupCount: flattened.chainError?.lookupCount,
        partCount: flattened.chain?.parts.length,
        errors: flattened.errors,
      },
    );
  }
  if (!(await capacityFor(flattened.chain.parts.length, row))) {
    throw fullError();
  }

  // The conditional update is the lock. Reading the version back afterwards is
  // not: two saves from the same version both see version + 1 after the first
  // one lands, so the loser would carry on and publish over the winner.
  const claimed = await prisma.hostedSpfRecord.updateMany({
    where: { id: row.id, version: input.expectedVersion },
    data: {
      sources: asJson(sources),
      allQualifier: input.allQualifier,
      sourceState: asJson(flattened.state),
      lookupCount: flattened.chain.lookupCount,
      lastFlattenedAt: new Date(),
      lastFlattenError: null,
      capacityBlocked: false,
      version: { increment: 1 },
    },
  });
  if (claimed.count !== 1) {
    return versionConflict(input.organizationId, domain);
  }
  const bumped = await prisma.hostedSpfRecord.findUniqueOrThrow({ where: { id: row.id } });

  const synced = await syncParts(bumped, flattened.chain.parts, provider);
  if (!synced.ok) {
    await prisma.hostedSpfRecord.update({
      where: { id: row.id },
      data: {
        sources: asJson(previousSources),
        allQualifier: row.allQualifier,
        sourceState: asJson(stateOf(row)),
        parts: asJson(previousParts),
        lookupCount: row.lookupCount,
        lastFlattenedAt: row.lastFlattenedAt,
        lastFlattenError: synced.error,
        capacityBlocked: row.capacityBlocked,
        version: input.expectedVersion,
      },
    });
    throw new ManagedSpfError(synced.error, 'HOSTED_DNS_PROVIDER_FAILED', 502);
  }

  await prisma.hostedSpfChange.create({
    data: {
      recordId: row.id,
      organizationId: input.organizationId,
      reason: 'sources',
      previousSources: asJson(previousSources),
      newSources: asJson(sources),
      previousParts: asJson(previousParts),
      newParts: asJson(synced.parts),
      actorUserId: input.actorUserId,
    },
  });
  await trimChanges(row.id);

  const auditDiff = diffLabelsWith(previousSources, sources, auditLabel);
  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'MANAGED_SPF_UPDATED',
    targetType: 'domain',
    targetId: domain.id,
    detail: {
      added: auditDiff.added,
      removed: auditDiff.removed,
      allQualifier: { from: row.allQualifier, to: input.allQualifier },
    },
  }).catch((error) => {
    console.error('Failed to record a managed SPF update', error);
  });

  capacityWarning(await usedHostedRecords());
  const fresh = await prisma.hostedSpfRecord.findUniqueOrThrow({ where: { id: row.id } });
  return { ...(await viewFor(input.organizationId, domain, fresh, input.reader)), action: 'updated' };
}

function referencesOurNames(record: string, row: HostedSpfRecord): boolean {
  const lower = record.toLowerCase();
  const names = [
    `${row.token}.spf.${hostedZone()}`,
    ...partsOf(row).map((part) => part.name),
  ].map((name) => name.toLowerCase());
  return names.some((name) => lower.includes(name));
}

export async function checkSpfDelegation(input: {
  organizationId: string;
  domainId: string;
  reader?: DnsReader;
}): Promise<ManagedSpfView> {
  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new ManagedSpfError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedSpfRecord.findUnique({ where: { domainId: domain.id } });
  if (!row) {
    throw new ManagedSpfError('This domain does not have a managed SPF record.', 'NOT_MANAGED', 404);
  }

  const reader = dnsReader(input.reader);
  const lookup = await reader.resolveTxt(domain.name);
  if (lookup.status === 'error') {
    // Unknown, not absent: never flip delegation or release on an error.
    return viewFor(input.organizationId, domain, row, reader);
  }
  const records = (lookup.value ?? [])
    .map((chunks) => chunks.join('').trim())
    .filter((record) => /^v=spf1(?:\s|$)/i.test(record));
  const delegated = apexPointsAtUs(records, row.token, hostedZone());
  const now = new Date();
  let update: Parameters<typeof prisma.hostedSpfRecord.update>[0]['data'] = {
    delegated,
    delegationCheckedAt: now,
  };
  if (row.status === 'PENDING' && delegated) {
    update = { ...update, status: 'ACTIVE', activatedAt: row.activatedAt ?? now };
  }

  if (
    row.status === 'RELEASING' &&
    lookup.status === 'found' &&
    records.length === 1 &&
    !referencesOurNames(records[0]!, row)
  ) {
    const provider = hostedDnsProvider();
    if (!provider) {
      throw new ManagedSpfError(
        'Managed SPF is not set up on this deployment.',
        'HOSTED_DNS_UNAVAILABLE',
        503,
      );
    }
    try {
      await removeAllParts(provider, row);
      update = {
        ...update,
        status: 'RELEASED',
        releasedAt: now,
        lastFlattenError: null,
        capacityBlocked: false,
      };
    } catch (error) {
      update = {
        ...update,
        lastFlattenError:
          error instanceof Error ? error.message : 'The DNS provider refused the removal.',
      };
    }
  }

  const updated = await prisma.hostedSpfRecord.update({ where: { id: row.id }, data: update });
  if (updated.status === 'RELEASED' && row.status !== 'RELEASED') {
    await recordAuditEvent({
      organizationId: input.organizationId,
      action: 'MANAGED_SPF_RELEASED',
      targetType: 'domain',
      targetId: domain.id,
      detail: { domainName: domain.name },
    });
  }
  return viewFor(input.organizationId, domain, updated, reader);
}

export async function requestSpfRelease(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
  reader?: DnsReader;
}): Promise<ManagedSpfView> {
  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new ManagedSpfError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedSpfRecord.findUnique({ where: { domainId: domain.id } });
  if (!row) {
    throw new ManagedSpfError('This domain does not have a managed SPF record.', 'NOT_MANAGED', 404);
  }
  if (row.status === 'RELEASED' || row.status === 'RELEASING') {
    return viewFor(input.organizationId, domain, row, input.reader);
  }

  if (row.status === 'PENDING') {
    const provider = hostedDnsProvider();
    if (!provider) {
      throw new ManagedSpfError(
        'Managed SPF is not set up on this deployment.',
        'HOSTED_DNS_UNAVAILABLE',
        503,
      );
    }
    try {
      await removeAllParts(provider, row);
    } catch (error) {
      throw new ManagedSpfError(
        error instanceof Error ? error.message : 'The DNS provider refused the removal.',
        'HOSTED_DNS_PROVIDER_FAILED',
        502,
      );
    }
    const released = await prisma.hostedSpfRecord.update({
      where: { id: row.id },
      data: {
        status: 'RELEASED',
        releasedAt: new Date(),
        lastFlattenError: null,
        capacityBlocked: false,
      },
    });
    await recordAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'MANAGED_SPF_RELEASED',
      targetType: 'domain',
      targetId: domain.id,
      detail: { domainName: domain.name },
    });
    return viewFor(input.organizationId, domain, released, input.reader);
  }

  const updated = await prisma.hostedSpfRecord.update({
    where: { id: row.id },
    data: { status: 'RELEASING', releaseRequestedAt: new Date() },
  });
  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'MANAGED_SPF_RELEASE_REQUESTED',
    targetType: 'domain',
    targetId: domain.id,
    detail: { domainName: domain.name },
  });
  return viewFor(input.organizationId, domain, updated, input.reader);
}

export interface ManagedSpfRefreshResult {
  ok: boolean;
  changed: boolean;
  error?: string;
}

/**
 * The reconciler's work for one row. It keeps the published parts when DNS,
 * the chain or capacity fails: a refresh must never publish fewer addresses
 * than the last successful run.
 */
export async function refreshManagedSpf(snapshot: HostedSpfRecord): Promise<ManagedSpfRefreshResult> {
  const provider = hostedDnsProvider();
  if (!provider) {
    return { ok: false, changed: false, error: 'Managed SPF is not set up on this deployment.' };
  }
  // Re-read: the reconciler loads every row up front, and a person may have
  // saved new sources since. Refreshing the stale copy would publish the old
  // source list over theirs.
  const row = await prisma.hostedSpfRecord.findUnique({ where: { id: snapshot.id } });
  if (!row || row.status === 'RELEASED') {
    return { ok: true, changed: false };
  }
  const domain = await prisma.domain.findUnique({
    where: { id: row.domainId },
    select: { name: true },
  });
  if (!domain) {
    return { ok: false, changed: false, error: 'The domain no longer exists.' };
  }

  const flattened = await flattenAndBuild({
    sources: sourcesOf(row),
    domainName: domain.name,
    token: row.token,
    zone: hostedZone(),
    allQualifier: row.allQualifier === '-all' ? '-all' : '~all',
    reader: dnsReader(),
    previousState: stateOf(row),
    allowLastGood: true,
  });

  if (flattened.unusable || flattened.chainError || !flattened.chain) {
    const message = flattened.errors[0] ?? 'This SPF record could not be refreshed.';
    await prisma.hostedSpfRecord.update({
      where: { id: row.id },
      data: {
        sourceState: asJson(flattened.state),
        lastFlattenError: message,
        capacityBlocked: false,
      },
    });
    return { ok: false, changed: false, error: message };
  }

  if (!(await capacityFor(flattened.chain.parts.length, row))) {
    await prisma.hostedSpfRecord.update({
      where: { id: row.id },
      data: {
        sourceState: asJson(flattened.state),
        lastFlattenError: null,
        capacityBlocked: true,
      },
    });
    return { ok: false, changed: false, error: 'The hosted zone does not have room for the new parts.' };
  }

  // Flattening takes seconds. A save that landed meanwhile owns the record now.
  const current = await prisma.hostedSpfRecord.findUnique({
    where: { id: row.id },
    select: { version: true, status: true },
  });
  if (!current || current.version !== row.version || current.status === 'RELEASED') {
    return { ok: true, changed: false };
  }

  const previousParts = partsOf(row);
  const partsChanged = !sameParts(previousParts, flattened.chain.parts);
  /**
   * Synced on every pass, not only when the computed parts changed.
   *
   * syncParts compares each desired part with what the zone actually holds and
   * writes only the differences, so an unchanged pass costs reads. Skipping it
   * when the stored parts matched meant a zone that had drifted (a record
   * edited by hand, or a save whose zone write failed half way and was rolled
   * back in the database) stayed wrong until the sources next changed.
   */
  const synced = await syncParts(row, flattened.chain.parts, provider);
  if (!synced.ok) {
    await prisma.hostedSpfRecord.update({
      where: { id: row.id },
      data: {
        sourceState: asJson(flattened.state),
        lastFlattenError: synced.error,
        capacityBlocked: false,
      },
    });
    return { ok: false, changed: false, error: synced.error };
  }
  if (partsChanged) {
    await prisma.hostedSpfChange.create({
      data: {
        recordId: row.id,
        organizationId: row.organizationId,
        reason: 'refresh',
        previousSources: asJson(sourcesOf(row)),
        newSources: asJson(sourcesOf(row)),
        previousParts: asJson(previousParts),
        newParts: asJson(synced.parts),
      },
    });
    await trimChanges(row.id);
  }

  await prisma.hostedSpfRecord.update({
    where: { id: row.id },
    data: {
      sourceState: asJson(flattened.state),
      lookupCount: flattened.chain.lookupCount,
      lastFlattenedAt: new Date(),
      lastFlattenError: null,
      capacityBlocked: false,
    },
  });
  capacityWarning(await usedHostedRecords());
  return { ok: true, changed: !sameParts(previousParts, flattened.chain.parts) };
}

export interface ManagedSpfDeletionSnapshot {
  id: string;
  token: string;
  parts: StoredSpfPart[];
}

export async function managedSpfSnapshotsForDomainIds(
  domainIds: string[],
): Promise<ManagedSpfDeletionSnapshot[]> {
  if (domainIds.length === 0) return [];
  const rows = await prisma.hostedSpfRecord.findMany({
    where: { domainId: { in: domainIds } },
    select: { id: true, token: true, parts: true },
  });
  return rows.map((row) => ({ id: row.id, token: row.token, parts: partsOf(row as HostedSpfRecord) }));
}

/** Best-effort provider cleanup after the database rows have already gone. */
export async function removeManagedSpfForDeletion(
  records: ManagedSpfDeletionSnapshot[],
): Promise<void> {
  const provider = hostedDnsProvider();
  if (!provider || records.length === 0) {
    return;
  }
  for (const record of records) {
    try {
      await removeOurRecords(
        provider,
        { id: record.id, token: record.token },
        record.parts.map((part) => part.name),
        record.parts.map((part) => part.providerRecordId).filter((id): id is string => Boolean(id)),
      );
    } catch (error) {
      console.error(
        `[hosted-spf] could not remove the provider records for ${record.token}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}

/** Used by the deletion preview, which must not touch DNS. */
export function managedSpfRepublish(input: {
  sources: unknown;
  allQualifier: string;
  domain: string;
}): string {
  const sources = Array.isArray(input.sources)
    ? (input.sources as SpfSource[]).filter(
        (source) =>
          source &&
          typeof source.kind === 'string' &&
          typeof source.value === 'string',
      )
    : [];
  return unflattenedRecord(sources, input.allQualifier === '-all' ? '-all' : '~all', input.domain);
}

export interface ManagedSpfReconcileSummary {
  refreshed: number;
  failed: number;
  removed: number;
}

function escapeRegExp(value: string): string {
  return value
    .split('')
    .map((character) => ('.*+?^${}()|[]\\'.includes(character) ? `\\${character}` : character))
    .join('');
}

/**
 * The names our SPF parts live at, and nothing else.
 *
 * Exported so the orphan sweep and a test read the same expression: hosted
 * BIMI and hosted DMARC write into the same zone, and a pattern that also
 * matched `<token>.bimi.<zone>` would let this pass delete a BIMI record as an
 * orphan.
 */
export function hostedSpfNamePattern(zone: string): RegExp {
  return new RegExp(`^[a-z2-7]{16}(?:-[2-9])?\\.spf\\.${escapeRegExp(zone)}$`);
}

/**
 * One reconciler pass for managed SPF: refresh every live row, then remove
 * SPF-shaped records with our comment that no live row owns. The DMARC sweep
 * is a separate pass and is deliberately untouched.
 */
export async function reconcileManagedSpf(): Promise<ManagedSpfReconcileSummary> {
  const provider = hostedDnsProvider();
  const summary: ManagedSpfReconcileSummary = { refreshed: 0, failed: 0, removed: 0 };
  if (!provider) {
    return summary;
  }

  const rows = await prisma.hostedSpfRecord.findMany({
    where: { status: { not: 'RELEASED' } },
  });
  for (const row of rows) {
    const result = await refreshManagedSpf(row);
    if (result.ok) summary.refreshed += 1;
    else summary.failed += 1;
  }

  const namePattern = hostedSpfNamePattern(provider.zone);
  for await (const record of provider.listAll()) {
    const name = record.name.toLowerCase().replace(/\.+$/, '');
    if (!namePattern.test(name)) continue;
    if (!record.comment?.startsWith(hostedSpfCommentPrefix)) continue;

    const token = name.slice(0, name.indexOf('.')).replace(/-[2-9]$/, '');
    const owner = await prisma.hostedSpfRecord.findUnique({
      where: { token },
      select: { id: true, status: true, parts: true },
    });
    if (owner && owner.status !== 'RELEASED') {
      // A live row may have stale continuation names after a failed sync. Only
      // the names it still publishes are protected.
      const published = new Set(partsOf(owner).map((part) => part.name.toLowerCase()));
      if (published.has(name)) continue;
      /**
       * The zone outranks the database here. A save on another instance writes
       * its new continuations before it stores the new part list, so for a
       * moment the zone's entry record names a continuation the row does not
       * list yet. Deleting it then would leave the entry including a name that
       * does not exist, which fails SPF for every message. A name the live
       * entry record still includes is never an orphan.
       */
      const entryName = `${token}.spf.${provider.zone}`;
      const entry = await provider.get(entryName).catch(() => null);
      if (entry === null) continue;
      const referenced = entry.some((candidate) =>
        candidate.content.toLowerCase().split(/\s+/).includes(`include:${name}`),
      );
      if (referenced) continue;
    }
    try {
      await provider.remove(record.id);
      summary.removed += 1;
    } catch (error) {
      console.error(
        `[hosted-spf] could not remove orphan ${name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  return summary;
}
