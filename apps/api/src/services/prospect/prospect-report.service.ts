import { randomBytes } from 'node:crypto';
import type { Prisma, ProspectReport } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import type { ScanResult } from '../../models/scan.model.js';
import { DomainValidationError, normalizeDomain } from '../../scanner/domain.js';
import { scanDomain } from '../../scanner/scanner.js';
import { recordAuditEvent } from '../audit.service.js';
import { resolveBranding } from '../branding.service.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { planCatalog } from '../entitlements/plan-catalog.js';
import { assessProspect, type ProspectAssessment } from './prospect-findings.js';

/**
 * Prospect risk reports: a scan of a domain the workspace does not manage,
 * turned into a page the prospect can read, behind an expiring link.
 *
 * The scan runs once, when the MSP creates the report, and the result is
 * stored. Opening the link reads the stored copy: it never scans again, so a
 * link cannot be used to make this service probe a third party's DNS on
 * demand, and the prospect reads what the MSP read.
 */

export const defaultProspectDays = 30;
export const maximumProspectDays = 90;

export class ProspectReportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProspectReportError';
  }
}

type Scanner = (domain: string) => Promise<ScanResult>;
let scannerOverride: Scanner | null = null;

/** Test seam: a recorded scan instead of live DNS. */
export function setProspectScannerForTests(scanner: Scanner | null): void {
  scannerOverride = scanner;
}

function scanner(): Scanner {
  return scannerOverride ?? ((domain) => scanDomain(domain));
}

export function prospectReportUrl(token: string): string {
  return `${env.APP_URL.replace(/\/$/, '')}/prospect/${token}`;
}

function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfNextMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export interface ProspectUsage {
  used: number;
  limit: number;
  resetsAt: string;
}

async function monthlyLimit(organizationId: string, now: Date): Promise<number> {
  const entitlements = await resolveEntitlements(organizationId, now);
  if (!entitlements.features['prospects.reports']) return 0;
  return planCatalog[entitlements.plan]?.maxProspectReportsPerMonth ?? 0;
}

export async function prospectUsage(organizationId: string, now: Date = new Date()): Promise<ProspectUsage> {
  const [used, limit] = await Promise.all([
    prisma.prospectReport.count({ where: { organizationId, createdAt: { gte: startOfMonth(now) } } }),
    monthlyLimit(organizationId, now),
  ]);
  return { used, limit, resetsAt: startOfNextMonth(now).toISOString() };
}

function limitReached(usage: ProspectUsage): ProspectReportError {
  return new ProspectReportError(
    `This workspace has used all ${usage.limit} prospect reports for this month. The allowance resets on ${new Date(usage.resetsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })}.`,
    'PROSPECT_LIMIT_REACHED',
    402,
    { used: usage.used, limit: usage.limit, resetsAt: usage.resetsAt },
  );
}

export interface ProspectReportRow {
  id: string;
  domain: string;
  prospectName: string | null;
  score: number;
  level: string;
  url: string;
  scannedAt: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdBy: { id: string; name: string } | null;
  state: 'active' | 'expired' | 'revoked';
}

function rowView(
  row: ProspectReport & { createdBy: { id: string; name: string } | null },
  now: Date,
): ProspectReportRow {
  const assessment = assessProspect(row.result as unknown as ScanResult);
  return {
    id: row.id,
    domain: row.domain,
    prospectName: row.prospectName,
    score: row.score,
    level: assessment.level,
    url: prospectReportUrl(row.token),
    scannedAt: row.scannedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    viewCount: row.viewCount,
    lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    state: row.revokedAt ? 'revoked' : row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'active',
  };
}

export async function listProspectReports(
  organizationId: string,
  now: Date = new Date(),
): Promise<{ reports: ProspectReportRow[]; usage: ProspectUsage }> {
  const [rows, usage] = await Promise.all([
    prisma.prospectReport.findMany({
      where: { organizationId },
      include: { createdBy: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    }),
    prospectUsage(organizationId, now),
  ]);
  return { reports: rows.map((row) => rowView(row, now)), usage };
}

function cleanText(value: string | undefined | null, limit: number): string | null {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

export async function createProspectReport(input: {
  organizationId: string;
  actorUserId: string | null;
  domain: string;
  prospectName?: string | null;
  note?: string | null;
  contactEmail?: string | null;
  expiresInDays?: number;
  now?: Date;
}): Promise<ProspectReportRow> {
  const now = input.now ?? new Date();

  let domain: string;
  try {
    domain = normalizeDomain(input.domain);
  } catch (error) {
    if (error instanceof DomainValidationError) {
      throw new ProspectReportError(error.message, 'INVALID_DOMAIN', 400);
    }
    throw error;
  }

  // Checked before the scan, so a workspace at its limit does not make the
  // lookups at all. Checked again under the lock below, because two requests
  // can both pass here.
  const before = await prospectUsage(input.organizationId, now);
  if (before.used >= before.limit) throw limitReached(before);

  const result = await scanner()(domain);
  if (result.status === 'error') {
    throw new ProspectReportError(
      `We could not read the DNS for ${domain} just now. Nothing was saved, and it does not count toward this month.`,
      'SCAN_FAILED',
      502,
    );
  }

  const days = Math.min(Math.max(Math.trunc(input.expiresInDays ?? defaultProspectDays), 1), maximumProspectDays);
  const token = randomBytes(32).toString('base64url');

  const created = await prisma.$transaction(async (transaction) => {
    // The organisation row is the lock: one creation at a time per workspace,
    // so the count and the insert cannot interleave with another request's.
    await transaction.$queryRaw`SELECT id FROM "organization" WHERE id = ${input.organizationId} FOR UPDATE`;
    const used = await transaction.prospectReport.count({
      where: { organizationId: input.organizationId, createdAt: { gte: startOfMonth(now) } },
    });
    if (used >= before.limit) throw limitReached({ ...before, used });

    return transaction.prospectReport.create({
      data: {
        organizationId: input.organizationId,
        createdById: input.actorUserId,
        domain,
        prospectName: cleanText(input.prospectName, 120),
        note: cleanText(input.note, 600),
        contactEmail: cleanText(input.contactEmail, 254),
        token,
        result: result as unknown as Prisma.InputJsonValue,
        score: result.score,
        scannedAt: new Date(result.scannedAt),
        expiresAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
      },
      include: { createdBy: { select: { id: true, name: true } } },
    });
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'PROSPECT_REPORT_CREATED',
    targetType: 'prospect_report',
    targetId: created.id,
    detail: { domain, prospectName: created.prospectName, expiresInDays: days, score: created.score },
  });

  return rowView(created, now);
}

export async function revokeProspectReport(input: {
  organizationId: string;
  actorUserId: string | null;
  reportId: string;
}): Promise<boolean> {
  const result = await prisma.prospectReport.updateMany({
    where: { id: input.reportId, organizationId: input.organizationId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) return false;
  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'PROSPECT_REPORT_REVOKED',
    targetType: 'prospect_report',
    targetId: input.reportId,
  });
  return true;
}

/**
 * Removes a revoked report. Refused while the link still works, so a live
 * link can never disappear without its revocation in the audit trail. The
 * view count goes into the audit detail: it is the one record that the
 * prospect actually opened it.
 */
export async function deleteProspectReport(input: {
  organizationId: string;
  actorUserId: string | null;
  reportId: string;
}): Promise<'deleted' | 'not_found' | 'still_active'> {
  const row = await prisma.prospectReport.findFirst({
    where: { id: input.reportId, organizationId: input.organizationId },
    select: { id: true, domain: true, revokedAt: true, expiresAt: true, viewCount: true },
  });
  if (!row) return 'not_found';
  if (!row.revokedAt && row.expiresAt.getTime() > Date.now()) return 'still_active';

  await prisma.prospectReport.delete({ where: { id: row.id } });
  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'PROSPECT_REPORT_DELETED',
    targetType: 'prospect_report',
    targetId: row.id,
    detail: { domain: row.domain, viewCount: row.viewCount },
  });
  return 'deleted';
}

// ─── the public page ───────────────────────────────────────────────────────

export interface PublicProspectReport {
  preparedBy: {
    workspaceName: string;
    logoUrl: string | null;
    primaryColor: string | null;
    accentColor: string | null;
    branded: boolean;
  };
  domain: string;
  prospectName: string | null;
  note: string | null;
  contactEmail: string | null;
  scannedAt: string;
  expiresAt: string;
  score: number;
  assessment: ProspectAssessment;
  /** The public DNS the findings rest on, so a technician can check them. */
  evidence: {
    dmarcRecord: string | null;
    spfRecord: string | null;
    mailServers: string[];
    dkimSelectors: string[];
  };
}

export async function getPublicProspectReport(
  token: string,
  now: Date = new Date(),
): Promise<PublicProspectReport | null> {
  const row = await prisma.prospectReport.findUnique({ where: { token } });
  if (!row || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) return null;

  const scan = row.result as unknown as ScanResult;
  const brand = await resolveBranding(row.organizationId);

  await prisma.prospectReport.update({
    where: { id: row.id },
    data: { viewCount: { increment: 1 }, lastViewedAt: now },
  });

  return {
    preparedBy: {
      workspaceName: brand.workspaceName,
      logoUrl: brand.logoUrl,
      primaryColor: brand.primaryColor,
      accentColor: brand.accentColor,
      branded: brand.branded,
    },
    domain: row.domain,
    prospectName: row.prospectName,
    note: row.note,
    contactEmail: row.contactEmail,
    scannedAt: row.scannedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    score: row.score,
    assessment: assessProspect(scan),
    evidence: {
      dmarcRecord: scan.dmarc?.record ?? null,
      spfRecord: scan.spf?.record ?? null,
      mailServers: (scan.mx?.records ?? []).map((record) => record.exchange).slice(0, 10),
      dkimSelectors: (scan.dkim?.selectors ?? []).slice(0, 10),
    },
  };
}
