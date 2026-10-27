import { randomBytes } from 'node:crypto';
import type { HostedDmarcRecord, HostedDmarcStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { systemDnsReader } from '../../scanner/dns.js';
import type { DnsReader } from '../../scanner/types.js';
import { readDmarcRecord } from '../../scanner/dmarc-tags.js';
import {
  addReportAddress,
  isDmarcRecordValue,
  normaliseTxtValue,
  rewriteDmarcPolicy,
  type DmarcPublishPolicy,
} from '../dns-automation/records.js';
import { restoreWindowDays } from '../dns-automation/restore-window.js';
import { getOnboardingState, assessPolicyReadiness } from '../onboarding.service.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { recordAuditEvent } from '../audit.service.js';
import { hostedDnsProvider, type HostedDnsProvider } from './provider.js';
import { hostedTokenAlphabet, isOurHostedTarget, recordName } from './target.js';

export { isOurHostedTarget, recordName };

const tokenAlphabet = hostedTokenAlphabet;
export const hostedCommentPrefix = 'dmarc-harbor hosted ';

export class HostedDmarcError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HostedDmarcError';
  }
}

export interface HostedPolicyView {
  p: string;
  testing: boolean;
  np: string | null;
}

export interface HostedChangeView {
  id: string;
  reason: string;
  previousValue: string | null;
  newValue: string;
  readinessOverride: boolean;
  actor: { id: string; name: string } | null;
  createdAt: string;
  restoredAt: string | null;
  restorable: boolean;
}

export interface HostedDmarcView {
  available: boolean;
  hosted: null | {
    status: HostedDmarcStatus;
    paused: boolean;
    cname: { host: string; type: 'CNAME'; target: string };
    value: string;
    version: number;
    policy: HostedPolicyView;
    delegated: boolean;
    delegationCheckedAt: string | null;
    lastSyncedAt: string | null;
    lastSyncError: string | null;
    releaseBlocked: 'no_record_published' | null;
    republish: { host: string; type: 'TXT'; value: string } | null;
    changes: HostedChangeView[];
  };
  capacity: { full: boolean };
}

interface SyncResult {
  ok: boolean;
  error?: string;
}

export function randomHostedToken(): string {
  const bytes = randomBytes(16);
  let token = '';
  for (const byte of bytes) {
    token += tokenAlphabet[byte & 0x1f];
  }
  return token;
}

/** A token no row has used yet. The generator is injectable for the retry test. */
export async function uniqueHostedToken(
  exists: (token: string) => Promise<boolean>,
  generate: () => string = randomHostedToken,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const token = generate();
    if (!(await exists(token))) {
      return token;
    }
  }
  throw new HostedDmarcError('A record token could not be generated. Try again.', 'TOKEN_GENERATION_FAILED', 503);
}

/**
 * The name the customer's CNAME points at. The label is a random token, never
 * the domain, so the public zone cannot be used to enumerate customers.
 */
function commentFor(row: HostedDmarcRecord): string {
  return `${hostedCommentPrefix}${row.id}`;
}

/**
 * Deletes the records this feature created for one row. Listing first means a
 * stale provider id (the record was removed by hand) does not block a release,
 * and the comment/id filter keeps every other record at the name untouched.
 */
async function removeOurRecords(
  provider: HostedDnsProvider,
  target: { id: string; token: string; providerRecordId: string | null },
): Promise<void> {
  const records = await provider.get(recordName(target.token));
  const comment = `${hostedCommentPrefix}${target.id}`;
  for (const record of records) {
    if (record.id === target.providerRecordId || record.comment === comment) {
      await provider.remove(record.id);
    }
  }
}

function policyFromValue(value: string): HostedPolicyView {
  const tags = readDmarcRecord(value).tags;
  const p = (tags.p ?? 'none').toLowerCase();
  return {
    p,
    testing: (tags.t ?? '').toLowerCase() === 'y',
    np: tags.np ? tags.np.toLowerCase() : null,
  };
}

function levelOf(policy: string): number {
  if (policy === 'reject') return 2;
  if (policy === 'quarantine') return 1;
  return 0;
}

/** The level receivers apply: t=y lowers it by one, exactly as the scanner does. */
export function effectiveLevel(policy: HostedPolicyView): number {
  const base = levelOf(policy.p);
  return policy.testing && base > 0 ? base - 1 : base;
}

/**
 * Makes our zone match one row. A provider failure is recorded on the row and
 * returned, never thrown to the caller: the caller decides whether to roll back
 * a value or delete a just-created row.
 */
export async function syncValue(row: HostedDmarcRecord): Promise<SyncResult> {
  const provider = hostedDnsProvider();
  if (!provider) {
    return { ok: false, error: 'Hosted DMARC records are not set up on this deployment.' };
  }

  const name = recordName(row.token);
  try {
    const records = await provider.get(name);
    // Only records this feature created (or the one this row already owns) are
    // ever touched. A comment edited away still leaves a row we can identify by
    // its provider id.
    const managed = records.filter(
      (record) => record.comment === commentFor(row) || record.id === row.providerRecordId,
    );
    const existing = managed.filter((record) => isDmarcRecordValue(record.content));
    let chosen = existing.find((record) => record.id === row.providerRecordId) ?? existing[0] ?? null;

    if (!chosen) {
      chosen = await provider.create(name, row.value, commentFor(row));
    } else if (normaliseTxtValue(chosen.content) !== normaliseTxtValue(row.value)) {
      chosen = await provider.update(chosen, row.value);
    }

    // Extra DMARC records at the name are drift; keep the one we own and remove
    // the rest. Records without our comment or id are never in `managed`.
    for (const extra of existing) {
      if (extra.id !== chosen.id) {
        await provider.remove(extra.id);
      }
    }

    await prisma.hostedDmarcRecord.update({
      where: { id: row.id },
      data: { providerRecordId: chosen.id, lastSyncedAt: new Date(), lastSyncError: null },
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The DNS provider refused the change.';
    await prisma.hostedDmarcRecord
      .update({ where: { id: row.id }, data: { lastSyncError: message } })
      .catch(() => undefined);
    return { ok: false, error: message };
  }
}

let readerOverride: DnsReader | null = null;

/** Test seam for the DNS reads start and check make. */
export function setHostedDmarcReaderForTests(reader: DnsReader | null): void {
  readerOverride = reader;
}

function dnsReader(reader?: DnsReader): DnsReader {
  return reader ?? readerOverride ?? systemDnsReader;
}

async function domainFor(organizationId: string, domainRefOrId: string) {
  const domain = await prisma.domain.findFirst({
    where: {
      client: { organizationId },
      OR: [{ id: domainRefOrId }, { slug: domainRefOrId }],
    },
    select: { id: true, name: true, slug: true, status: true },
  });
  return domain;
}

/**
 * The zone's capacity in records, not customers: a hosted DMARC row is one
 * TXT, and a managed SPF row may be an entry plus up to eight continuations.
 * Both features share the same Cloudflare limit, so both must count the same
 * way.
 */
export async function usedHostedRecords(): Promise<number> {
  const [dmarc, spf] = await Promise.all([
    prisma.hostedDmarcRecord.count({ where: { status: { not: 'RELEASED' } } }),
    prisma.hostedSpfRecord.findMany({
      where: { status: { not: 'RELEASED' } },
      select: { parts: true },
    }),
  ]);
  return (
    dmarc +
    spf.reduce((total, row) => total + (Array.isArray(row.parts) ? row.parts.length : 0), 0)
  );
}

function capacityWarning(count: number): void {
  if (count / env.HOSTED_DNS_RECORD_LIMIT >= 0.85) {
    console.warn(
      `[hosted-dmarc] ${count} of ${env.HOSTED_DNS_RECORD_LIMIT} hosted records are in use; new hosting will be refused at the limit.`,
    );
  }
}

async function viewFor(
  organizationId: string,
  domain: { id: string; name: string },
  row: HostedDmarcRecord | null,
  releaseBlocked: 'no_record_published' | null = null,
): Promise<HostedDmarcView> {
  const provider = hostedDnsProvider();
  const count = await usedHostedRecords();
  const capacity = { full: count >= env.HOSTED_DNS_RECORD_LIMIT };

  if (!provider) {
    return { available: false, hosted: null, capacity };
  }

  if (!row) {
    return { available: provider !== null, hosted: null, capacity };
  }

  const entitlements = await resolveEntitlements(organizationId);
  const paused = entitlements.features['dns.hosted'] !== true;
  const changes = await prisma.hostedDmarcChange.findMany({
    where: { recordId: row.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
    select: {
      id: true,
      reason: true,
      previousValue: true,
      newValue: true,
      readinessOverride: true,
      actorUserId: true,
      createdAt: true,
      restoredAt: true,
    },
  });
  const actorIds = [...new Set(changes.map((change) => change.actorUserId).filter((id): id is string => Boolean(id)))];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));
  const now = Date.now();
  const windowMs = restoreWindowDays * 24 * 60 * 60 * 1000;

  return {
    available: provider !== null,
    hosted: {
      status: row.status,
      paused,
      cname: { host: `_dmarc.${domain.name}`, type: 'CNAME', target: recordName(row.token) },
      value: row.value,
      version: row.version,
      policy: policyFromValue(row.value),
      delegated: row.delegated,
      delegationCheckedAt: row.delegationCheckedAt?.toISOString() ?? null,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastSyncError: row.lastSyncError,
      releaseBlocked,
      republish:
        row.status === 'RELEASING'
          ? { host: `_dmarc.${domain.name}`, type: 'TXT', value: row.value }
          : null,
      changes: changes.map((change) => ({
        id: change.id,
        reason: change.reason,
        previousValue: change.previousValue,
        newValue: change.newValue,
        readinessOverride: change.readinessOverride,
        actor: change.actorUserId
          ? {
              id: change.actorUserId,
              name: actorById.get(change.actorUserId)?.name ?? 'A former member',
            }
          : null,
        createdAt: change.createdAt.toISOString(),
        restoredAt: change.restoredAt?.toISOString() ?? null,
        restorable:
          change.reason === 'policy' &&
          change.restoredAt === null &&
          change.previousValue !== null &&
          change.newValue === row.value &&
          now - change.createdAt.getTime() < windowMs,
      })),
    },
    capacity,
  };
}

export async function hostedDmarcView(
  organizationId: string,
  domainRefOrId: string,
): Promise<HostedDmarcView> {
  const domain = await domainFor(organizationId, domainRefOrId);
  if (!domain) {
    throw new HostedDmarcError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedDmarcRecord.findUnique({ where: { domainId: domain.id } });
  return viewFor(organizationId, domain, row);
}

function txtValues(lookup: Awaited<ReturnType<DnsReader['resolveTxt']>>): string[] {
  return (lookup.value ?? [])
    .map((chunks) => chunks.join('').trim())
    .filter((record) => isDmarcRecordValue(record));
}

async function initialValue(input: {
  organizationId: string;
  domain: { id: string; name: string };
  reader: DnsReader;
}): Promise<{ value: string; previousValue: string | null; reuseToken: string | null }> {
  const state = await getOnboardingState(input.organizationId, input.domain.id);
  if (!state) {
    throw new HostedDmarcError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const ourAddress = state.suggestedRecord.aggregateAddress;

  const [cnameLookup, txtLookup] = await Promise.all([
    input.reader.resolveCname
      ? input.reader.resolveCname(`_dmarc.${input.domain.name}`)
      : Promise.resolve(null),
    input.reader.resolveTxt(`_dmarc.${input.domain.name}`),
  ]);

  if (txtLookup.status === 'error') {
    throw new HostedDmarcError(
      `The DNS lookup for _dmarc.${input.domain.name} failed. Nothing was created; try again.`,
      'DNS_LOOKUP_FAILED',
      503,
    );
  }

  const target = cnameLookup?.status === 'found' ? cnameLookup.value?.[0] ?? null : null;
  if (target && isOurHostedTarget(target)) {
    const token = target.trim().toLowerCase().replace(/\.+$/, '').split('.')[0]!;
    const existing = await prisma.hostedDmarcRecord.findUnique({ where: { token } });
    if (existing && existing.domainId === input.domain.id) {
      if (existing.status !== 'RELEASED') {
        throw new HostedDmarcError(
          'This domain already has a hosted DMARC record.',
          'ALREADY_HOSTED',
          409,
        );
      }
      return { value: existing.value, previousValue: null, reuseToken: existing.token };
    }
    throw new HostedDmarcError(
      'The CNAME at _dmarc already points at a hosted record that is not yours. Remove that CNAME first.',
      'ALREADY_HOSTED',
      409,
    );
  }

  const records = txtValues(txtLookup);
  if (records.length > 1) {
    throw new HostedDmarcError(
      'More than one DMARC record is published, so receivers ignore all of them.',
      'MULTIPLE_DMARC_RECORDS',
      409,
    );
  }
  if (records.length === 1) {
    return {
      value: addReportAddress(records[0]!, ourAddress),
      previousValue: records[0]!,
      reuseToken: null,
    };
  }
  return { value: state.suggestedRecord.value, previousValue: null, reuseToken: null };
}

export async function startHosting(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
  reader?: DnsReader;
}): Promise<HostedDmarcView> {
  const provider = hostedDnsProvider();
  if (!provider) {
    throw new HostedDmarcError(
      'Hosted DMARC records are not set up on this deployment.',
      'HOSTED_DNS_UNAVAILABLE',
      503,
    );
  }

  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new HostedDmarcError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  if (domain.status !== 'VERIFIED') {
    throw new HostedDmarcError(
      'Verify the domain before hosting its DMARC record.',
      'DOMAIN_NOT_VERIFIED',
      409,
    );
  }

  const existing = await prisma.hostedDmarcRecord.findUnique({ where: { domainId: domain.id } });
  if (existing && existing.status !== 'RELEASED') {
    throw new HostedDmarcError(
      'This domain already has a hosted DMARC record.',
      'ALREADY_HOSTED',
      409,
    );
  }

  const count = await usedHostedRecords();
  if (count >= env.HOSTED_DNS_RECORD_LIMIT) {
    throw new HostedDmarcError(
      'Hosting is full on this deployment right now. Publish the TXT record yourself.',
      'HOSTED_DNS_FULL',
      503,
    );
  }
  capacityWarning(count + 1);

  const reader = dnsReader(input.reader);
  const initial = await initialValue({ organizationId: input.organizationId, domain, reader });

  const activate = async (
    row: HostedDmarcRecord,
    previousValue: string | null,
    alreadySynced = false,
  ): Promise<HostedDmarcView> => {
    if (!alreadySynced) {
      const synced = await syncValue(row);
      if (!synced.ok) {
        throw new HostedDmarcError(
          synced.error ?? 'The DNS provider refused the record.',
          'HOSTED_DNS_PROVIDER_FAILED',
          502,
        );
      }
    }
    await prisma.hostedDmarcChange.create({
      data: {
        recordId: row.id,
        organizationId: input.organizationId,
        previousValue,
        newValue: row.value,
        reason: 'created',
        actorUserId: input.actorUserId,
      },
    });
    await recordAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'HOSTED_DMARC_CREATED',
      targetType: 'domain',
      targetId: domain.id,
      detail: { domainName: domain.name },
    });
    const fresh = await prisma.hostedDmarcRecord.findUniqueOrThrow({ where: { id: row.id } });
    return viewFor(input.organizationId, domain, fresh);
  };

  if (existing && initial.reuseToken === existing.token) {
    const reactivated = await prisma.hostedDmarcRecord.update({
      where: { id: existing.id },
      data: {
        status: 'PENDING',
        releasedAt: null,
        releaseRequestedAt: null,
        delegated: false,
        delegationCheckedAt: null,
        lastSyncError: null,
        value: initial.value,
      },
    });
    try {
      return await activate(reactivated, null);
    } catch (error) {
      // Starting never changes what is published unless it succeeds, so a
      // failed reactivation goes back to the released record it was.
      await prisma.hostedDmarcRecord
        .update({
          where: { id: existing.id },
          data: {
            status: 'RELEASED',
            releasedAt: existing.releasedAt ?? new Date(),
            value: existing.value,
          },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  if (existing) {
    await prisma.hostedDmarcRecord.delete({ where: { id: existing.id } });
  }

  const token = await uniqueHostedToken(async (candidate) => {
    const row = await prisma.hostedDmarcRecord.findUnique({ where: { token: candidate }, select: { id: true } });
    return Boolean(row);
  });

  let row: HostedDmarcRecord;
  try {
    row = await prisma.hostedDmarcRecord.create({
      data: {
        organizationId: input.organizationId,
        domainId: domain.id,
        token,
        value: initial.value,
        createdById: input.actorUserId,
      },
    });
  } catch (error) {
    // Two starts for one domain at once: domainId is unique, so the second
    // loses here. It is the same answer as the check above, not a server error.
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002') {
      throw new HostedDmarcError('This domain already has a hosted DMARC record.', 'ALREADY_HOSTED', 409);
    }
    throw error;
  }

  const synced = await syncValue(row);
  if (!synced.ok) {
    await prisma.hostedDmarcRecord.delete({ where: { id: row.id } }).catch(() => undefined);
    throw new HostedDmarcError(
      synced.error ?? 'The DNS provider refused the record.',
      'HOSTED_DNS_PROVIDER_FAILED',
      502,
    );
  }

  return activate(row, initial.previousValue, true);
}

export async function checkDelegation(input: {
  organizationId: string;
  domainId: string;
  reader?: DnsReader;
}): Promise<HostedDmarcView> {
  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new HostedDmarcError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedDmarcRecord.findUnique({ where: { domainId: domain.id } });
  if (!row) {
    throw new HostedDmarcError('This domain is not hosted by DMARC Harbor.', 'NOT_HOSTED', 404);
  }

  const reader = dnsReader(input.reader);
  const [cnameLookup, txtLookup] = await Promise.all([
    reader.resolveCname
      ? reader.resolveCname(`_dmarc.${domain.name}`)
      : Promise.resolve(null),
    reader.resolveTxt(`_dmarc.${domain.name}`),
  ]);

  /**
   * A CNAME lookup that failed, or a reader that cannot ask, says nothing about
   * delegation. It must not flip `delegated`, and above all it must not release:
   * while the CNAME still points here, the TXT lookup at _dmarc follows it and
   * returns OUR record, which would look exactly like "the customer published
   * their own". Releasing on that deletes the record the CNAME still points at
   * and leaves the domain with no DMARC record at all.
   */
  const cnameStatus = cnameLookup?.status ?? 'unknown';
  const cnameKnown = cnameStatus === 'found' || cnameStatus === 'missing';
  const cnameTarget = cnameStatus === 'found' ? cnameLookup?.value?.[0] ?? null : null;
  const delegated =
    Boolean(cnameTarget) &&
    cnameTarget!.trim().toLowerCase().replace(/\.+$/, '') === recordName(row.token);

  const now = new Date();
  let update: Parameters<typeof prisma.hostedDmarcRecord.update>[0]['data'] = cnameKnown
    ? { delegated, delegationCheckedAt: now }
    : { delegationCheckedAt: now };
  let releaseBlocked: 'no_record_published' | null = null;

  if (row.status === 'PENDING' && delegated) {
    update = { ...update, status: 'ACTIVE', activatedAt: row.activatedAt ?? now };
  }

  if (row.status === 'RELEASING' && cnameKnown && !delegated) {
    // Exactly one DMARC record must now answer at _dmarc. Anything else (an
    // error, nothing, an unrelated TXT, two DMARC records that receivers would
    // ignore) leaves the domain without a working policy if we stop serving.
    const published = txtLookup.status === 'found' ? txtValues(txtLookup) : [];
    if (txtLookup.status === 'error') {
      // Unknown, not absent: releasing here would risk leaving no DMARC record.
    } else if (published.length === 1) {
      const provider = hostedDnsProvider();
      if (!provider) {
        throw new HostedDmarcError(
          'Hosted DMARC records are not set up on this deployment.',
          'HOSTED_DNS_UNAVAILABLE',
          503,
        );
      }
      try {
        await removeOurRecords(provider, row);
        update = { ...update, status: 'RELEASED', releasedAt: now, lastSyncError: null };
      } catch (error) {
        update = {
          ...update,
          lastSyncError: error instanceof Error ? error.message : 'The DNS provider refused the removal.',
        };
      }
    } else {
      releaseBlocked = 'no_record_published';
    }
  }

  const updated = await prisma.hostedDmarcRecord.update({ where: { id: row.id }, data: update });

  if (updated.status === 'RELEASED' && row.status !== 'RELEASED') {
    await recordAuditEvent({
      organizationId: input.organizationId,
      action: 'HOSTED_DMARC_RELEASED',
      targetType: 'domain',
      targetId: domain.id,
      detail: { domainName: domain.name },
    });
  }

  return viewFor(input.organizationId, domain, updated, releaseBlocked);
}


async function defaultHostedRefresh(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
}): Promise<void> {
  // Dynamic import: domain-scan calls checkDelegation at the end of a scan, and
  // a static import in both directions would close an ESM cycle.
  const { runDomainScan } = await import('../domain-scan.service.js');
  await runDomainScan({
    organizationId: input.organizationId,
    domainId: input.domainId,
    requestedById: input.actorUserId,
    trigger: 'MANUAL',
  });
}

let refreshImplementation: typeof defaultHostedRefresh = defaultHostedRefresh;

type ReadinessCheck = typeof assessPolicyReadiness;
let readinessImplementation: ReadinessCheck = assessPolicyReadiness;

/** Test seam so readiness blockers can be exercised without seeding a month. */
export function setHostedDmarcReadinessForTests(check: ReadinessCheck | null): void {
  readinessImplementation = check ?? assessPolicyReadiness;
}

/** Test seam, following the same pattern as the DNS publish refresh. */
export function setHostedDmarcRefreshForTests(
  impl:
    | ((input: { organizationId: string; domainId: string; actorUserId: string }) => Promise<void>)
    | null,
): void {
  refreshImplementation = impl ?? defaultHostedRefresh;
}

async function bestEffortRefresh(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
}): Promise<void> {
  try {
    await refreshImplementation(input);
  } catch (error) {
    console.warn(
      `[hosted-dmarc] refresh scan failed for ${input.domainId}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

async function versionConflict(organizationId: string, domain: { id: string; name: string }): Promise<never> {
  const current = await prisma.hostedDmarcRecord.findUnique({ where: { domainId: domain.id } });
  const view = await viewFor(organizationId, domain, current);
  throw new HostedDmarcError(
    'Someone else changed this record. Reload and try again.',
    'VERSION_CHANGED',
    409,
    { view },
  );
}

export async function changePolicy(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
  expectedVersion: number;
  policy: DmarcPublishPolicy;
  testing: boolean;
  np: DmarcPublishPolicy | null;
  override?: boolean;
}): Promise<HostedDmarcView & { action: 'updated' | 'unchanged' }> {
  const provider = hostedDnsProvider();
  if (!provider) {
    throw new HostedDmarcError(
      'Hosted DMARC records are not set up on this deployment.',
      'HOSTED_DNS_UNAVAILABLE',
      503,
    );
  }
  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new HostedDmarcError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedDmarcRecord.findUnique({ where: { domainId: domain.id } });
  if (!row) {
    throw new HostedDmarcError('This domain is not hosted by DMARC Harbor.', 'NOT_HOSTED', 404);
  }
  if (row.status === 'RELEASING' || row.status === 'RELEASED') {
    throw new HostedDmarcError(
      'This record is being released and cannot be changed.',
      'HOSTED_RELEASING',
      409,
    );
  }
  if (input.expectedVersion !== row.version) {
    return versionConflict(input.organizationId, domain);
  }

  const state = await getOnboardingState(input.organizationId, domain.id);
  if (!state) {
    throw new HostedDmarcError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const newValue = rewriteDmarcPolicy(row.value, state.suggestedRecord.aggregateAddress, {
    policy: input.policy,
    testing: input.testing,
    np: input.np,
  });

  if (normaliseTxtValue(newValue) === normaliseTxtValue(row.value)) {
    return { ...(await viewFor(input.organizationId, domain, row)), action: 'unchanged' };
  }

  const before = policyFromValue(row.value);
  const after = policyFromValue(newValue);
  let blockers: string[] = [];
  if (effectiveLevel(after) > effectiveLevel(before)) {
    const readiness = await readinessImplementation(input.organizationId, domain.id);
    blockers = readiness.blockers;
    if (blockers.length > 0 && input.override !== true) {
      throw new HostedDmarcError(
        'This policy change is not ready: resolve the blockers or publish anyway.',
        'POLICY_NOT_READY',
        409,
        { blockers },
      );
    }
  }

  const overridden = blockers.length > 0 && input.override === true;
  let changeId: string;
  try {
    changeId = await prisma.$transaction(async (transaction) => {
      const updated = await transaction.hostedDmarcRecord.updateMany({
        where: { id: row.id, version: input.expectedVersion },
        data: { value: newValue, version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new HostedDmarcError('Someone else changed this record. Reload and try again.', 'VERSION_CHANGED', 409);
      }
      const change = await transaction.hostedDmarcChange.create({
        data: {
          recordId: row.id,
          organizationId: input.organizationId,
          previousValue: row.value,
          newValue,
          reason: 'policy',
          readinessOverride: overridden,
          actorUserId: input.actorUserId,
        },
      });
      return change.id;
    });
  } catch (error) {
    if (error instanceof HostedDmarcError && error.code === 'VERSION_CHANGED') {
      return versionConflict(input.organizationId, domain);
    }
    throw error;
  }

  const updatedRow = await prisma.hostedDmarcRecord.findUniqueOrThrow({ where: { id: row.id } });
  const synced = await syncValue(updatedRow);
  if (!synced.ok) {
    await prisma.$transaction(async (transaction) => {
      await transaction.hostedDmarcChange.delete({ where: { id: changeId } }).catch(() => undefined);
      await transaction.hostedDmarcRecord.updateMany({
        where: { id: row.id, version: input.expectedVersion + 1 },
        data: { value: row.value, version: input.expectedVersion },
      });
    });
    throw new HostedDmarcError(
      synced.error ?? 'The DNS provider refused the change.',
      'HOSTED_DNS_PROVIDER_FAILED',
      502,
    );
  }

  try {
    await recordAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'HOSTED_DMARC_UPDATED',
      targetType: 'domain',
      targetId: domain.id,
      detail: {
        from: before,
        to: after,
        ...(overridden ? { override: true, blockers } : {}),
      },
    });
  } catch (error) {
    console.error('Failed to record a hosted DMARC update', error);
  }

  await bestEffortRefresh({
    organizationId: input.organizationId,
    domainId: domain.id,
    actorUserId: input.actorUserId,
  });

  const fresh = await prisma.hostedDmarcRecord.findUniqueOrThrow({ where: { id: row.id } });
  return { ...(await viewFor(input.organizationId, domain, fresh)), action: 'updated' };
}

export async function restoreChange(input: {
  organizationId: string;
  domainId: string;
  changeId: string;
  actorUserId: string;
  expectedVersion: number;
}): Promise<HostedDmarcView> {
  const provider = hostedDnsProvider();
  if (!provider) {
    throw new HostedDmarcError(
      'Hosted DMARC records are not set up on this deployment.',
      'HOSTED_DNS_UNAVAILABLE',
      503,
    );
  }
  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new HostedDmarcError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedDmarcRecord.findUnique({ where: { domainId: domain.id } });
  if (!row) {
    throw new HostedDmarcError('This domain is not hosted by DMARC Harbor.', 'NOT_HOSTED', 404);
  }
  if (row.status === 'RELEASING' || row.status === 'RELEASED') {
    throw new HostedDmarcError(
      'This record is being released and cannot be changed.',
      'HOSTED_RELEASING',
      409,
    );
  }
  if (input.expectedVersion !== row.version) {
    return versionConflict(input.organizationId, domain);
  }

  const change = await prisma.hostedDmarcChange.findFirst({
    where: { id: input.changeId, recordId: row.id },
  });
  if (
    !change ||
    change.reason !== 'policy' ||
    change.restoredAt !== null ||
    change.previousValue === null ||
    change.newValue !== row.value ||
    Date.now() - change.createdAt.getTime() > restoreWindowDays * 24 * 60 * 60 * 1000
  ) {
    throw new HostedDmarcError(
      'That change can no longer be restored.',
      'RESTORE_NOT_ALLOWED',
      409,
    );
  }

  const newValue = change.previousValue;
  let restoreId: string;
  try {
    restoreId = await prisma.$transaction(async (transaction) => {
      const updated = await transaction.hostedDmarcRecord.updateMany({
        where: { id: row.id, version: input.expectedVersion },
        data: { value: newValue, version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new HostedDmarcError('Someone else changed this record. Reload and try again.', 'VERSION_CHANGED', 409);
      }
      const restore = await transaction.hostedDmarcChange.create({
        data: {
          recordId: row.id,
          organizationId: input.organizationId,
          previousValue: row.value,
          newValue,
          reason: 'restore',
          actorUserId: input.actorUserId,
        },
      });
      await transaction.hostedDmarcChange.update({
        where: { id: change.id },
        data: { restoredAt: new Date() },
      });
      return restore.id;
    });
  } catch (error) {
    if (error instanceof HostedDmarcError && error.code === 'VERSION_CHANGED') {
      return versionConflict(input.organizationId, domain);
    }
    throw error;
  }

  const updatedRow = await prisma.hostedDmarcRecord.findUniqueOrThrow({ where: { id: row.id } });
  const synced = await syncValue(updatedRow);
  if (!synced.ok) {
    await prisma.$transaction(async (transaction) => {
      await transaction.hostedDmarcChange.delete({ where: { id: restoreId } }).catch(() => undefined);
      await transaction.hostedDmarcChange.update({
        where: { id: change.id },
        data: { restoredAt: null },
      });
      await transaction.hostedDmarcRecord.updateMany({
        where: { id: row.id, version: input.expectedVersion + 1 },
        data: { value: row.value, version: input.expectedVersion },
      });
    });
    throw new HostedDmarcError(
      synced.error ?? 'The DNS provider refused the change.',
      'HOSTED_DNS_PROVIDER_FAILED',
      502,
    );
  }

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'HOSTED_DMARC_RESTORED',
    targetType: 'domain',
    targetId: domain.id,
    detail: { changeId: change.id, value: newValue },
  });

  const fresh = await prisma.hostedDmarcRecord.findUniqueOrThrow({ where: { id: row.id } });
  return viewFor(input.organizationId, domain, fresh);
}

export async function requestRelease(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
}): Promise<HostedDmarcView> {
  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new HostedDmarcError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedDmarcRecord.findUnique({ where: { domainId: domain.id } });
  if (!row) {
    throw new HostedDmarcError('This domain is not hosted by DMARC Harbor.', 'NOT_HOSTED', 404);
  }
  if (row.status === 'RELEASED') {
    return viewFor(input.organizationId, domain, row);
  }
  if (row.status === 'RELEASING') {
    return viewFor(input.organizationId, domain, row);
  }

  if (row.status === 'PENDING') {
    const provider = hostedDnsProvider();
    if (!provider) {
      throw new HostedDmarcError(
        'Hosted DMARC records are not set up on this deployment.',
        'HOSTED_DNS_UNAVAILABLE',
        503,
      );
    }
    try {
      await removeOurRecords(provider, row);
    } catch (error) {
      throw new HostedDmarcError(
        error instanceof Error ? error.message : 'The DNS provider refused the removal.',
        'HOSTED_DNS_PROVIDER_FAILED',
        502,
      );
    }
    const released = await prisma.hostedDmarcRecord.update({
      where: { id: row.id },
      data: { status: 'RELEASED', releasedAt: new Date(), lastSyncError: null },
    });
    await recordAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'HOSTED_DMARC_RELEASED',
      targetType: 'domain',
      targetId: domain.id,
      detail: { domainName: domain.name },
    });
    return viewFor(input.organizationId, domain, released);
  }

  const updated = await prisma.hostedDmarcRecord.update({
    where: { id: row.id },
    data: { status: 'RELEASING', releaseRequestedAt: new Date() },
  });
  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'HOSTED_DMARC_RELEASE_REQUESTED',
    targetType: 'domain',
    targetId: domain.id,
    detail: { domainName: domain.name },
  });
  return viewFor(input.organizationId, domain, updated);
}

export interface HostedDeletionSnapshot {
  id: string;
  token: string;
  providerRecordId: string | null;
}

export async function hostedSnapshotsForDomainIds(domainIds: string[]): Promise<HostedDeletionSnapshot[]> {
  if (domainIds.length === 0) return [];
  return prisma.hostedDmarcRecord.findMany({
    where: { domainId: { in: domainIds } },
    select: { id: true, token: true, providerRecordId: true },
  });
}

/** Best-effort provider cleanup after the database rows have already gone. */
export async function removeHostedForDeletion(records: HostedDeletionSnapshot[]): Promise<void> {
  const provider = hostedDnsProvider();
  if (!provider || records.length === 0) {
    return;
  }
  for (const record of records) {
    try {
      await removeOurRecords(provider, record);
    } catch (error) {
      console.error(
        `[hosted-dmarc] could not remove the provider record for ${record.token}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}

export interface ReconcileSummary {
  synced: number;
  failed: number;
  removed: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function reconcileHostedDns(): Promise<ReconcileSummary> {
  const provider = hostedDnsProvider();
  if (!provider) {
    return { synced: 0, failed: 0, removed: 0 };
  }

  const summary: ReconcileSummary = { synced: 0, failed: 0, removed: 0 };

  const rows = await prisma.hostedDmarcRecord.findMany({ where: { status: { not: 'RELEASED' } } });
  for (const row of rows) {
    const result = await syncValue(row);
    if (result.ok) summary.synced += 1;
    else summary.failed += 1;
  }

  const namePattern = new RegExp(`^[a-z2-7]{16}\\.${escapeRegExp(provider.zone)}$`);
  for await (const record of provider.listAll()) {
    const name = record.name.toLowerCase().replace(/\.+$/, '');
    if (!namePattern.test(name)) continue;
    if (!record.comment?.startsWith(hostedCommentPrefix)) continue;

    const token = name.slice(0, -`.${provider.zone}`.length);
    const owner = await prisma.hostedDmarcRecord.findUnique({
      where: { token },
      select: { id: true, status: true },
    });
    if (owner && owner.status !== 'RELEASED') continue;
    try {
      await provider.remove(record.id);
      summary.removed += 1;
    } catch (error) {
      console.error(
        `[hosted-dmarc] could not remove orphan ${name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  const count = await usedHostedRecords();
  capacityWarning(count);
  return summary;
}
