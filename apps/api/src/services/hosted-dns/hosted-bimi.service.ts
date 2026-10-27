import { createHash, X509Certificate } from 'node:crypto';
import type { HostedBimiAsset, HostedBimiRecord, HostedBimiStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { systemDnsReader } from '../../scanner/dns.js';
import type { DnsReader } from '../../scanner/types.js';
import { failedBimiChecks, hasXmlEntityTricks, isValidUtf8 } from '../../scanner/bimi-labels.js';
import { bimiDmarcQualification, inspectBimiSvg } from '../../scanner/transport-records.js';
import { organizationalDomain } from '../alignment.service.js';
import { recordAuditEvent } from '../audit.service.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { normaliseTxtValue } from '../dns-automation/records.js';
import { hostedDnsProvider, type HostedDnsProvider } from './provider.js';
import { uniqueHostedToken, usedHostedRecords } from './hosted-dmarc.service.js';
import { isHostedToken } from './target.js';

export const hostedBimiCommentPrefix = 'dmarc-harbor bimi ';

/**
 * How long a replaced logo or certificate keeps being served.
 *
 * Mailbox providers cache the URL a TXT named, so a cached lookup of the old
 * URL must keep working after a replacement. Seven days is longer than any
 * cache TTL we set and longer than a provider's own refresh, and it is short
 * enough that a workspace is not storing every logo it has ever had.
 */
export const bimiAssetGraceDays = 7;

/** Thirty days is the warning window the panel shows before expiry. */
export const bimiCertificateWarningDays = 30;

/**
 * DER encoding of the mark certificate extended key usage OID
 * (1.3.6.1.5.5.7.3.31): tag 06, length 08, then the body.
 */
const markCertificateEkuDer = Buffer.from('06082b0601050507031f', 'hex');

export class HostedBimiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HostedBimiError';
  }
}

export interface HostedBimiChangeView {
  id: string;
  reason: string;
  previousLogoSha: string | null;
  newLogoSha: string | null;
  previousCertSha: string | null;
  newCertSha: string | null;
  actor: { id: string; name: string } | null;
  createdAt: string;
}

export interface HostedBimiCertificateView {
  sha256: string;
  url: string;
  expiresAt: string;
  issuer: string | null;
  subject: string | null;
  isMarkCertificate: boolean;
  expiresSoon: boolean;
  expired: boolean;
}

export interface HostedBimiView {
  available: boolean;
  capacity: { full: boolean };
  hosted: null | {
    status: HostedBimiStatus;
    paused: boolean;
    cname: { host: string; type: 'CNAME'; target: string };
    value: string | null;
    logo: { sha256: string; url: string; bytes: number; uploadedAt: string } | null;
    certificate: HostedBimiCertificateView | null;
    dmarc: { qualifies: boolean; reasons: string[]; dependsOnParent?: true } | null;
    delegated: boolean;
    delegationCheckedAt: string | null;
    lastSyncedAt: string | null;
    lastSyncError: string | null;
    republish: { host: string; type: 'TXT'; value: string; note: string } | null;
    changes: HostedBimiChangeView[];
  };
}

export interface HostedBimiDeletionSnapshot {
  id: string;
  token: string;
  providerRecordId: string | null;
}

export interface HostedBimiReconcileSummary {
  synced: number;
  failed: number;
  removed: number;
  purged: number;
}

// ─── names and values ───────────────────────────────────────────────────────

/**
 * True when this deployment can serve hosted BIMI at all: a hosted zone to
 * publish the TXT into, and an origin to serve the bytes from. Both are
 * optional, and the panel says "not set up on this deployment" rather than
 * offering a button that cannot work.
 */
export function hostedBimiAvailable(): boolean {
  return hostedDnsProvider() !== null && Boolean(env.HOSTED_BIMI_ORIGIN);
}

function origin(): string {
  const value = env.HOSTED_BIMI_ORIGIN;
  if (!value) {
    throw new HostedBimiError(
      'Hosted BIMI is not set up on this deployment.',
      'HOSTED_BIMI_UNAVAILABLE',
      503,
    );
  }
  return value.replace(/\/+$/, '');
}

/** `default._bimi.<domain>` — the name the customer's CNAME sits at. */
export function bimiCustomerName(domain: string): string {
  return `default._bimi.${domain}`;
}

/** `<token>.bimi.<zone>` — the name our TXT lives at. */
export function bimiRecordName(token: string): string {
  return `${token}.bimi.${env.HOSTED_DNS_ZONE ?? ''}`;
}

export function bimiLogoSha12(sha256: string): string {
  return sha256.slice(0, 12);
}

export function bimiLogoUrl(input: { token: string; sha256: string }): string {
  return `${origin()}/bimi/${input.token}/${bimiLogoSha12(input.sha256)}.svg`;
}

export function bimiCertificateUrl(input: { token: string; sha256: string }): string {
  return `${origin()}/bimi/${input.token}/${bimiLogoSha12(input.sha256)}.pem`;
}

/**
 * The TXT value.
 *
 * `a=` is published empty when there is no certificate and when the
 * certificate has expired: Gmail and Apple Mail then stop showing the logo,
 * which is the honest outcome, and receivers do not fail the record over a URL
 * that answers 404. The record itself keeps working, so the logo still shows
 * in clients that do not need a mark certificate.
 */
export function hostedBimiValue(input: {
  token: string;
  logoSha256: string;
  certificateSha256?: string | null;
  certificateExpiresAt?: Date | null;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const base = origin();
  const logo = `${base}/bimi/${input.token}/${bimiLogoSha12(input.logoSha256)}.svg`;
  const certificateUsable =
    Boolean(input.certificateSha256) &&
    (!input.certificateExpiresAt || input.certificateExpiresAt.getTime() > now.getTime());
  const authority = certificateUsable
    ? `${base}/bimi/${input.token}/${bimiLogoSha12(input.certificateSha256!)}.pem`
    : '';
  return `v=BIMI1; l=${logo}; a=${authority}`;
}

/** True while an asset may still be served: never retired, or retired recently. */
export function bimiAssetServable(
  asset: { retiredAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (!asset.retiredAt) return true;
  return now.getTime() - asset.retiredAt.getTime() < bimiAssetGraceDays * 24 * 60 * 60 * 1000;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function commentFor(row: { id: string }): string {
  return `${hostedBimiCommentPrefix}${row.id}`;
}

function cut(value: string | null | undefined, length = 120): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > length ? trimmed.slice(0, length) : trimmed;
}

// ─── provider writes ────────────────────────────────────────────────────────

interface SyncResult {
  ok: boolean;
  error?: string;
}

/**
 * Makes our zone match one row: one TXT at `<token>.bimi.<zone>` naming the
 * current logo and certificate, or nothing at all when there is no logo.
 *
 * A provider failure is recorded on the row and returned, never thrown: the
 * caller decides whether that is a refusal (start) or a retry (the reconciler).
 */
export async function syncBimiValue(row: HostedBimiRecord): Promise<SyncResult> {
  const provider = hostedDnsProvider();
  if (!provider) {
    return { ok: false, error: 'Hosted BIMI is not set up on this deployment.' };
  }

  const name = bimiRecordName(row.token);
  try {
    const [logo, certificate] = await Promise.all([
      servableAsset(row.id, 'LOGO'),
      servableAsset(row.id, 'CERTIFICATE'),
    ]);

    if (!logo) {
      // No logo means no record. A TXT naming a URL that answers 404 is worse
      // than none at all: receivers treat it as a broken BIMI record.
      await removeOurRecords(provider, row);
      await prisma.hostedBimiRecord.update({
        where: { id: row.id },
        data: { providerRecordId: null, lastSyncedAt: new Date(), lastSyncError: null },
      });
      return { ok: true };
    }

    const value = hostedBimiValue({
      token: row.token,
      logoSha256: logo.sha256,
      certificateSha256: certificate?.sha256 ?? null,
      certificateExpiresAt: row.certificateExpiresAt,
    });

    const records = await provider.get(name);
    const managed = records.filter(
      (record) => record.comment === commentFor(row) || record.id === row.providerRecordId,
    );
    let chosen = managed.find((record) => record.id === row.providerRecordId) ?? managed[0] ?? null;
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

    await prisma.hostedBimiRecord.update({
      where: { id: row.id },
      data: { providerRecordId: chosen.id, lastSyncedAt: new Date(), lastSyncError: null },
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The DNS provider refused the change.';
    await prisma.hostedBimiRecord
      .update({ where: { id: row.id }, data: { lastSyncError: message } })
      .catch(() => undefined);
    return { ok: false, error: message };
  }
}

async function removeOurRecords(
  provider: HostedDnsProvider,
  target: { id: string; token: string; providerRecordId: string | null },
): Promise<void> {
  const records = await provider.get(bimiRecordName(target.token));
  const comment = `${hostedBimiCommentPrefix}${target.id}`;
  for (const record of records) {
    if (record.id === target.providerRecordId || record.comment === comment) {
      await provider.remove(record.id);
    }
  }
}

async function servableAsset(
  recordId: string,
  kind: 'LOGO' | 'CERTIFICATE',
  now: Date = new Date(),
): Promise<HostedBimiAsset | null> {
  const asset = await prisma.hostedBimiAsset.findFirst({
    where: { recordId, kind, retiredAt: null },
    orderBy: { createdAt: 'desc' },
  });
  // `retiredAt: null` already means servable; the guard keeps the grace rule in
  // one place, so a later change to it cannot silently skip this caller.
  return asset && bimiAssetServable(asset, now) ? asset : null;
}

// ─── read side ──────────────────────────────────────────────────────────────

let readerOverride: DnsReader | null = null;

/** Test seam for the CNAME read a check makes. */
export function setHostedBimiReaderForTests(reader: DnsReader | null): void {
  readerOverride = reader;
}

function dnsReader(reader?: DnsReader): DnsReader {
  return reader ?? readerOverride ?? systemDnsReader;
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

async function capacityState(): Promise<{ full: boolean }> {
  const used = await usedHostedRecords();
  return { full: used >= env.HOSTED_DNS_RECORD_LIMIT };
}

function capacityWarning(count: number): void {
  if (count / env.HOSTED_DNS_RECORD_LIMIT >= 0.85) {
    console.warn(
      `[hosted-bimi] ${count} of ${env.HOSTED_DNS_RECORD_LIMIT} hosted DNS records are in use; new hosting will be refused at the limit.`,
    );
  }
}

/**
 * The BIMI qualification the latest completed scan produced.
 *
 * The scan already stores its answer under `result.bimi.dmarc`; a scan that
 * predates the BIMI checks has the DMARC result but not that field, so it is
 * computed from the same function. Either way the answer is the scanner's,
 * never a second implementation that could disagree with it.
 */
async function dmarcQualificationFor(domain: { id: string; name: string }) {
  const scan = await prisma.scan.findFirst({
    where: { domainId: domain.id, status: 'COMPLETED' },
    orderBy: [{ completedAt: 'desc' }, { startedAt: 'desc' }],
    select: { result: true },
  });
  const result = scan?.result as
    | { bimi?: { dmarc?: { qualifies: boolean; reasons: string[]; dependsOnParent?: true } }; dmarc?: Parameters<typeof bimiDmarcQualification>[0] }
    | null
    | undefined;
  if (!result) return null;
  if (result.bimi?.dmarc) return result.bimi.dmarc;
  if (result.dmarc) return bimiDmarcQualification(result.dmarc, domain.name);
  return null;
}

async function changesFor(row: HostedBimiRecord): Promise<HostedBimiChangeView[]> {
  const changes = await prisma.hostedBimiChange.findMany({
    where: { recordId: row.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
    select: {
      id: true,
      reason: true,
      previousLogoSha: true,
      newLogoSha: true,
      previousCertSha: true,
      newCertSha: true,
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
  return changes.map((change) => ({
    id: change.id,
    reason: change.reason,
    previousLogoSha: change.previousLogoSha,
    newLogoSha: change.newLogoSha,
    previousCertSha: change.previousCertSha,
    newCertSha: change.newCertSha,
    actor: change.actorUserId
      ? { id: change.actorUserId, name: actorById.get(change.actorUserId)?.name ?? 'A former member' }
      : null,
    createdAt: change.createdAt.toISOString(),
  }));
}

function certificateView(
  row: HostedBimiRecord,
  asset: HostedBimiAsset | null,
  now: Date,
): HostedBimiCertificateView | null {
  if (!asset || !row.certificateExpiresAt) {
    return null;
  }
  const expiresAt = row.certificateExpiresAt;
  const expired = expiresAt.getTime() <= now.getTime();
  const expiresSoon =
    !expired && expiresAt.getTime() - now.getTime() <= bimiCertificateWarningDays * 24 * 60 * 60 * 1000;
  return {
    sha256: asset.sha256,
    url: bimiCertificateUrl({ token: row.token, sha256: asset.sha256 }),
    expiresAt: expiresAt.toISOString(),
    issuer: row.certificateIssuer,
    subject: row.certificateSubject,
    isMarkCertificate: hasMarkCertificateEku(Buffer.from(asset.bytes)),
    expiresSoon,
    expired,
  };
}

async function viewFor(
  organizationId: string,
  domain: { id: string; name: string },
  row: HostedBimiRecord | null,
): Promise<HostedBimiView> {
  const capacity = await capacityState();
  if (!hostedBimiAvailable()) {
    return { available: false, hosted: null, capacity };
  }
  if (!row) {
    return { available: true, hosted: null, capacity };
  }

  const entitlements = await resolveEntitlements(organizationId);
  const paused = entitlements.features['dns.hostedBimi'] !== true;
  const now = new Date();
  const [logo, certificate, dmarc, changes] = await Promise.all([
    servableAsset(row.id, 'LOGO', now),
    servableAsset(row.id, 'CERTIFICATE', now),
    dmarcQualificationFor(domain),
    changesFor(row),
  ]);
  const value =
    logo && row.status !== 'RELEASED'
      ? hostedBimiValue({
          token: row.token,
          logoSha256: logo.sha256,
          certificateSha256: certificate?.sha256 ?? null,
          certificateExpiresAt: row.certificateExpiresAt,
          now,
        })
      : null;

  return {
    available: true,
    capacity,
    hosted: {
      status: row.status,
      paused,
      cname: {
        host: bimiCustomerName(domain.name),
        type: 'CNAME',
        target: bimiRecordName(row.token),
      },
      value,
      logo: logo
        ? {
            sha256: logo.sha256,
            url: bimiLogoUrl({ token: row.token, sha256: logo.sha256 }),
            bytes: logo.bytes.length,
            uploadedAt: logo.createdAt.toISOString(),
          }
        : null,
      certificate: certificateView(row, certificate, now),
      dmarc,
      delegated: row.delegated,
      delegationCheckedAt: row.delegationCheckedAt?.toISOString() ?? null,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastSyncError: row.lastSyncError,
      republish:
        row.status === 'RELEASING' && value
          ? {
              host: bimiCustomerName(domain.name),
              type: 'TXT',
              value,
              note: 'This record points at files DMARC Harbor serves. Host the SVG and certificate yourself, update the URLs, and publish it before the CNAME goes.',
            }
          : null,
      changes,
    },
  };
}

export async function hostedBimiView(
  organizationId: string,
  domainRefOrId: string,
): Promise<HostedBimiView> {
  const domain = await domainFor(organizationId, domainRefOrId);
  if (!domain) {
    throw new HostedBimiError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedBimiRecord.findUnique({ where: { domainId: domain.id } });
  return viewFor(organizationId, domain, row);
}

// ─── start ──────────────────────────────────────────────────────────────────

async function uniqueBimiToken(): Promise<string> {
  return uniqueHostedToken(async (candidate) => {
    const [dmarc, spf, bimi] = await Promise.all([
      prisma.hostedDmarcRecord.findUnique({ where: { token: candidate }, select: { id: true } }),
      prisma.hostedSpfRecord.findUnique({ where: { token: candidate }, select: { id: true } }),
      prisma.hostedBimiRecord.findUnique({ where: { token: candidate }, select: { id: true } }),
    ]);
    return Boolean(dmarc || spf || bimi);
  });
}

/** The TXT already at default._bimi, so a release can hand it back. */
async function existingBimiValue(domainName: string, reader: DnsReader): Promise<string | null> {
  try {
    const lookup = await reader.resolveTxt(bimiCustomerName(domainName));
    if (lookup.status !== 'found') return null;
    const values = (lookup.value ?? [])
      .map((chunks) => chunks.join('').trim())
      .filter((record) => /^v=bimi1(?:;|\s|$)/i.test(normaliseTxtValue(record)));
    return values[0] ?? null;
  } catch {
    // BIMI is cosmetic: a resolver that cannot answer must not stop hosting.
    return null;
  }
}

export async function startHostedBimi(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
  reader?: DnsReader;
}): Promise<HostedBimiView> {
  if (!hostedBimiAvailable()) {
    throw new HostedBimiError(
      'Hosted BIMI is not set up on this deployment.',
      'HOSTED_BIMI_UNAVAILABLE',
      503,
    );
  }
  // Throws when the origin is missing, before anything is written.
  origin();

  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new HostedBimiError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  if (domain.status !== 'VERIFIED') {
    throw new HostedBimiError(
      'Verify the domain before hosting its BIMI record.',
      'DOMAIN_NOT_VERIFIED',
      409,
    );
  }

  const existing = await prisma.hostedBimiRecord.findUnique({ where: { domainId: domain.id } });
  if (existing && existing.status !== 'RELEASED') {
    throw new HostedBimiError(
      'This domain already has a hosted BIMI record.',
      'ALREADY_HOSTED',
      409,
    );
  }

  const count = await usedHostedRecords();
  if (count >= env.HOSTED_DNS_RECORD_LIMIT) {
    throw new HostedBimiError(
      'Hosting is full on this deployment right now. Publish the BIMI record yourself.',
      'HOSTED_DNS_FULL',
      503,
    );
  }

  const previousValue = await existingBimiValue(domain.name, dnsReader(input.reader));

  if (existing) {
    // A released row is replaced rather than reactivated: its token was in a
    // CNAME that no longer points here, and its assets are retired.
    await prisma.hostedBimiRecord.delete({ where: { id: existing.id } });
  }

  const token = await uniqueBimiToken();
  let row: HostedBimiRecord;
  try {
    row = await prisma.hostedBimiRecord.create({
      data: {
        organizationId: input.organizationId,
        domainId: domain.id,
        token,
        status: 'PENDING',
        previousValue,
        createdById: input.actorUserId,
      },
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002') {
      throw new HostedBimiError('This domain already has a hosted BIMI record.', 'ALREADY_HOSTED', 409);
    }
    throw error;
  }

  await prisma.hostedBimiChange.create({
    data: {
      recordId: row.id,
      organizationId: input.organizationId,
      reason: 'created',
      actorUserId: input.actorUserId,
    },
  });
  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'HOSTED_BIMI_CREATED',
    targetType: 'domain',
    targetId: domain.id,
    detail: { domainName: domain.name, previousValue: previousValue ? true : false },
  });
  capacityWarning(count + 1);

  const fresh = await prisma.hostedBimiRecord.findUniqueOrThrow({ where: { id: row.id } });
  return viewFor(input.organizationId, domain, fresh);
}

// ─── uploads ────────────────────────────────────────────────────────────────

async function hostedRowFor(organizationId: string, domainRefOrId: string) {
  const domain = await domainFor(organizationId, domainRefOrId);
  if (!domain) {
    throw new HostedBimiError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedBimiRecord.findUnique({ where: { domainId: domain.id } });
  if (!row) {
    throw new HostedBimiError('This domain does not have a hosted BIMI record.', 'NOT_HOSTED', 404);
  }
  if (row.status === 'RELEASING' || row.status === 'RELEASED') {
    throw new HostedBimiError(
      'This record is being released and cannot be changed.',
      'HOSTED_BIMI_RELEASING',
      409,
    );
  }
  return { domain, row };
}

/**
 * Stores the exact bytes received.
 *
 * Never rewritten, sanitised or reformatted: the certificate authority
 * validated those exact bytes for a Verified Mark Certificate, and changing one
 * byte breaks the match the CA made.
 */
export async function uploadBimiLogo(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
  bytes: Buffer;
}): Promise<HostedBimiView & { action: 'updated' | 'unchanged' }> {
  if (!hostedBimiAvailable()) {
    throw new HostedBimiError(
      'Hosted BIMI is not set up on this deployment.',
      'HOSTED_BIMI_UNAVAILABLE',
      503,
    );
  }
  const { domain, row } = await hostedRowFor(input.organizationId, input.domainId);

  if (input.bytes.length === 0) {
    throw new HostedBimiError(
      'The upload was empty. Choose the SVG file your certificate authority approved.',
      'BIMI_LOGO_INVALID',
      400,
      { failed: ['The file is empty'] },
    );
  }
  if (!isValidUtf8(input.bytes)) {
    throw new HostedBimiError(
      'The file is not valid UTF-8, so it is not the SVG your certificate authority approved.',
      'BIMI_LOGO_INVALID',
      400,
      { failed: ['The file is not valid UTF-8'] },
    );
  }
  const text = input.bytes.toString('utf8');
  if (hasXmlEntityTricks(text)) {
    throw new HostedBimiError(
      'The file contains a DOCTYPE or ENTITY declaration, which a BIMI logo must not have.',
      'BIMI_LOGO_INVALID',
      400,
      { failed: ['No DOCTYPE or ENTITY declarations'] },
    );
  }

  // The same function the scanner uses, so an upload can never be accepted here
  // and reported as invalid by the next scan of the same URL.
  const checks = inspectBimiSvg(input.bytes);
  const failed = failedBimiChecks(checks);
  if (failed.length > 0) {
    throw new HostedBimiError(
      `The SVG failed ${failed.length} of the 7 BIMI checks: ${failed.join('; ')}.`,
      'BIMI_LOGO_INVALID',
      400,
      { failed },
    );
  }

  const sha256 = sha256Hex(input.bytes);
  const current = await servableAsset(row.id, 'LOGO');
  if (current && current.sha256 === sha256) {
    return { ...(await viewFor(input.organizationId, domain, row)), action: 'unchanged' };
  }

  // A row publishes nothing until its first logo, so starting does not use a
  // record and the capacity check at start cannot stop it. The first logo is
  // what adds the TXT, so it is the point where the zone limit applies.
  if (!current && (await usedHostedRecords()) >= env.HOSTED_DNS_RECORD_LIMIT) {
    throw new HostedBimiError(
      'Hosting is full on this deployment right now. Publish the BIMI record yourself.',
      'HOSTED_DNS_FULL',
      503,
    );
  }

  const now = new Date();
  await prisma.$transaction(async (transaction) => {
    await transaction.hostedBimiAsset.updateMany({
      where: { recordId: row.id, kind: 'LOGO', retiredAt: null },
      data: { retiredAt: now },
    });
    await transaction.hostedBimiAsset.upsert({
      where: { recordId_kind_sha256: { recordId: row.id, kind: 'LOGO', sha256 } },
      create: {
        recordId: row.id,
        kind: 'LOGO',
        sha256,
        bytes: input.bytes,
        contentType: 'image/svg+xml',
      },
      update: { retiredAt: null, bytes: input.bytes, contentType: 'image/svg+xml' },
    });
    await transaction.hostedBimiChange.create({
      data: {
        recordId: row.id,
        organizationId: input.organizationId,
        reason: 'logo',
        previousLogoSha: current?.sha256 ?? null,
        newLogoSha: sha256,
        actorUserId: input.actorUserId,
      },
    });
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'HOSTED_BIMI_LOGO_UPDATED',
    targetType: 'domain',
    targetId: domain.id,
    detail: {
      domainName: domain.name,
      previous: current ? bimiLogoSha12(current.sha256) : null,
      next: bimiLogoSha12(sha256),
      bytes: input.bytes.length,
    },
  });

  // The upload has landed. A provider failure is recorded on the row and the
  // reconciler retries, rather than discarding bytes the person just chose.
  await syncBimiValue(row);
  const fresh = await prisma.hostedBimiRecord.findUniqueOrThrow({ where: { id: row.id } });
  return { ...(await viewFor(input.organizationId, domain, fresh)), action: 'updated' };
}

interface ParsedCertificate {
  leaf: X509Certificate;
  chain: X509Certificate[];
}

/**
 * Reads a PEM chain: one or more CERTIFICATE blocks and nothing else.
 *
 * The whole body is matched rather than searched, so a file that also contains
 * a key, a bag attribute or a paragraph of instructions is refused instead of
 * being quietly picked over.
 */
export function parsePemChain(bytes: Buffer): ParsedCertificate {
  const text = bytes.toString('utf8');
  if (/PRIVATE KEY/i.test(text)) {
    throw new HostedBimiError(
      'This file contains a private key. Upload only the certificate file your certificate authority sent; never share the private key.',
      'BIMI_CERT_HAS_PRIVATE_KEY',
      400,
    );
  }

  const blockPattern = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  const blocks: string[] = [];
  for (const match of text.matchAll(blockPattern)) {
    blocks.push(match[0]);
  }
  if (blocks.length === 0) {
    throw new HostedBimiError(
      'That file is not a PEM certificate. Upload the .pem file your certificate authority sent, beginning with -----BEGIN CERTIFICATE-----.',
      'BIMI_CERT_INVALID',
      400,
    );
  }

  // Everything outside the blocks must be whitespace. `replace` with an empty
  // string is exact: anything left is text the person did not mean to send.
  const remainder = text.replace(blockPattern, '').trim();
  if (remainder.length > 0) {
    throw new HostedBimiError(
      'That file has content outside the certificate blocks. Upload only the certificate file your certificate authority sent.',
      'BIMI_CERT_INVALID',
      400,
    );
  }

  const chain: X509Certificate[] = [];
  for (const block of blocks) {
    try {
      chain.push(new X509Certificate(block));
    } catch {
      throw new HostedBimiError(
        'One of the certificates in that file could not be read. Upload the .pem file your certificate authority sent.',
        'BIMI_CERT_INVALID',
        400,
      );
    }
  }

  return { leaf: chain[0]!, chain };
}

/** DNS names in the leaf's subject alternative names, lowercased. */
function subjectAltNames(certificate: X509Certificate): string[] {
  const value = certificate.subjectAltName ?? '';
  return value
    .split(/,\s*/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('DNS:'))
    .map((entry) => entry.slice(4).trim().toLowerCase())
    .filter(Boolean);
}

function commonNameOrOrg(subject: string, field: 'CN' | 'O'): string | null {
  const pattern = new RegExp(`(?:^|\\n)${field}=([^\\n]+)`);
  const match = pattern.exec(subject);
  return match ? cut(match[1]) : null;
}

/**
 * Whether the leaf carries the extended key usage a mark certificate has.
 *
 * Node exposes no EKU accessor, so the DER is searched for the exact encoding
 * of the OID. That is a byte search, which could in principle match inside
 * another value; it is used for a display label only, never for a decision, and
 * the panel says so.
 */
export function hasMarkCertificateEku(der: Buffer): boolean {
  return der.includes(markCertificateEkuDer);
}

export interface ValidatedBimiCertificate {
  leaf: X509Certificate;
  chain: X509Certificate[];
  sha256: string;
  validFrom: Date;
  expiresAt: Date;
  issuer: string | null;
  subject: string | null;
  isMarkCertificate: boolean;
  names: string[];
}

/**
 * Everything that decides whether a PEM file may be published, with no database
 * and no clock of its own.
 *
 * Separate from the upload so a unit test can exercise each refusal — an
 * expired leaf, a leaf that names another domain, trailing junk — without
 * seeding a workspace, and so the same rules cannot drift between the two.
 */
export function validateBimiCertificate(input: {
  bytes: Buffer;
  domainName: string;
  now?: Date;
}): ValidatedBimiCertificate {
  const parsed = parsePemChain(input.bytes);
  const leaf = parsed.leaf;
  const now = input.now ?? new Date();

  const validFrom = new Date(leaf.validFrom);
  const expiresAt = new Date(leaf.validTo);
  if (Number.isNaN(validFrom.getTime()) || Number.isNaN(expiresAt.getTime())) {
    throw new HostedBimiError(
      'The certificate has no readable validity period.',
      'BIMI_CERT_INVALID',
      400,
    );
  }
  if (expiresAt.getTime() <= now.getTime()) {
    throw new HostedBimiError(
      `That certificate expired on ${expiresAt.toISOString().slice(0, 10)}. Upload the current one your certificate authority issued.`,
      'BIMI_CERT_EXPIRED',
      400,
    );
  }
  if (validFrom.getTime() > now.getTime()) {
    throw new HostedBimiError(
      `That certificate is not valid until ${validFrom.toISOString().slice(0, 10)}.`,
      'BIMI_CERT_NOT_YET_VALID',
      400,
    );
  }

  const names = subjectAltNames(leaf);
  const org = organizationalDomain(input.domainName);
  const acceptable = new Set([input.domainName.toLowerCase(), org].filter(Boolean));
  const covered = names.some((name) => acceptable.has(name.replace(/^\*\./, '')));
  if (!covered) {
    throw new HostedBimiError(
      `That certificate does not name ${input.domainName}${org && org !== input.domainName ? ` or ${org}` : ''}. It lists ${names.length > 0 ? names.join(', ') : 'no DNS names'}.`,
      'BIMI_CERT_WRONG_DOMAIN',
      400,
    );
  }

  return {
    leaf,
    chain: parsed.chain,
    sha256: sha256Hex(input.bytes),
    validFrom,
    expiresAt,
    issuer: commonNameOrOrg(leaf.issuer, 'CN') ?? commonNameOrOrg(leaf.issuer, 'O'),
    subject: commonNameOrOrg(leaf.subject, 'O'),
    isMarkCertificate: hasMarkCertificateEku(Buffer.from(leaf.raw)),
    names,
  };
}

export async function uploadBimiCertificate(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
  bytes: Buffer;
}): Promise<HostedBimiView & { action: 'updated' | 'unchanged' }> {
  if (!hostedBimiAvailable()) {
    throw new HostedBimiError(
      'Hosted BIMI is not set up on this deployment.',
      'HOSTED_BIMI_UNAVAILABLE',
      503,
    );
  }
  const { domain, row } = await hostedRowFor(input.organizationId, input.domainId);
  const parsed = validateBimiCertificate({ bytes: input.bytes, domainName: domain.name });
  const now = new Date();
  const validTo = parsed.expiresAt;

  const sha256 = parsed.sha256;
  const current = await servableAsset(row.id, 'CERTIFICATE');
  if (current && current.sha256 === sha256) {
    return { ...(await viewFor(input.organizationId, domain, row)), action: 'unchanged' };
  }

  const issuer = parsed.issuer;
  const subject = parsed.subject;

  await prisma.$transaction(async (transaction) => {
    await transaction.hostedBimiAsset.updateMany({
      where: { recordId: row.id, kind: 'CERTIFICATE', retiredAt: null },
      data: { retiredAt: now },
    });
    await transaction.hostedBimiAsset.upsert({
      where: { recordId_kind_sha256: { recordId: row.id, kind: 'CERTIFICATE', sha256 } },
      create: {
        recordId: row.id,
        kind: 'CERTIFICATE',
        sha256,
        bytes: input.bytes,
        contentType: 'application/pem-certificate-chain',
      },
      update: {
        retiredAt: null,
        bytes: input.bytes,
        contentType: 'application/pem-certificate-chain',
      },
    });
    await transaction.hostedBimiRecord.update({
      where: { id: row.id },
      data: {
        certificateExpiresAt: validTo,
        certificateIssuer: issuer,
        certificateSubject: subject,
      },
    });
    await transaction.hostedBimiChange.create({
      data: {
        recordId: row.id,
        organizationId: input.organizationId,
        reason: 'certificate',
        previousCertSha: current?.sha256 ?? null,
        newCertSha: sha256,
        actorUserId: input.actorUserId,
      },
    });
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'HOSTED_BIMI_CERTIFICATE_UPDATED',
    targetType: 'domain',
    targetId: domain.id,
    detail: {
      domainName: domain.name,
      previous: current ? bimiLogoSha12(current.sha256) : null,
      next: bimiLogoSha12(sha256),
      expiresAt: validTo.toISOString(),
    },
  });

  await syncBimiValue(row);
  const fresh = await prisma.hostedBimiRecord.findUniqueOrThrow({ where: { id: row.id } });
  return { ...(await viewFor(input.organizationId, domain, fresh)), action: 'updated' };
}

export async function removeBimiCertificate(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
}): Promise<HostedBimiView & { action: 'removed' | 'unchanged' }> {
  if (!hostedBimiAvailable()) {
    throw new HostedBimiError(
      'Hosted BIMI is not set up on this deployment.',
      'HOSTED_BIMI_UNAVAILABLE',
      503,
    );
  }
  const { domain, row } = await hostedRowFor(input.organizationId, input.domainId);
  const current = await servableAsset(row.id, 'CERTIFICATE');
  if (!current) {
    return { ...(await viewFor(input.organizationId, domain, row)), action: 'unchanged' };
  }

  const now = new Date();
  await prisma.$transaction(async (transaction) => {
    await transaction.hostedBimiAsset.updateMany({
      where: { recordId: row.id, kind: 'CERTIFICATE', retiredAt: null },
      data: { retiredAt: now },
    });
    await transaction.hostedBimiRecord.update({
      where: { id: row.id },
      data: { certificateExpiresAt: null, certificateIssuer: null, certificateSubject: null },
    });
    await transaction.hostedBimiChange.create({
      data: {
        recordId: row.id,
        organizationId: input.organizationId,
        reason: 'certificate-removed',
        previousCertSha: current.sha256,
        actorUserId: input.actorUserId,
      },
    });
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'HOSTED_BIMI_CERTIFICATE_REMOVED',
    targetType: 'domain',
    targetId: domain.id,
    detail: { domainName: domain.name, previous: bimiLogoSha12(current.sha256) },
  });

  await syncBimiValue(row);
  const fresh = await prisma.hostedBimiRecord.findUniqueOrThrow({ where: { id: row.id } });
  return { ...(await viewFor(input.organizationId, domain, fresh)), action: 'removed' };
}

// ─── check and release ──────────────────────────────────────────────────────

export async function checkBimiDelegation(input: {
  organizationId: string;
  domainId: string;
  reader?: DnsReader;
}): Promise<HostedBimiView> {
  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new HostedBimiError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedBimiRecord.findUnique({ where: { domainId: domain.id } });
  if (!row) {
    throw new HostedBimiError('This domain does not have a hosted BIMI record.', 'NOT_HOSTED', 404);
  }
  if (row.status === 'RELEASED') {
    return viewFor(input.organizationId, domain, row);
  }

  const reader = dnsReader(input.reader);
  const lookup = reader.resolveCname
    ? await reader.resolveCname(bimiCustomerName(domain.name))
    : null;

  /**
   * A failed lookup says nothing about delegation, so it changes nothing.
   *
   * Reading the TXT at the customer name would follow the CNAME and return our
   * own value, which looks exactly like "the customer published their own" and
   * would release a record the CNAME still points at.
   */
  if (!lookup || lookup.status === 'error') {
    return viewFor(input.organizationId, domain, row);
  }

  const target = lookup.status === 'found' ? lookup.value?.[0] ?? null : null;
  const delegated =
    Boolean(target) &&
    target!.trim().toLowerCase().replace(/\.+$/, '') === bimiRecordName(row.token);

  const now = new Date();
  let update: Parameters<typeof prisma.hostedBimiRecord.update>[0]['data'] = {
    delegated,
    delegationCheckedAt: now,
  };

  if (row.status === 'PENDING' && delegated) {
    update = { ...update, status: 'ACTIVE', activatedAt: row.activatedAt ?? now };
  }

  // Released once the CNAME no longer points at us: removed (missing), or
  // pointed at another provider (found, but not our name). Waiting only for
  // "missing" left a domain that moved to another BIMI host releasing forever.
  if (row.status === 'RELEASING' && !delegated) {
    const provider = hostedDnsProvider();
    if (!provider) {
      throw new HostedBimiError(
        'Hosted BIMI is not set up on this deployment.',
        'HOSTED_BIMI_UNAVAILABLE',
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
  }

  const updated = await prisma.hostedBimiRecord.update({ where: { id: row.id }, data: update });

  // The guard above returned for a released row, so this can only be the
  // transition out of RELEASING.
  if (updated.status === 'RELEASED') {
    await retireAssets(row.id, now);
    await prisma.hostedBimiChange.create({
      data: {
        recordId: row.id,
        organizationId: input.organizationId,
        reason: 'released',
      },
    });
    await recordAuditEvent({
      organizationId: input.organizationId,
      action: 'HOSTED_BIMI_RELEASED',
      targetType: 'domain',
      targetId: domain.id,
      detail: { domainName: domain.name },
    });
  }

  return viewFor(input.organizationId, domain, updated);
}

async function retireAssets(recordId: string, now: Date): Promise<void> {
  await prisma.hostedBimiAsset.updateMany({
    where: { recordId, retiredAt: null },
    data: { retiredAt: now },
  });
}

export async function requestBimiRelease(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string;
  removeNow?: boolean;
}): Promise<HostedBimiView> {
  const domain = await domainFor(input.organizationId, input.domainId);
  if (!domain) {
    throw new HostedBimiError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const row = await prisma.hostedBimiRecord.findUnique({ where: { domainId: domain.id } });
  if (!row) {
    throw new HostedBimiError('This domain does not have a hosted BIMI record.', 'NOT_HOSTED', 404);
  }
  if (row.status === 'RELEASED') {
    return viewFor(input.organizationId, domain, row);
  }

  const now = new Date();
  /**
   * Removing BIMI never affects mail delivery, only the logo, so a person who
   * says "remove it now" is not asked to wait for a DNS check. A record that
   * was never delegated has nothing to hand back either, so it goes at once.
   * The CNAME is the customer's to remove at their own pace; what stops
   * immediately is the TXT and the files it points at.
   */
  const releaseNow = input.removeNow === true || row.status === 'PENDING';
  if (!releaseNow && row.status === 'RELEASING') {
    return viewFor(input.organizationId, domain, row);
  }

  if (releaseNow) {
    const provider = hostedDnsProvider();
    if (provider) {
      try {
        await removeOurRecords(provider, row);
      } catch (error) {
        throw new HostedBimiError(
          error instanceof Error ? error.message : 'The DNS provider refused the removal.',
          'HOSTED_DNS_PROVIDER_FAILED',
          502,
        );
      }
    }
    const released = await prisma.hostedBimiRecord.update({
      where: { id: row.id },
      data: {
        status: 'RELEASED',
        releasedAt: now,
        releaseRequestedAt: row.releaseRequestedAt ?? now,
        providerRecordId: null,
        lastSyncError: null,
      },
    });
    await retireAssets(row.id, now);
    await prisma.hostedBimiChange.create({
      data: {
        recordId: row.id,
        organizationId: input.organizationId,
        reason: 'released',
        actorUserId: input.actorUserId,
      },
    });
    await recordAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'HOSTED_BIMI_RELEASED',
      targetType: 'domain',
      targetId: domain.id,
      detail: { domainName: domain.name },
    });
    return viewFor(input.organizationId, domain, released);
  }

  const updated = await prisma.hostedBimiRecord.update({
    where: { id: row.id },
    data: { status: 'RELEASING', releaseRequestedAt: now },
  });
  return viewFor(input.organizationId, domain, updated);
}

// ─── lifecycle ──────────────────────────────────────────────────────────────

export async function hostedBimiSnapshotsForDomainIds(
  domainIds: string[],
): Promise<HostedBimiDeletionSnapshot[]> {
  if (domainIds.length === 0) return [];
  return prisma.hostedBimiRecord.findMany({
    where: { domainId: { in: domainIds } },
    select: { id: true, token: true, providerRecordId: true },
  });
}

/** Best-effort provider cleanup after the database rows have already gone. */
export async function removeHostedBimiForDeletion(
  records: HostedBimiDeletionSnapshot[],
): Promise<void> {
  const provider = hostedDnsProvider();
  if (!provider || records.length === 0) {
    return;
  }
  for (const record of records) {
    try {
      await removeOurRecords(provider, record);
    } catch (error) {
      console.error(
        `[hosted-bimi] could not remove the provider record for ${record.token}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}

// ─── reconciler ─────────────────────────────────────────────────────────────

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The names our BIMI records live at, and nothing else. */
export function hostedBimiNamePattern(zone: string): RegExp {
  return new RegExp(`^[a-z2-7]{16}\\.bimi\\.${escapeRegExp(zone)}$`);
}

/**
 * One reconciler pass: keep every live TXT in step with the stored assets, drop
 * token-shaped records with our comment that no row owns, and purge assets that
 * have been retired longer than the grace period.
 *
 * A provider write that fails is recorded on the row and never thrown: one bad
 * row must not abandon the rest of the pass.
 */
export async function reconcileHostedBimi(now: Date = new Date()): Promise<HostedBimiReconcileSummary> {
  const summary: HostedBimiReconcileSummary = { synced: 0, failed: 0, removed: 0, purged: 0 };
  const provider = hostedDnsProvider();
  if (!provider || !hostedBimiAvailable()) {
    return summary;
  }

  const rows = await prisma.hostedBimiRecord.findMany({ where: { status: { not: 'RELEASED' } } });
  for (const row of rows) {
    const result = await syncBimiValue(row);
    if (result.ok) summary.synced += 1;
    else summary.failed += 1;
  }

  const namePattern = hostedBimiNamePattern(provider.zone);
  for await (const record of provider.listAll()) {
    const name = record.name.toLowerCase().replace(/\.+$/, '');
    if (!namePattern.test(name)) continue;
    if (!record.comment?.startsWith(hostedBimiCommentPrefix)) continue;

    const token = name.slice(0, name.indexOf('.'));
    const owner = await prisma.hostedBimiRecord.findUnique({
      where: { token },
      select: { id: true, status: true },
    });
    if (owner && owner.status !== 'RELEASED') continue;
    try {
      await provider.remove(record.id);
      summary.removed += 1;
    } catch (error) {
      console.error(
        `[hosted-bimi] could not remove orphan ${name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  const cutoff = new Date(now.getTime() - bimiAssetGraceDays * 24 * 60 * 60 * 1000);
  const purged = await prisma.hostedBimiAsset.deleteMany({
    where: { retiredAt: { lt: cutoff } },
  });
  summary.purged = purged.count;

  return summary;
}

/**
 * The public lookup: one servable asset for a token and a 12-character prefix.
 *
 * Returns null for everything that must answer 404 — an unknown token, a
 * released record, an unknown prefix, a retired asset past its grace — so the
 * route cannot tell a caller which of those it hit.
 */
export async function bimiAssetForPublicPath(input: {
  token: string;
  sha12: string;
  kind: 'LOGO' | 'CERTIFICATE';
  now?: Date;
}): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!isHostedToken(input.token)) return null;
  if (!/^[0-9a-f]{12}$/.test(input.sha12)) return null;

  const record = await prisma.hostedBimiRecord.findUnique({
    where: { token: input.token },
    select: { id: true, status: true },
  });
  if (!record || record.status === 'RELEASED') return null;

  const assets = await prisma.hostedBimiAsset.findMany({
    where: { recordId: record.id, kind: input.kind, sha256: { startsWith: input.sha12 } },
    orderBy: { createdAt: 'desc' },
  });
  const now = input.now ?? new Date();
  const asset = assets.find((candidate) => bimiAssetServable(candidate, now));
  if (!asset) return null;

  return { bytes: Buffer.from(asset.bytes), contentType: asset.contentType };
}
