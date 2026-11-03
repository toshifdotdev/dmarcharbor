import { randomBytes } from 'node:crypto';
import type { PlanTier, Prisma, ProspectReport } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import type { ScanResult } from '../../models/scan.model.js';
import { DomainValidationError, normalizeDomain } from '../../scanner/domain.js';
import { scanDomain } from '../../scanner/scanner.js';
import { recordAuditEvent } from '../audit.service.js';
import { resolveBranding } from '../branding.service.js';
import { appOrigin, clientOrigin } from '../client-origin.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { nextTier, planCatalog } from '../entitlements/plan-catalog.js';
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

/**
 * The page the prospect opens. The prospect reads the agency's name on it, so
 * it is on the agency's own verified domain when there is one (`origin`, from
 * `clientOrigin`), and on APP_URL otherwise.
 */
export function prospectReportUrl(token: string, origin: string = appOrigin()): string {
  return `${origin}/prospect/${token}`;
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

interface MonthlyAllowance {
  limit: number;
  plan: PlanTier;
  planLabel: string;
}

async function monthlyAllowance(organizationId: string, now: Date): Promise<MonthlyAllowance> {
  const entitlements = await resolveEntitlements(organizationId, now);
  const limit = entitlements.features['prospects.reports']
    ? (planCatalog[entitlements.plan]?.maxProspectReportsPerMonth ?? 0)
    : 0;
  return { limit, plan: entitlements.plan, planLabel: entitlements.label };
}

/**
 * Reports created this month, counted so that removing one does not give it back.
 *
 * The allowance is a number of scans, and a scan has happened once the report
 * exists. Counting stored rows alone meant revoke-then-delete returned the slot:
 * an agency at its limit could remove a report and run another scan, as many
 * times as it liked. Every creation writes a PROSPECT_REPORT_CREATED audit row in
 * the same transaction as the report, and the audit log is never deleted from,
 * so it is the record that survives a removal.
 *
 * The larger of the two counts, not the audit count alone, so a report whose
 * audit row is missing (one made before the row was written in the same
 * transaction, when it was written after the commit and could fail) still
 * counts while it exists.
 */
async function createdThisMonth(
  client: Prisma.TransactionClient | typeof prisma,
  organizationId: string,
  now: Date,
): Promise<number> {
  const since = startOfMonth(now);
  const rows = await client.prospectReport.count({ where: { organizationId, createdAt: { gte: since } } });
  const created = await client.auditLog.count({
    where: { organizationId, action: 'PROSPECT_REPORT_CREATED', createdAt: { gte: since } },
  });
  return Math.max(rows, created);
}

export async function prospectUsage(organizationId: string, now: Date = new Date()): Promise<ProspectUsage> {
  const [used, allowance] = await Promise.all([
    createdThisMonth(prisma, organizationId, now),
    monthlyAllowance(organizationId, now),
  ]);
  return { used, limit: allowance.limit, resetsAt: startOfNextMonth(now).toISOString() };
}

/**
 * The refusal at the monthly allowance, with the way past it.
 *
 * It used to stop at the reset date, the one plan limit that did not name a
 * plan to move to. The next rung is named only when it actually allows more a
 * month; at the top (Admiralty, and Fleet, which is not a rung) the answer is to
 * get in touch.
 */
function limitReached(usage: ProspectUsage, allowance: MonthlyAllowance): ProspectReportError {
  const next = nextTier(allowance.plan);
  const nextLimit = next ? planCatalog[next].maxProspectReportsPerMonth : 0;
  const upgradeTo = next && nextLimit > usage.limit ? next : null;
  const resets = new Date(usage.resetsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  return new ProspectReportError(
    `This workspace has used all ${usage.limit} prospect reports for this month, and a removed report still counts. The allowance resets on ${resets}. ` +
      (upgradeTo
        ? `Upgrade to ${planCatalog[upgradeTo].label} for ${nextLimit} a month.`
        : 'Contact us to add more.'),
    'PROSPECT_LIMIT_REACHED',
    402,
    {
      used: usage.used,
      limit: usage.limit,
      resetsAt: usage.resetsAt,
      plan: allowance.plan,
      planLabel: allowance.planLabel,
      upgradeTo,
      upgradeToLabel: upgradeTo ? planCatalog[upgradeTo].label : null,
    },
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
  origin: string,
): ProspectReportRow {
  const assessment = assessProspect(row.result as unknown as ScanResult);
  return {
    id: row.id,
    domain: row.domain,
    prospectName: row.prospectName,
    score: row.score,
    level: assessment.level,
    url: prospectReportUrl(row.token, origin),
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
  const [rows, usage, origin] = await Promise.all([
    prisma.prospectReport.findMany({
      where: { organizationId },
      include: { createdBy: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    }),
    prospectUsage(organizationId, now),
    clientOrigin(organizationId),
  ]);
  return { reports: rows.map((row) => rowView(row, now, origin)), usage };
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
  const allowance = await monthlyAllowance(input.organizationId, now);
  const before: ProspectUsage = {
    used: await createdThisMonth(prisma, input.organizationId, now),
    limit: allowance.limit,
    resetsAt: startOfNextMonth(now).toISOString(),
  };
  if (before.used >= before.limit) throw limitReached(before, allowance);

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
    const used = await createdThisMonth(transaction, input.organizationId, now);
    if (used >= before.limit) throw limitReached({ ...before, used }, allowance);

    const report = await transaction.prospectReport.create({
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

    // In the same transaction and under the same lock as the report, because
    // this row is what the monthly count reads once the report is removed. A
    // row written after the commit could be missing, and the next request
    // under the lock could read the count before it landed.
    await recordAuditEvent(
      {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId ?? undefined,
        action: 'PROSPECT_REPORT_CREATED',
        targetType: 'prospect_report',
        targetId: report.id,
        detail: { domain, prospectName: report.prospectName, expiresInDays: days, score: report.score },
      },
      transaction,
    );

    return report;
  });

  return rowView(created, now, await clientOrigin(input.organizationId));
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
 *
 * Removing does not hand the month's scan back: the allowance is counted from
 * the creation record (createdThisMonth), which this does not touch.
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
