import { randomInt } from 'node:crypto';
import type { HostedMtaStsChange, HostedMtaStsRecord, HostedMtaStsStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { systemDnsReader } from '../../scanner/dns.js';
import { systemHttpsGetter, type HttpsGetter } from '../../scanner/https-get.js';
import type { DnsReader, LookupResult } from '../../scanner/types.js';
import {
  mtaStsHostnamePattern,
  mxCoveredBy,
  parseMtaStsPolicy,
  parseMtaStsTxt,
} from '../../scanner/transport-records.js';
import { recordAuditEvent } from '../audit.service.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { getTlsReportSummary } from '../tls-report/tls-report-query.service.js';
import { normaliseTxtValue } from '../dns-automation/records.js';
import {
  hostedCustomHostnameClient,
  hostedDnsProvider,
  type HostedDnsProvider,
} from './provider.js';
import { uniqueHostedToken, usedHostedRecords } from './hosted-dmarc.service.js';
import { isHostedToken } from './target.js';

export const hostedMtaStsCommentPrefix = 'dmarc-harbor mta-sts ';

/** RFC 8461 §3.2 requires at least one day and allows at most a year. */
export const mtaStsMinMaxAge = 86_400;
export const mtaStsMaxMaxAge = 31_557_600;
/** §10.2 prefers long lifetimes, so enforce may not undercut a week. */
export const mtaStsEnforceMinMaxAge = 604_800;
/** How long testing must have run before enforce is offered without an override. */
export const mtaStsTestingMinDays = 14;
/** The evidence window for TLS-RPT readiness. */
export const mtaStsTlsWindowDays = 14;
/** Above this share of failed sessions, enforce is not offered. */
export const mtaStsFailureShareLimitPercent = 1;

export class HostedMtaStsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HostedMtaStsError';
  }
}

export interface MtaStsBlocker {
  code: string;
  message: string;
}

export interface HostedMtaStsChangeView {
  id: string;
  reason: string;
  previousMode: string | null;
  newMode: string;
  previousMx: string[];
  newMx: string[];
  previousMaxAge: number | null;
  newMaxAge: number;
  previousPolicyId: string | null;
  newPolicyId: string;
  readinessOverride: boolean;
  actor: { id: string; name: string } | null;
  createdAt: string;
}

export type CnameState = 'found' | 'missing' | 'elsewhere';

export interface HostedMtaStsView {
  available: boolean;
  capacity: { full: boolean; used: number; limit: number };
  hosted: null | {
    status: HostedMtaStsStatus;
    paused: boolean;
    version: number;
    mode: string;
    mx: string[];
    maxAge: number;
    policyId: string;
    policy: string;
    policyUrl: string;
    cname: { host: string; type: 'CNAME'; target: string };
    txtCname: { host: string; type: 'CNAME'; target: string };
    mtaCnameState: CnameState | null;
    txtCnameState: CnameState | null;
    delegated: boolean;
    delegationCheckedAt: string | null;
    certificate: { hostnameStatus: string | null; sslStatus: string | null; error: string | null; ready: boolean };
    uncoveredMx: string[];
    uncoveredCheckedAt: string | null;
    readiness: { ready: boolean; blockers: MtaStsBlocker[] };
    lastSyncedAt: string | null;
    lastSyncError: string | null;
    enforcedAt: string | null;
    releaseServeUntil: string | null;
    releasedAt: string | null;
    previousTxt: string | null;
    changes: HostedMtaStsChangeView[];
  };
}

export interface HostedMtaStsDeletionSnapshot {
  id: string;
  token: string;
  customHostnameId: string | null;
  txtRecordId: string | null;
}

export interface HostedMtaStsReconcileSummary {
  synced: number;
  failed: number;
  removed: number;
  released: number;
}

// ─── names, ids and the policy text ─────────────────────────────────────────

/** True when this deployment can serve hosted MTA-STS at all. */
export function hostedMtaStsAvailable(): boolean {
  return hostedDnsProvider() !== null && Boolean(env.HOSTED_MTA_STS_CNAME_TARGET);
}

function cnameTarget(): string {
  const value = env.HOSTED_MTA_STS_CNAME_TARGET;
  if (!value) {
    throw new HostedMtaStsError(
      'Hosted MTA-STS is not set up on this deployment.',
      'HOSTED_MTA_STS_UNAVAILABLE',
      503,
    );
  }
  return value;
}

/** `mta-sts.<domain>` — the name the customer points at our shared target. */
export function mtaStsCustomerHostname(domain: string): string {
  return `mta-sts.${domain}`;
}

/** `<token>._mta-sts.<zone>` — where our TXT lives. */
export function mtaStsRecordName(token: string): string {
  return `${token}._mta-sts.${env.HOSTED_DNS_ZONE ?? ''}`;
}

export function mtaStsPolicyUrl(domain: string): string {
  return `https://${mtaStsCustomerHostname(domain)}/.well-known/mta-sts.txt`;
}

/**
 * The body RFC 8461 §3.2 shows, with CRLF line endings.
 *
 * A sender parses this with a line-oriented reader, and the RFC's own example
 * is CRLF. `parseMtaStsPolicy` accepts either, so this is about matching the
 * document rather than about the parser.
 */
export function buildMtaStsPolicy(input: { mode: string; mx: string[]; maxAge: number }): string {
  const lines = ['version: STSv1', `mode: ${input.mode}`];
  for (const host of input.mx) {
    lines.push(`mx: ${host}`);
  }
  lines.push(`max_age: ${input.maxAge}`);
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * The id published in the TXT. Timestamp first so an operator reading two
 * records can tell which is newer, then two random characters so two changes
 * in the same second cannot collide. 16 characters, inside the 1–32 limit.
 */
export function nextPolicyId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let index = 0; index < 2; index += 1) {
    suffix += alphabet[randomInt(alphabet.length)];
  }
  return `${stamp}${suffix}`;
}

/** `v=STSv1; id=<policyId>` — the only thing the TXT carries. */
export function mtaStsTxtValue(policyId: string): string {
  return `v=STSv1; id=${policyId}`;
}

// ─── validation ─────────────────────────────────────────────────────────────

/**
 * Checks a policy the MSP wants published.
 *
 * The mx rules are the scanner's own hostname pattern, so a policy accepted
 * here cannot be one `parseMtaStsPolicy` later calls invalid. The one addition
 * is that `mode: none` is refused: that is what release publishes, and letting
 * it through the normal edit path would strand a row serving a policy it is not
 * releasing from.
 */
export function validateMtaStsPolicyInput(input: {
  mode: string;
  mx: string[];
  maxAge: number;
}): { mode: 'testing' | 'enforce'; mx: string[]; maxAge: number } {
  if (input.mode !== 'testing' && input.mode !== 'enforce') {
    throw new HostedMtaStsError(
      'Choose testing or enforce. A "none" policy is published by releasing, not by editing.',
      'INVALID_POLICY',
      400,
    );
  }

  const mx = input.mx.map((value) => value.trim().toLowerCase().replace(/\.+$/, '')).filter(Boolean);
  if (mx.length === 0) {
    throw new HostedMtaStsError('Add at least one MX host.', 'INVALID_POLICY', 400);
  }
  if (mx.length > 10) {
    throw new HostedMtaStsError('A policy may list at most 10 MX hosts.', 'INVALID_POLICY', 400);
  }
  for (const host of mx) {
    if (!mtaStsHostnamePattern.test(host)) {
      throw new HostedMtaStsError(
        `${host} is not a hostname or a wildcard such as *.example.com.`,
        'INVALID_POLICY',
        400,
      );
    }
  }

  if (!Number.isInteger(input.maxAge) || input.maxAge < mtaStsMinMaxAge || input.maxAge > mtaStsMaxMaxAge) {
    throw new HostedMtaStsError(
      `max_age must be between ${mtaStsMinMaxAge} and ${mtaStsMaxMaxAge} seconds.`,
      'INVALID_POLICY',
      400,
    );
  }
  if (input.mode === 'enforce' && input.maxAge < mtaStsEnforceMinMaxAge) {
    throw new HostedMtaStsError(
      `An enforcing policy needs a max_age of at least ${mtaStsEnforceMinMaxAge} seconds (one week).`,
      'INVALID_POLICY',
      400,
    );
  }

  return { mode: input.mode, mx, maxAge: input.maxAge };
}

// ─── provider writes ────────────────────────────────────────────────────────

interface SyncResult {
  ok: boolean;
  error?: string;
}

function commentFor(row: { id: string }): string {
  return `${hostedMtaStsCommentPrefix}${row.id}`;
}

async function removeOurRecords(
  provider: HostedDnsProvider,
  target: { id: string; token: string; txtRecordId: string | null },
): Promise<void> {
  const records = await provider.get(mtaStsRecordName(target.token));
  const comment = `${hostedMtaStsCommentPrefix}${target.id}`;
  for (const record of records) {
    if (record.id === target.txtRecordId || record.comment === comment) {
      await provider.remove(record.id);
    }
  }
}

/**
 * Publishes the row's TXT. A provider failure is recorded on the row and
 * returned, never thrown: the reconciler retries, and a policy change that
 * already committed must not look like it failed.
 */
export async function syncMtaStsValue(row: HostedMtaStsRecord): Promise<SyncResult> {
  const provider = hostedDnsProvider();
  if (!provider) {
    return { ok: false, error: 'Hosted MTA-STS is not set up on this deployment.' };
  }

  const name = mtaStsRecordName(row.token);
  const value = mtaStsTxtValue(row.policyId);
  try {
    const records = await provider.get(name);
    const managed = records.filter(
      (record) => record.comment === commentFor(row) || record.id === row.txtRecordId,
    );
    let chosen = managed.find((record) => record.id === row.txtRecordId) ?? managed[0] ?? null;
    if (!chosen) {
      chosen = await provider.create(name, value, commentFor(row));
    } else if (normaliseTxtValue(chosen.content) !== normaliseTxtValue(value)) {
      chosen = await provider.update(chosen, value);
    }
    for (const extra of managed) {
      if (extra.id !== chosen.id) {
        await provider.remove(extra.id);
      }
    }

    await prisma.hostedMtaStsRecord.update({
      where: { id: row.id },
      data: { txtRecordId: chosen.id, lastSyncedAt: new Date(), lastSyncError: null },
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The DNS provider refused the change.';
    await prisma.hostedMtaStsRecord
      .update({ where: { id: row.id }, data: { lastSyncError: message } })
      .catch(() => undefined);
    return { ok: false, error: message };
  }
}

// ─── reads ──────────────────────────────────────────────────────────────────

let readerOverride: DnsReader | null = null;
let httpsOverride: HttpsGetter | null = null;

/** Test seams for the DNS and HTTPS reads start and check make. */
export function setHostedMtaStsReaderForTests(reader: DnsReader | null): void {
  readerOverride = reader;
}

export function setHostedMtaStsHttpsForTests(getter: HttpsGetter | null): void {
  httpsOverride = getter;
}

function dnsReader(reader?: DnsReader): DnsReader {
  return reader ?? readerOverride ?? systemDnsReader;
}

function httpsGetter(getter?: HttpsGetter): HttpsGetter {
  return getter ?? httpsOverride ?? systemHttpsGetter;
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

async function capacityState(): Promise<{ full: boolean; used: number; limit: number }> {
  // A released row whose hostname Cloudflare would not delete still holds one.
  const used = await prisma.hostedMtaStsRecord.count({
    where: { OR: [{ status: { not: 'RELEASED' } }, { customHostnameId: { not: null } }] },
  });
  return { full: used >= env.HOSTED_MTA_STS_HOSTNAME_LIMIT, used, limit: env.HOSTED_MTA_STS_HOSTNAME_LIMIT };
}

/** The MX hosts the domain actually receives mail on, or null when unknown. */
async function currentMxHosts(domain: string, reader: DnsReader): Promise<string[] | null> {
  try {
    const lookup = await reader.resolveMx(domain);
    if (lookup.status !== 'found') return null;
    const hosts = (lookup.value ?? [])
      .map((record) => record.exchange.trim().toLowerCase().replace(/\.+$/, ''))
      .filter(Boolean);
    return hosts.length > 0 ? [...new Set(hosts)] : null;
  } catch {
    return null;
  }
}

interface CurrentMtaSts {
  previousTxt: string | null;
  previousPolicy: string | null;
  policy: { mode: 'testing' | 'enforce'; mx: string[]; maxAge: number } | null;
}

/**
 * What the domain publishes today.
 *
 * A TXT that is already there is kept verbatim so a hand-back can reproduce it,
 * and its policy is fetched only to import the settings a sender already sees.
 * Every failure here is "nothing to import" rather than an error: a domain with
 * a broken policy can still start hosting, and refusing would strand exactly
 * the customer who needs it.
 */
async function readCurrentMtaSts(input: {
  domain: string;
  reader: DnsReader;
  https: HttpsGetter;
}): Promise<CurrentMtaSts> {
  const empty: CurrentMtaSts = { previousTxt: null, previousPolicy: null, policy: null };
  try {
    const lookup = await input.reader.resolveTxt(`_mta-sts.${input.domain}`);
    if (lookup.status !== 'found') return empty;
    const parsedTxt = parseMtaStsTxt(lookup.value ?? []);
    const record = parsedTxt.record ?? null;
    if (!record || parsedTxt.recordProblem) {
      return { previousTxt: record, previousPolicy: null, policy: null };
    }

    const fetched = await input.https.get(mtaStsPolicyUrl(input.domain), {
      maxBytes: 65_536,
      accept: 'text/plain',
    });
    if (fetched.status !== 'ok') {
      return { previousTxt: record, previousPolicy: null, policy: null };
    }
    const text = fetched.body.toString('utf8');
    const parsed = parseMtaStsPolicy(text, fetched.contentType);
    if (!parsed.valid || !parsed.mode || parsed.mode === 'none' || parsed.maxAge === undefined) {
      return { previousTxt: record, previousPolicy: text.slice(0, 2_000), policy: null };
    }
    return {
      previousTxt: record,
      previousPolicy: text.slice(0, 2_000),
      policy: { mode: parsed.mode, mx: parsed.mx ?? [], maxAge: parsed.maxAge },
    };
  } catch {
    return empty;
  }
}

// ─── readiness ──────────────────────────────────────────────────────────────

/**
 * Why moving to enforce would be premature, in the words the panel shows.
 *
 * Every blocker is a fact about this domain today, not a policy preference: an
 * uncovered MX host is a delivery refusal, a short testing window has not
 * produced evidence, and the TLS numbers are what receivers already reported.
 */
export async function mtaStsReadiness(input: {
  organizationId: string;
  domain: { id: string; name: string };
  record: { mx: string[]; status: HostedMtaStsStatus };
  reader?: DnsReader;
  now?: Date;
}): Promise<MtaStsBlocker[]> {
  const now = input.now ?? new Date();
  const blockers: MtaStsBlocker[] = [];
  const reader = dnsReader(input.reader);

  const hosts = await currentMxHosts(input.domain.name, reader);
  if (hosts === null) {
    blockers.push({
      code: 'mx_lookup_failed',
      message: `The MX lookup for ${input.domain.name} failed, so no one can say whether this policy covers every mail server. Try again in a few minutes.`,
    });
  } else {
    const uncovered = hosts.filter((host) => !mxCoveredBy(host, input.record.mx));
    if (uncovered.length > 0) {
      blockers.push({
        code: 'mx_not_covered',
        message: `The policy does not cover ${uncovered.join(', ')}. Senders that apply it would refuse to deliver there.`,
      });
    }
  }

  // How long the policy has been in testing, from the last change INTO testing:
  // the start, or a move from another mode. An edit made while already in
  // testing (adding an MX host, say) does not restart the clock.
  const intoTesting = await prisma.hostedMtaStsChange.findFirst({
    where: {
      record: { domainId: input.domain.id },
      newMode: 'testing',
      OR: [{ previousMode: null }, { previousMode: { not: 'testing' } }],
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const testingSince = intoTesting?.createdAt ?? null;
  if (testingSince) {
    const days = Math.floor((now.getTime() - testingSince.getTime()) / (24 * 60 * 60 * 1000));
    if (days < mtaStsTestingMinDays) {
      blockers.push({
        code: 'testing_too_short',
        message: `Testing started ${days} day${days === 1 ? '' : 's'} ago. Enforce is offered after ${mtaStsTestingMinDays} days of evidence.`,
      });
    }
  }

  const summary = await getTlsReportSummary(input.organizationId, input.domain.id, mtaStsTlsWindowDays);
  if (summary) {
    if (summary.reportCount === 0) {
      blockers.push({
        code: 'no_tls_reports',
        message: `No TLS report has arrived in the last ${mtaStsTlsWindowDays} days, so there is no evidence that every sender completes TLS. Publishing TLS-RPT is what produces them.`,
      });
    } else if (
      summary.failureSharePercent !== null &&
      summary.failureSharePercent > mtaStsFailureShareLimitPercent
    ) {
      const topResult = summary.byResultType[0];
      const topHost = summary.byMxHost[0];
      const detail = [
        topResult ? `the most common reason is ${topResult.resultType}` : null,
        topHost ? `on ${topHost.receivingMxHostname}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      blockers.push({
        code: 'tls_failures',
        message: `${summary.failureSharePercent.toFixed(1)}% of sessions failed in the last ${mtaStsTlsWindowDays} days${detail ? `, and ${detail}` : ''}. Enforce would turn those into delivery failures.`,
      });
    }
  }

  return blockers;
}

/**
 * Why removing patterns from an enforcing policy would refuse delivery.
 *
 * Only hosts the old list covered and the new one does not are blockers. A
 * host that was already uncovered is the banner's problem, not this edit's,
 * and blocking on it would stop someone tidying the list while they fix it.
 */
export async function mtaStsRemovalBlockers(input: {
  domainName: string;
  previousMx: string[];
  nextMx: string[];
  reader?: DnsReader;
}): Promise<MtaStsBlocker[]> {
  const hosts = await currentMxHosts(input.domainName, dnsReader(input.reader));
  if (hosts === null) {
    return [
      {
        code: 'mx_lookup_failed',
        message: `The MX lookup for ${input.domainName} failed, so no one can say whether removing these patterns leaves a mail server uncovered. Try again in a few minutes.`,
      },
    ];
  }
  const lost = hosts.filter((host) => mxCoveredBy(host, input.previousMx) && !mxCoveredBy(host, input.nextMx));
  if (lost.length === 0) return [];
  return [
    {
      code: 'mx_not_covered',
      message: `The policy would no longer cover ${lost.join(', ')}. Senders that apply it would refuse to deliver there.`,
    },
  ];
}

// ─── view ───────────────────────────────────────────────────────────────────

async function changesFor(row: HostedMtaStsRecord): Promise<HostedMtaStsChangeView[]> {
  const changes = await prisma.hostedMtaStsChange.findMany({
    where: { recordId: row.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
  });
  const actorIds = [
    ...new Set(changes.map((change) => change.actorUserId).filter((id): id is string => Boolean(id))),
  ];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));
  return changes.map((change) => toChangeView(change, actorById));
}

function toChangeView(
  change: HostedMtaStsChange,
  actorById: Map<string, { id: string; name: string }>,
): HostedMtaStsChangeView {
  return {
    id: change.id,
    reason: change.reason,
    previousMode: change.previousMode,
    newMode: change.newMode,
    previousMx: change.previousMx,
    newMx: change.newMx,
    previousMaxAge: change.previousMaxAge,
    newMaxAge: change.newMaxAge,
    previousPolicyId: change.previousPolicyId,
    newPolicyId: change.newPolicyId,
    readinessOverride: change.readinessOverride,
    actor: change.actorUserId
      ? { id: change.actorUserId, name: actorById.get(change.actorUserId)?.name ?? 'A former member' }
      : null,
    createdAt: change.createdAt.toISOString(),
  };
}

function certificateState(row: HostedMtaStsRecord): {
  hostnameStatus: string | null;
  sslStatus: string | null;
  error: string | null;
  ready: boolean;
} {
  const ready = row.hostnameStatus === 'active' && row.sslStatus === 'active';
  return {
    hostnameStatus: row.hostnameStatus,
    sslStatus: row.sslStatus,
    error: row.sslError,
    ready,
  };
}

async function viewFor(
  organizationId: string,
  domain: { id: string; name: string },
  row: HostedMtaStsRecord | null,
): Promise<HostedMtaStsView> {
  const capacity = await capacityState();
  if (!hostedMtaStsAvailable()) {
    return { available: false, hosted: null, capacity };
  }
  if (!row) {
    return { available: true, hosted: null, capacity };
  }

  const entitlements = await resolveEntitlements(organizationId);
  const paused = entitlements.features['dns.hostedMtaSts'] !== true;
  const [changes, blockers] = await Promise.all([
    changesFor(row),
    row.status === 'RELEASED'
      ? Promise.resolve([] as MtaStsBlocker[])
      : mtaStsReadiness({ organizationId, domain, record: row }),
  ]);

  return {
    available: true,
    capacity,
    hosted: {
      status: row.status,
      paused,
      version: row.version,
      mode: row.mode,
      mx: row.mx,
      maxAge: row.maxAge,
      policyId: row.policyId,
      policy: buildMtaStsPolicy({ mode: row.mode, mx: row.mx, maxAge: row.maxAge }),
      policyUrl: mtaStsPolicyUrl(domain.name),
      cname: {
        host: mtaStsCustomerHostname(domain.name),
        type: 'CNAME',
        target: cnameTarget(),
      },
      txtCname: {
        host: `_mta-sts.${domain.name}`,
        type: 'CNAME',
        target: mtaStsRecordName(row.token),
      },
      mtaCnameState: (row.mtaCnameState as CnameState | null) ?? null,
      txtCnameState: (row.txtCnameState as CnameState | null) ?? null,
      delegated: row.delegated,
      delegationCheckedAt: row.delegationCheckedAt?.toISOString() ?? null,
      certificate: certificateState(row),
      uncoveredMx: row.uncoveredMx,
      uncoveredCheckedAt: row.uncoveredCheckedAt?.toISOString() ?? null,
      readiness: { ready: blockers.length === 0, blockers },
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastSyncError: row.lastSyncError,
      enforcedAt: row.enforcedAt?.toISOString() ?? null,
      releaseServeUntil: row.releaseServeUntil?.toISOString() ?? null,
      releasedAt: row.releasedAt?.toISOString() ?? null,
      previousTxt: row.previousTxt,
      changes,
    },
  };
}

export async function hostedMtaStsView(
  organizationId: string,
  domainRefOrId: string,
): Promise<HostedMtaStsView> {
  const domain = await domainFor(organizationId, domainRefOrId);
  if (!domain) {
    throw new HostedMtaStsError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedMtaStsRecord.findUnique({ where: { domainId: domain.id } });
  return viewFor(organizationId, domain, row);
}

// ─── start ──────────────────────────────────────────────────────────────────

async function uniqueMtaStsToken(): Promise<string> {
  return uniqueHostedToken(async (candidate) => {
    const [dmarc, spf, bimi, mtaSts] = await Promise.all([
      prisma.hostedDmarcRecord.findUnique({ where: { token: candidate }, select: { id: true } }),
      prisma.hostedSpfRecord.findUnique({ where: { token: candidate }, select: { id: true } }),
      prisma.hostedBimiRecord.findUnique({ where: { token: candidate }, select: { id: true } }),
      prisma.hostedMtaStsRecord.findUnique({ where: { token: candidate }, select: { id: true } }),
    ]);
    return Boolean(dmarc || spf || bimi || mtaSts);
  });
}

export async function startHostedMtaSts(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
  reader?: DnsReader;
  https?: HttpsGetter;
}): Promise<HostedMtaStsView> {
  if (!hostedMtaStsAvailable()) {
    throw new HostedMtaStsError(
      'Hosted MTA-STS is not set up on this deployment.',
      'HOSTED_MTA_STS_UNAVAILABLE',
      503,
    );
  }
  cnameTarget();

  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new HostedMtaStsError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  if (domain.status !== 'VERIFIED') {
    throw new HostedMtaStsError(
      'Verify the domain before hosting its MTA-STS policy.',
      'DOMAIN_NOT_VERIFIED',
      409,
    );
  }

  const existing = await prisma.hostedMtaStsRecord.findUnique({ where: { domainId: domain.id } });
  if (existing && existing.status !== 'RELEASED') {
    throw new HostedMtaStsError(
      'This domain already has a hosted MTA-STS policy.',
      'ALREADY_HOSTED',
      409,
    );
  }

  const capacity = await capacityState();
  if (capacity.full) {
    throw new HostedMtaStsError(
      `Hosted MTA-STS is full on this deployment (${capacity.limit} custom hostnames). Publish the policy yourself, or ask the operator to raise HOSTED_MTA_STS_HOSTNAME_LIMIT.`,
      'HOSTED_MTA_STS_FULL',
      503,
    );
  }
  const recordsInUse = await usedHostedRecords();
  if (recordsInUse >= env.HOSTED_DNS_RECORD_LIMIT) {
    throw new HostedMtaStsError(
      'Hosting is full on this deployment right now. Publish the policy yourself.',
      'HOSTED_DNS_FULL',
      503,
    );
  }

  const reader = dnsReader(input.reader);
  const https = httpsGetter(input.https);

  // A policy with a guessed MX list is worse than none: senders would refuse
  // to deliver to the host that was left out. Refused rather than defaulted.
  const hosts = await currentMxHosts(domain.name, reader);
  if (hosts === null) {
    throw new HostedMtaStsError(
      `The MX lookup for ${domain.name} failed. Nothing was created; try again in a few minutes.`,
      'DNS_LOOKUP_FAILED',
      503,
    );
  }

  const current = await readCurrentMtaSts({ domain: domain.name, reader, https });
  const initial = current.policy ?? {
    mode: 'testing' as const,
    mx: hosts,
    maxAge: mtaStsMinMaxAge,
  };

  if (existing) {
    // A released row is replaced: its token was in a CNAME that no longer
    // points here. If Cloudflare refused to delete its custom hostname at
    // release, that is retried now. Deleting the row first would lose the only
    // record of the id, and Cloudflare refuses a second hostname with the same
    // name anyway.
    if (!(await removeCustomHostname(existing))) {
      throw new HostedMtaStsError(
        'The previous custom hostname for this domain could not be removed from Cloudflare yet. Try again in a few minutes.',
        'HOSTED_MTA_STS_PROVIDER_FAILED',
        502,
      );
    }
    await prisma.hostedMtaStsRecord.delete({ where: { id: existing.id } });
  }

  const token = await uniqueMtaStsToken();
  let row: HostedMtaStsRecord;
  try {
    row = await prisma.hostedMtaStsRecord.create({
      data: {
        organizationId: input.organizationId,
        domainId: domain.id,
        token,
        status: 'PENDING',
        mode: initial.mode,
        mx: initial.mx,
        maxAge: initial.maxAge,
        policyId: nextPolicyId(),
        previousTxt: current.previousTxt,
        previousPolicy: current.previousPolicy,
        createdById: input.actorUserId,
      },
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002') {
      throw new HostedMtaStsError(
        'This domain already has a hosted MTA-STS policy.',
        'ALREADY_HOSTED',
        409,
      );
    }
    throw error;
  }

  // The certificate is Cloudflare's job; the row exists first so a hostname is
  // never created without something to attach it to.
  const client = hostedCustomHostnameClient();
  if (!client) {
    await prisma.hostedMtaStsRecord.delete({ where: { id: row.id } }).catch(() => undefined);
    throw new HostedMtaStsError(
      'Hosted MTA-STS is not set up on this deployment.',
      'HOSTED_MTA_STS_UNAVAILABLE',
      503,
    );
  }
  let hostname: { id: string; status: string | null; sslStatus: string | null; sslError: string | null };
  try {
    hostname = await client.create(mtaStsCustomerHostname(domain.name));
  } catch (error) {
    await prisma.hostedMtaStsRecord.delete({ where: { id: row.id } }).catch(() => undefined);
    throw new HostedMtaStsError(
      error instanceof Error ? error.message : 'Cloudflare refused the custom hostname.',
      'HOSTED_MTA_STS_PROVIDER_FAILED',
      502,
    );
  }

  row = await prisma.hostedMtaStsRecord.update({
    where: { id: row.id },
    data: {
      customHostnameId: hostname.id,
      hostnameStatus: hostname.status,
      sslStatus: hostname.sslStatus,
      sslError: hostname.sslError,
    },
  });

  const synced = await syncMtaStsValue(row);
  if (!synced.ok) {
    // The TXT is what a sender reads. Without it the row would be a promise the
    // DNS does not keep, so the whole start is undone.
    await client.remove(hostname.id).catch(() => undefined);
    await prisma.hostedMtaStsRecord.delete({ where: { id: row.id } }).catch(() => undefined);
    throw new HostedMtaStsError(
      synced.error ?? 'The DNS provider refused the record.',
      'HOSTED_MTA_STS_PROVIDER_FAILED',
      502,
    );
  }

  await prisma.hostedMtaStsChange.create({
    data: {
      recordId: row.id,
      organizationId: input.organizationId,
      reason: 'created',
      newMode: initial.mode,
      newMx: initial.mx,
      newMaxAge: initial.maxAge,
      newPolicyId: row.policyId,
      actorUserId: input.actorUserId,
    },
  });
  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'HOSTED_MTA_STS_CREATED',
    targetType: 'domain',
    targetId: domain.id,
    detail: {
      domainName: domain.name,
      mode: initial.mode,
      mx: initial.mx,
      maxAge: initial.maxAge,
      imported: Boolean(current.policy),
    },
  });

  const fresh = await prisma.hostedMtaStsRecord.findUniqueOrThrow({ where: { id: row.id } });
  return viewFor(input.organizationId, domain, fresh);
}

// ─── check ──────────────────────────────────────────────────────────────────

function cnameStateOf(lookup: LookupResult<string[]> | null, expected: string): CnameState {
  if (!lookup || lookup.status === 'missing') return 'missing';
  const target = lookup.status === 'found' ? lookup.value?.[0] ?? null : null;
  if (!target) return 'missing';
  return target.trim().toLowerCase().replace(/\.+$/, '') === expected ? 'found' : 'elsewhere';
}

/**
 * Deletes the row's custom hostname. True when it is gone (or there was none),
 * false when Cloudflare refused, with the reason recorded on the row.
 */
async function removeCustomHostname(row: { id: string; customHostnameId: string | null }): Promise<boolean> {
  if (!row.customHostnameId) return true;
  const client = hostedCustomHostnameClient();
  if (!client) return false;
  try {
    await client.remove(row.customHostnameId);
    return true;
  } catch (error) {
    await prisma.hostedMtaStsRecord
      .update({
        where: { id: row.id },
        data: { lastSyncError: error instanceof Error ? error.message : 'Cloudflare refused the removal.' },
      })
      .catch(() => undefined);
    return false;
  }
}

/** Completes a release: hostname gone, TXT gone, row closed. */
async function completeRelease(
  row: HostedMtaStsRecord,
  input: { organizationId: string; domainId: string; domainName: string; now: Date; actorUserId?: string },
): Promise<HostedMtaStsRecord> {
  // A hostname we cannot delete is still ours and still billed, and the row is
  // the only record of its id: custom hostnames carry no comment, so nothing
  // else could ever find it again. The id is kept until a removal succeeds, and
  // the reconciler retries it.
  const hostnameRemoved = await removeCustomHostname(row);
  const provider = hostedDnsProvider();
  if (provider) {
    await removeOurRecords(provider, row).catch(() => undefined);
  }

  const released = await prisma.hostedMtaStsRecord.update({
    where: { id: row.id },
    data: {
      status: 'RELEASED',
      releasedAt: input.now,
      ...(hostnameRemoved ? { customHostnameId: null } : {}),
      txtRecordId: null,
      delegated: false,
    },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'HOSTED_MTA_STS_RELEASED',
    targetType: 'domain',
    targetId: input.domainId,
    detail: { domainName: input.domainName },
  });

  return released;
}

export async function checkMtaStsDelegation(input: {
  organizationId: string;
  domainId: string;
  reader?: DnsReader;
  https?: HttpsGetter;
  scanId?: string;
  previousScanId?: string | null;
}): Promise<HostedMtaStsView> {
  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new HostedMtaStsError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedMtaStsRecord.findUnique({ where: { domainId: domain.id } });
  if (!row) {
    throw new HostedMtaStsError(
      'This domain does not have a hosted MTA-STS policy.',
      'NOT_HOSTED',
      404,
    );
  }
  if (row.status === 'RELEASED') {
    return viewFor(input.organizationId, domain, row);
  }

  const reader = dnsReader(input.reader);
  const now = new Date();

  /**
   * Both CNAMEs, read together. A failed lookup says nothing about delegation,
   * so it changes nothing at all: reading the TXT through a CNAME that still
   * points here returns our own record, which looks exactly like "the customer
   * published their own" and would release a policy senders still apply.
   */
  const [mtaLookup, txtLookup] = await Promise.all([
    reader.resolveCname ? reader.resolveCname(mtaStsCustomerHostname(domain.name)) : Promise.resolve(null),
    reader.resolveCname ? reader.resolveCname(`_mta-sts.${domain.name}`) : Promise.resolve(null),
  ]);
  if (!mtaLookup || mtaLookup.status === 'error' || !txtLookup || txtLookup.status === 'error') {
    return viewFor(input.organizationId, domain, row);
  }

  const expectedMta = cnameTarget();
  const mtaCnameState = cnameStateOf(mtaLookup, expectedMta);
  const txtCnameState = cnameStateOf(txtLookup, mtaStsRecordName(row.token));
  const delegated = mtaCnameState === 'found' && txtCnameState === 'found';

  let update: Parameters<typeof prisma.hostedMtaStsRecord.update>[0]['data'] = {
    mtaCnameState,
    txtCnameState,
    delegated,
    delegationCheckedAt: now,
  };

  // Cloudflare's view of the certificate. A read that fails changes nothing,
  // because "could not ask" is not "the certificate is broken".
  const client = hostedCustomHostnameClient();
  let certificateReady = row.hostnameStatus === 'active' && row.sslStatus === 'active';
  if (client && row.customHostnameId) {
    try {
      const hostname = await client.get(row.customHostnameId);
      update = {
        ...update,
        hostnameStatus: hostname.status,
        sslStatus: hostname.sslStatus,
        sslError: hostname.sslError,
      };
      certificateReady = hostname.status === 'active' && hostname.sslStatus === 'active';
    } catch {
      // unchanged
    }
  }

  if (row.status === 'PENDING' && delegated && certificateReady) {
    update = { ...update, status: 'ACTIVE' };
  }

  const updated = await prisma.hostedMtaStsRecord.update({ where: { id: row.id }, data: update });

  // What the domain really receives mail on, recorded for the banner and for
  // the notification. Never applied to the policy automatically: MTA-STS exists
  // to protect against a forged MX, so following DNS would defeat it.
  const hosts = await currentMxHosts(domain.name, reader);
  let finalRow = updated;
  if (hosts !== null) {
    const uncovered = hosts.filter((host) => !mxCoveredBy(host, updated.mx));
    finalRow = await prisma.hostedMtaStsRecord.update({
      where: { id: row.id },
      data: { uncoveredMx: uncovered, uncoveredCheckedAt: now },
    });
    if (uncovered.length > 0 && finalRow.mode === 'enforce' && finalRow.status === 'ACTIVE') {
      await raiseUncoveredMxNotification({
        organizationId: input.organizationId,
        domain,
        uncovered,
        scanId: input.scanId,
        previousScanId: input.previousScanId,
        now,
      });
    }
  }

  if (finalRow.status === 'RELEASING') {
    const due = finalRow.releaseServeUntil !== null && finalRow.releaseServeUntil.getTime() <= now.getTime();
    const ownPolicy = await customerPolicyTakesOver({
      domain: domain.name,
      mtaCnameState,
      txtCnameState,
      reader,
      https: httpsGetter(input.https),
    });
    if (due || ownPolicy) {
      finalRow = await completeRelease(finalRow, {
        organizationId: input.organizationId,
        domainId: domain.id,
        domainName: domain.name,
        now,
      });
    }
  }

  return viewFor(input.organizationId, domain, finalRow);
}

/**
 * Whether the customer now serves a valid policy of their own.
 *
 * Only asked when neither name points at us any more. While `_mta-sts` does,
 * the TXT read follows our CNAME and returns our own record. While `mta-sts`
 * does, the policy fetch reaches this API and returns our own `mode: none`,
 * which is valid and would look like the customer's; completing the release
 * then deletes the hostname their TXT still sends senders to.
 */
async function customerPolicyTakesOver(input: {
  domain: string;
  mtaCnameState: CnameState;
  txtCnameState: CnameState;
  reader: DnsReader;
  https: HttpsGetter;
}): Promise<boolean> {
  if (input.txtCnameState === 'found' || input.mtaCnameState === 'found') return false;
  try {
    const txt = await input.reader.resolveTxt(`_mta-sts.${input.domain}`);
    if (txt.status !== 'found') return false;
    const parsedTxt = parseMtaStsTxt(txt.value ?? []);
    if (parsedTxt.recordProblem || !parsedTxt.id) return false;
    const fetched = await input.https.get(mtaStsPolicyUrl(input.domain), {
      maxBytes: 65_536,
      accept: 'text/plain',
    });
    if (fetched.status !== 'ok') return false;
    return parseMtaStsPolicy(fetched.body.toString('utf8'), fetched.contentType).valid;
  } catch {
    return false;
  }
}

/**
 * Records an uncovered MX host through the path critical DNS changes already
 * use: a DnsChange row the notification job turns into in-app notifications,
 * email and Slack. No new channel, and no row when one is already open.
 */
async function raiseUncoveredMxNotification(input: {
  organizationId: string;
  domain: { id: string; name: string };
  uncovered: string[];
  scanId?: string;
  previousScanId?: string | null;
  now: Date;
}): Promise<void> {
  if (!input.scanId) return;
  try {
    const open = await prisma.dnsChange.findFirst({
      where: {
        domainId: input.domain.id,
        code: 'mta_sts_mx_not_covered',
        acknowledgedAt: null,
        detectedAt: { gte: new Date(input.now.getTime() - 24 * 60 * 60 * 1000) },
      },
      select: { id: true },
    });
    if (open) return;

    await prisma.dnsChange.create({
      data: {
        organizationId: input.organizationId,
        domainId: input.domain.id,
        scanId: input.scanId,
        previousScanId: input.previousScanId ?? null,
        kind: 'MTA_STS',
        severity: 'CRITICAL',
        code: 'mta_sts_mx_not_covered',
        summary: `${input.domain.name} receives mail on ${input.uncovered.join(', ')}, which the enforcing MTA-STS policy does not cover. Senders that apply it refuse to deliver there.`,
        after: { uncoveredMx: input.uncovered },
        detectedAt: input.now,
      },
    });
  } catch (error) {
    console.warn(
      `[hosted-mta-sts] could not record the uncovered MX notification for ${input.domain.name}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

// ─── policy change ──────────────────────────────────────────────────────────

async function versionConflict(
  organizationId: string,
  domain: { id: string; name: string },
): Promise<never> {
  const current = await prisma.hostedMtaStsRecord.findUnique({ where: { domainId: domain.id } });
  const view = await viewFor(organizationId, domain, current);
  throw new HostedMtaStsError(
    'Someone else changed this policy. Reload and try again.',
    'VERSION_CHANGED',
    409,
    { view },
  );
}

export async function changeMtaStsPolicy(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
  expectedVersion: number;
  mode: string;
  mx: string[];
  maxAge: number;
  override?: boolean;
  reader?: DnsReader;
}): Promise<HostedMtaStsView & { action: 'updated' | 'unchanged' }> {
  if (!hostedMtaStsAvailable()) {
    throw new HostedMtaStsError(
      'Hosted MTA-STS is not set up on this deployment.',
      'HOSTED_MTA_STS_UNAVAILABLE',
      503,
    );
  }
  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new HostedMtaStsError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedMtaStsRecord.findUnique({ where: { domainId: domain.id } });
  if (!row) {
    throw new HostedMtaStsError(
      'This domain does not have a hosted MTA-STS policy.',
      'NOT_HOSTED',
      404,
    );
  }
  if (row.status === 'RELEASING' || row.status === 'RELEASED') {
    throw new HostedMtaStsError(
      'This policy is being released and cannot be changed.',
      'HOSTED_MTA_STS_RELEASING',
      409,
    );
  }
  if (input.expectedVersion !== row.version) {
    return versionConflict(input.organizationId, domain);
  }

  const next = validateMtaStsPolicyInput({ mode: input.mode, mx: input.mx, maxAge: input.maxAge });
  const unchanged =
    next.mode === row.mode &&
    next.maxAge === row.maxAge &&
    next.mx.length === row.mx.length &&
    next.mx.every((host, index) => host === row.mx[index]);
  if (unchanged) {
    return { ...(await viewFor(input.organizationId, domain, row)), action: 'unchanged' };
  }

  // Moving to enforce is the one change that can refuse delivery, so it is the
  // one that has to be ready. Moving back to testing is always allowed.
  let blockers: MtaStsBlocker[] = [];
  if (next.mode === 'enforce' && row.mode !== 'enforce') {
    blockers = await mtaStsReadiness({
      organizationId: input.organizationId,
      domain,
      record: { mx: next.mx, status: row.status },
      reader: input.reader,
    });
  } else if (next.mode === 'enforce' && row.mx.some((pattern) => !next.mx.includes(pattern))) {
    // Already enforcing, and a pattern is being removed. That is the edit that
    // can refuse delivery to a server the domain uses today, so the coverage
    // check runs again. Adding a host or changing max_age cannot uncover
    // anything, which keeps the one-click "add" free of blockers.
    blockers = await mtaStsRemovalBlockers({
      domainName: domain.name,
      previousMx: row.mx,
      nextMx: next.mx,
      reader: input.reader,
    });
  }
  if (blockers.length > 0 && input.override !== true) {
    throw new HostedMtaStsError(
      'This policy is not ready to enforce: resolve the blockers or publish anyway.',
      'POLICY_NOT_READY',
      409,
      { blockers },
    );
  }
  const overridden = blockers.length > 0 && input.override === true;
  const policyId = nextPolicyId();

  let changeId: string;
  try {
    changeId = await prisma.$transaction(async (transaction) => {
      const updated = await transaction.hostedMtaStsRecord.updateMany({
        where: { id: row.id, version: input.expectedVersion },
        data: {
          mode: next.mode,
          mx: next.mx,
          maxAge: next.maxAge,
          policyId,
          version: { increment: 1 },
          ...(next.mode === 'enforce' ? { enforcedAt: row.enforcedAt ?? new Date() } : {}),
        },
      });
      if (updated.count === 0) {
        throw new HostedMtaStsError(
          'Someone else changed this policy. Reload and try again.',
          'VERSION_CHANGED',
          409,
        );
      }
      const change = await transaction.hostedMtaStsChange.create({
        data: {
          recordId: row.id,
          organizationId: input.organizationId,
          reason: 'policy',
          previousMode: row.mode,
          newMode: next.mode,
          previousMx: row.mx,
          newMx: next.mx,
          previousMaxAge: row.maxAge,
          newMaxAge: next.maxAge,
          previousPolicyId: row.policyId,
          newPolicyId: policyId,
          readinessOverride: overridden,
          actorUserId: input.actorUserId,
        },
      });
      return change.id;
    });
  } catch (error) {
    if (error instanceof HostedMtaStsError && error.code === 'VERSION_CHANGED') {
      return versionConflict(input.organizationId, domain);
    }
    throw error;
  }

  const updatedRow = await prisma.hostedMtaStsRecord.findUniqueOrThrow({ where: { id: row.id } });
  const synced = await syncMtaStsValue(updatedRow);
  if (!synced.ok) {
    // The TXT is what makes a sender fetch the new policy. A policy change the
    // TXT does not announce is a change nobody sees, so it is rolled back.
    await prisma.$transaction(async (transaction) => {
      await transaction.hostedMtaStsChange.delete({ where: { id: changeId } }).catch(() => undefined);
      await transaction.hostedMtaStsRecord.updateMany({
        where: { id: row.id, version: input.expectedVersion + 1 },
        data: {
          mode: row.mode,
          mx: row.mx,
          maxAge: row.maxAge,
          policyId: row.policyId,
          version: input.expectedVersion,
          enforcedAt: row.enforcedAt,
        },
      });
    });
    throw new HostedMtaStsError(
      synced.error ?? 'The DNS provider refused the change.',
      'HOSTED_MTA_STS_PROVIDER_FAILED',
      502,
    );
  }

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'HOSTED_MTA_STS_UPDATED',
    targetType: 'domain',
    targetId: domain.id,
    detail: {
      domainName: domain.name,
      from: { mode: row.mode, mx: row.mx, maxAge: row.maxAge },
      to: { mode: next.mode, mx: next.mx, maxAge: next.maxAge },
      policyId,
      ...(overridden ? { override: true, blockers: blockers.map((blocker) => blocker.message) } : {}),
    },
  });

  const fresh = await prisma.hostedMtaStsRecord.findUniqueOrThrow({ where: { id: row.id } });
  return { ...(await viewFor(input.organizationId, domain, fresh)), action: 'updated' };
}

// ─── release ────────────────────────────────────────────────────────────────

/**
 * How long we must keep serving a `none` policy after a release.
 *
 * RFC 8461 §8.3: a sender that cached the old policy keeps applying it until
 * its max_age expires. The longest lifetime served in the last year is the
 * worst case, plus a day for clock skew and a cache that refreshes late.
 */
async function releaseServeWindow(row: HostedMtaStsRecord, now: Date): Promise<Date> {
  const since = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const changes = await prisma.hostedMtaStsChange.findMany({
    where: { recordId: row.id, createdAt: { gte: since } },
    select: { newMaxAge: true },
  });
  const longest = Math.max(row.maxAge, ...changes.map((change) => change.newMaxAge), mtaStsMinMaxAge);
  return new Date(now.getTime() + longest * 1000 + 24 * 60 * 60 * 1000);
}

export async function requestMtaStsRelease(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
}): Promise<HostedMtaStsView> {
  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new HostedMtaStsError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedMtaStsRecord.findUnique({ where: { domainId: domain.id } });
  if (!row) {
    throw new HostedMtaStsError(
      'This domain does not have a hosted MTA-STS policy.',
      'NOT_HOSTED',
      404,
    );
  }
  if (row.status === 'RELEASED') {
    return viewFor(input.organizationId, domain, row);
  }
  if (row.status === 'RELEASING') {
    return viewFor(input.organizationId, domain, row);
  }

  const now = new Date();

  // Never servable: without a live certificate no sender could have fetched
  // the policy, so the hostname and the TXT go at once. A PENDING row whose
  // certificate is active has been served (the public route answers for it),
  // and a sender may have cached it, so it releases like an active one.
  const everServed = row.hostnameStatus === 'active' && row.sslStatus === 'active';
  if (row.status === 'PENDING' && !everServed) {
    const released = await completeRelease(row, {
      organizationId: input.organizationId,
      domainId: domain.id,
      domainName: domain.name,
      now,
      actorUserId: input.actorUserId,
    });
    await prisma.hostedMtaStsChange.create({
      data: {
        recordId: row.id,
        organizationId: input.organizationId,
        reason: 'released',
        previousMode: row.mode,
        newMode: 'none',
        previousMx: row.mx,
        newMx: [],
        previousMaxAge: row.maxAge,
        newMaxAge: mtaStsMinMaxAge,
        previousPolicyId: row.policyId,
        newPolicyId: row.policyId,
        actorUserId: input.actorUserId,
      },
    });
    return viewFor(input.organizationId, domain, released);
  }

  const policyId = nextPolicyId();
  const serveUntil = await releaseServeWindow(row, now);
  const updated = await prisma.hostedMtaStsRecord.update({
    where: { id: row.id },
    data: {
      status: 'RELEASING',
      mode: 'none',
      mx: [],
      maxAge: mtaStsMinMaxAge,
      policyId,
      version: { increment: 1 },
      releaseRequestedAt: now,
      releaseServeUntil: serveUntil,
    },
  });
  await prisma.hostedMtaStsChange.create({
    data: {
      recordId: row.id,
      organizationId: input.organizationId,
      reason: 'released',
      previousMode: row.mode,
      newMode: 'none',
      previousMx: row.mx,
      newMx: [],
      previousMaxAge: row.maxAge,
      newMaxAge: mtaStsMinMaxAge,
      previousPolicyId: row.policyId,
      newPolicyId: policyId,
      actorUserId: input.actorUserId,
    },
  });
  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'HOSTED_MTA_STS_RELEASE_REQUESTED',
    targetType: 'domain',
    targetId: domain.id,
    detail: { domainName: domain.name, serveUntil: serveUntil.toISOString() },
  });

  // The release has committed and the `none` policy is already being served.
  // A failed TXT write is recorded on the row (the panel shows it) and retried
  // by the reconciler; answering 502 here would report a release that happened
  // as one that did not.
  await syncMtaStsValue(updated);

  const fresh = await prisma.hostedMtaStsRecord.findUniqueOrThrow({ where: { id: row.id } });
  return viewFor(input.organizationId, domain, fresh);
}

// ─── lifecycle ──────────────────────────────────────────────────────────────

export async function hostedMtaStsSnapshotsForDomainIds(
  domainIds: string[],
): Promise<HostedMtaStsDeletionSnapshot[]> {
  if (domainIds.length === 0) return [];
  return prisma.hostedMtaStsRecord.findMany({
    where: { domainId: { in: domainIds } },
    select: { id: true, token: true, customHostnameId: true, txtRecordId: true },
  });
}

/** Best-effort cleanup after the database rows have already gone. */
export async function removeHostedMtaStsForDeletion(
  records: HostedMtaStsDeletionSnapshot[],
): Promise<void> {
  if (records.length === 0) return;
  const provider = hostedDnsProvider();
  const client = hostedCustomHostnameClient();
  for (const record of records) {
    if (client && record.customHostnameId) {
      try {
        await client.remove(record.customHostnameId);
      } catch (error) {
        console.error(
          `[hosted-mta-sts] could not remove the custom hostname for ${record.token}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    if (provider) {
      try {
        await removeOurRecords(provider, record);
      } catch (error) {
        console.error(
          `[hosted-mta-sts] could not remove the provider record for ${record.token}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
  }
}

// ─── reconciler ─────────────────────────────────────────────────────────────

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The names our MTA-STS records live at, and nothing else. */
export function hostedMtaStsNamePattern(zone: string): RegExp {
  return new RegExp(`^[a-z2-7]{16}\\._mta-sts\\.${escapeRegExp(zone)}$`);
}

/**
 * One reconciler pass: keep every live TXT in step, re-read Cloudflare for rows
 * not yet active, complete releases whose window has closed, and drop
 * token-shaped records with our comment that no row owns.
 *
 * Custom hostnames are never swept. On non-Enterprise plans they carry no
 * comment, so a hostname that does not match a stored id cannot be proven ours,
 * and deleting one is not reversible from here.
 */
export async function reconcileHostedMtaSts(
  now: Date = new Date(),
): Promise<HostedMtaStsReconcileSummary> {
  const summary: HostedMtaStsReconcileSummary = { synced: 0, failed: 0, removed: 0, released: 0 };
  const provider = hostedDnsProvider();
  if (!provider || !hostedMtaStsAvailable()) {
    return summary;
  }

  const rows = await prisma.hostedMtaStsRecord.findMany({ where: { status: { not: 'RELEASED' } } });
  const client = hostedCustomHostnameClient();

  for (const row of rows) {
    if (row.status === 'RELEASING' && row.releaseServeUntil && row.releaseServeUntil.getTime() <= now.getTime()) {
      const domain = await prisma.domain.findUnique({
        where: { id: row.domainId },
        select: { name: true },
      });
      await completeRelease(row, {
        organizationId: row.organizationId,
        domainId: row.domainId,
        domainName: domain?.name ?? 'this domain',
        now,
      });
      summary.released += 1;
      continue;
    }

    const result = await syncMtaStsValue(row);
    if (result.ok) summary.synced += 1;
    else summary.failed += 1;

    if (row.status === 'PENDING' && client && row.customHostnameId) {
      try {
        const hostname = await client.get(row.customHostnameId);
        await prisma.hostedMtaStsRecord.update({
          where: { id: row.id },
          data: {
            hostnameStatus: hostname.status,
            sslStatus: hostname.sslStatus,
            sslError: hostname.sslError,
          },
        });
      } catch {
        // A read that fails leaves the stored statuses alone.
      }
    }
  }

  // Released rows that still hold a custom hostname: the removal at release
  // failed, and the stored id is the only way to find it again.
  const stranded = await prisma.hostedMtaStsRecord.findMany({
    where: { status: 'RELEASED', customHostnameId: { not: null } },
    select: { id: true, customHostnameId: true },
  });
  for (const row of stranded) {
    if (await removeCustomHostname(row)) {
      await prisma.hostedMtaStsRecord.update({
        where: { id: row.id },
        data: { customHostnameId: null, lastSyncError: null },
      });
      summary.removed += 1;
    }
  }

  const namePattern = hostedMtaStsNamePattern(provider.zone);
  for await (const record of provider.listAll()) {
    const name = record.name.toLowerCase().replace(/\.+$/, '');
    if (!namePattern.test(name)) continue;
    if (!record.comment?.startsWith(hostedMtaStsCommentPrefix)) continue;

    const token = name.slice(0, name.indexOf('.'));
    const owner = await prisma.hostedMtaStsRecord.findUnique({
      where: { token },
      select: { id: true, status: true },
    });
    if (owner && owner.status !== 'RELEASED') continue;
    try {
      await provider.remove(record.id);
      summary.removed += 1;
    } catch (error) {
      console.error(
        `[hosted-mta-sts] could not remove orphan ${name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  return summary;
}

// ─── public serving ─────────────────────────────────────────────────────────

/**
 * The policy body for a request whose Host header is `mta-sts.<domain>`.
 *
 * Returns null for everything that must answer the same 404: an unknown
 * hostname, a released row, a pending row whose certificate is not ready, and a
 * releasing row past its serve window.
 */
export async function mtaStsPolicyForHostname(
  host: string,
  now: Date = new Date(),
): Promise<string | null> {
  const clean = host.trim().toLowerCase().split(':')[0]!.replace(/\.+$/, '');
  const match = /^mta-sts\.(.+)$/.exec(clean);
  if (!match) return null;
  const domainName = match[1]!;
  if (!domainName.includes('.')) return null;

  const row = await prisma.hostedMtaStsRecord.findFirst({
    where: { domain: { name: domainName } },
    select: {
      status: true,
      mode: true,
      mx: true,
      maxAge: true,
      hostnameStatus: true,
      sslStatus: true,
      releaseServeUntil: true,
    },
  });
  if (!row) return null;
  if (row.status === 'RELEASED') return null;
  if (row.status === 'RELEASING') {
    if (row.releaseServeUntil && row.releaseServeUntil.getTime() < now.getTime()) return null;
  }
  // A pending row is served so Cloudflare and the scanner can see a valid file
  // before the TXT is relied on, but only once the certificate is live.
  if (row.status === 'PENDING') {
    if (row.hostnameStatus !== 'active' || row.sslStatus !== 'active') return null;
  }

  return buildMtaStsPolicy({ mode: row.mode, mx: row.mx, maxAge: row.maxAge });
}

/** True when a token looks like one of ours, before any database read. */
export function isMtaStsToken(value: string): boolean {
  return isHostedToken(value);
}
