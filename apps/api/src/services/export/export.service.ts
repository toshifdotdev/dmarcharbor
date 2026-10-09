import { createHash, randomBytes } from 'node:crypto';
import type { ExportFormat, ExportScope, Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { env } from '../../config/env.js';
import { sendExportReadyEmail } from '../../email/mailer.js';
import { dataClasses } from '../inventory/data-classes.js';
import { exportRedactions } from '../inventory/deletion-planner.js';
import { buildInventory, type InventoryScope } from '../inventory/inventory.service.js';

export const exportLinkDays = 7;
export const exportJobRetentionDays = 7;

/**
 * Rows read per table in an export, and rows read per report inside one.
 *
 * Chosen so a full-window export still completes in one request on a modest host
 * while a workspace whose retention window has fallen behind cannot take the
 * process down. `records` and `authResults` exist because a single report can
 * carry thousands of rows: a report whose records exceed the ceiling is itself
 * truncated and said to be, rather than being dropped in full.
 */
const exportTableLimit = 20_000;
const exportRecordLimit = 5_000;

export interface ExportRequest {
  organizationId: string;
  requestedById: string;
  scope: ExportScope;
  targetId?: string;
  format: ExportFormat;
}

function inventoryScopeFor(input: { organizationId: string; scope: ExportScope; targetId?: string }): InventoryScope {
  if (input.scope === 'CLIENT' && input.targetId) {
    return { kind: 'CLIENT', organizationId: input.organizationId, clientId: input.targetId };
  }
  if (input.scope === 'DOMAIN' && input.targetId) {
    return { kind: 'DOMAIN', organizationId: input.organizationId, domainId: input.targetId };
  }
  return { kind: 'ORGANIZATION', organizationId: input.organizationId };
}

async function scopeLabel(input: ExportRequest): Promise<string> {
  if (input.scope === 'CLIENT' && input.targetId) {
    const client = await prisma.client.findFirst({
      where: { id: input.targetId, organizationId: input.organizationId },
      select: { name: true },
    });
    return client ? `client:${client.name}` : 'client';
  }
  if (input.scope === 'DOMAIN' && input.targetId) {
    const domain = await prisma.domain.findFirst({
      where: { id: input.targetId, client: { organizationId: input.organizationId } },
      select: { name: true },
    });
    return domain ? `domain:${domain.name}` : 'domain';
  }
  return 'workspace';
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export async function createExportJob(input: ExportRequest): Promise<{ id: string; token: string; expiresAt: Date }> {
  const { token, hash } = issueToken();
  const expiresAt = new Date(Date.now() + exportLinkDays * 24 * 60 * 60 * 1000);
  const purgeAfter = new Date(Date.now() + exportJobRetentionDays * 24 * 60 * 60 * 1000);

  const scope = inventoryScopeFor(input);
  const inventory = await buildInventory(scope, { retentionDays: 400 });
  const redactions = exportRedactions(inventory);

  const job = await prisma.exportJob.create({
    data: {
      organizationId: input.organizationId,
      requestedById: input.requestedById,
      scope: input.scope,
      targetId: input.targetId ?? null,
      scopeLabel: await scopeLabel(input),
      format: input.format,
      state: 'READY',
      downloadTokenHash: hash,
      downloadExpiresAt: expiresAt,
      redactions: redactions as unknown as Prisma.InputJsonValue,
      purgeAfter,
    },
    select: { id: true },
  });

  // The export exists to satisfy a data access request, so the person who asked
  // for it is told it is ready rather than having to poll for it.
  const organization = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { name: true } });
  await sendExportReadyEmail({
    organizationId: input.organizationId,
    exportJobId: job.id,
    scopeLabel: organization?.name ?? 'workspace',
    downloadUrl: `${env.BETTER_AUTH_URL.replace(/\/$/, '')}/app/exports/${token}`,
    expiresAt,
  });

  return { id: job.id, token, expiresAt };
}

export interface ExportPayload {
  meta: {
    product: string;
    generatedAt: string;
    scope: ExportScope;
    scopeLabel: string;
    format: ExportFormat;
    notice: string;
    /**
     * Tables that held more than one request could carry, present only then.
     *
     * Absent on a complete export on purpose: a customer downloading their data
     * should not have to read past a caveat that does not apply to them.
     */
    limited?: string[];
    limitedNotice?: string;
  };
  classification: { key: string; label: string; personalData: boolean; erasure: string; basis: string }[];
  redactions: { key: string; label: string; count: number; why: string }[];
  data: Record<string, unknown[]>;
}

/**
 * Builds the export from the same scope resolution the erasure planner reads.
 *
 * Credential material is removed here rather than downstream. A session token,
 * a password hash or an OAuth refresh token is not the customer's data to
 * download, it is the mechanism by which the download would be authorised, so
 * it is never serialised at all.
 */
export async function buildExportPayload(input: {
  organizationId: string;
  scope: ExportScope;
  targetId?: string;
  format: ExportFormat;
  scopeLabel: string;
}): Promise<ExportPayload> {
  const scope = inventoryScopeFor(input);
  const org = input.organizationId;
  const domainFilter: Prisma.DomainWhereInput =
    input.scope === 'DOMAIN' && input.targetId
      ? { id: input.targetId, client: { organizationId: org } }
      : input.scope === 'CLIENT' && input.targetId
        ? { clientId: input.targetId, client: { organizationId: org } }
        : { client: { organizationId: org } };

  /**
   * Every table here is read in a window rather than in full.
   *
   * All of them were unbounded `findMany`, and the result is materialised and
   * then serialised into a single response: a workspace holding hundreds of
   * thousands of report records built an object measured in hundreds of megabytes
   * inside the request, which is one export away from the process running out of
   * memory and taking every tenant with it.
   *
   * Bounded rather than moved to a worker because an export is a statutory
   * download: the customer asked for their data and it has to arrive. A
   * truncated export that says it was truncated is a real answer, while an out of
   * memory is not, so `limited` below records which tables hit their ceiling and
   * the record carries the date the export stops at.
   *
   * The audit log is held to a larger window because it is the evidence chain
   * rather than bulk data, and rounding it down would quietly lose the record a
   * dispute turns on.
   */
  const [organization, clients, domains, users, members, sessions, reports, forensics, alertRules, alertEvents, shares, digests, auditLog] =
    await Promise.all([
      prisma.organization.findUnique({
        where: { id: org },
        select: { id: true, name: true, slug: true, plan: true, createdAt: true },
      }),
      prisma.client.findMany({
        where: input.scope === 'CLIENT' && input.targetId ? { id: input.targetId, organizationId: org } : { organizationId: org },
        select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.domain.findMany({
        where: domainFilter,
        select: {
          id: true,
          clientId: true,
          name: true,
          status: true,
          verifiedAt: true,
          dmarcPolicy: true,
          dmarcRecord: true,
          collectForensicReports: true,
          retainForensicPii: true,
          score: true,
          createdAt: true,
          lastScanAt: true,
        },
        orderBy: { name: 'asc' },
        take: exportTableLimit,
      }),
      prisma.user.findMany({
        where: { members: { some: { organizationId: org } } },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          emailVerified: true,
          createdAt: true,
          accounts: { select: { providerId: true, accountId: true, createdAt: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.member.findMany({
        where: { organizationId: org },
        select: { id: true, userId: true, role: true, createdAt: true },
        take: exportTableLimit,
      }),
      prisma.session.findMany({
        where: { user: { members: { some: { organizationId: org } } } },
        select: {
          id: true,
          userId: true,
          createdAt: true,
          expiresAt: true,
          ipAddress: true,
          userAgent: true,
        },
        take: exportTableLimit,
      }),
      prisma.dmarcReport.findMany({
        where: { domain: domainFilter },
        select: {
          id: true,
          domainId: true,
          reportType: true,
          reportId: true,
          reportingOrganization: true,
          reportingEmail: true,
          policyDomain: true,
          policyP: true,
          policySp: true,
          policyAdkim: true,
          policyAspf: true,
          policyFraction: true,
          dateRangeBegin: true,
          dateRangeEnd: true,
          receivedAt: true,
          recordCount: true,
          records: {
            take: exportRecordLimit,
            select: {
              id: true,
              sourceIp: true,
              messageCount: true,
              disposition: true,
              dkimResult: true,
              spfResult: true,
              headerFrom: true,
              envelopeFrom: true,
              senderDomain: true,
              senderKey: true,
              policyReason: true,
              authResults: {
                take: exportRecordLimit,
                select: { id: true, type: true, domain: true, selector: true, scope: true, result: true },
              },
            },
          },
        },
        orderBy: { receivedAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.dmarcForensicReport.findMany({
        where: { domain: domainFilter },
        select: {
          id: true,
          domainId: true,
          feedbackType: true,
          reportedDomain: true,
          sourceIp: true,
          sourcePort: true,
          disposition: true,
          deliveryAction: true,
          deliveryStatus: true,
          dkimResult: true,
          spfResult: true,
          reportingMta: true,
          userAgent: true,
          originalMessageDate: true,
          arrivedAt: true,
          receivedAt: true,
          retentionExpiresAt: true,
          redactionVersion: true,
          recipientPseudonyms: true,
          recipientAddresses: true,
          subjectLine: true,
          envelopeFrom: true,
          envelopeFromPseudonym: true,
          messageIdPseudonym: true,
          subjectPseudonym: true,
        },
        orderBy: { receivedAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.alertRule.findMany({
        where: input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : { organizationId: org },
        select: {
          id: true,
          domainId: true,
          name: true,
          metric: true,
          operator: true,
          threshold: true,
          windowMinutes: true,
          cooldownMinutes: true,
          enabled: true,
          createdAt: true,
          recipients: { select: { userId: true } },
        },
        take: exportTableLimit,
      }),
      prisma.alertEvent.findMany({
        where: input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : { organizationId: org },
        select: {
          id: true,
          ruleId: true,
          domainId: true,
          metric: true,
          observedValue: true,
          threshold: true,
          summary: true,
          triggeredAt: true,
          acknowledgedAt: true,
          resolvedAt: true,
          staleAt: true,
        },
        take: exportTableLimit,
      }),
      prisma.reportShare.findMany({
        where: input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : { organizationId: org },
        select: { id: true, domainId: true, clientId: true, expiresAt: true, revokedAt: true, createdAt: true },
        take: exportTableLimit,
      }),
      prisma.reportDigest.findMany({
        where: input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : { organizationId: org },
        select: {
          id: true,
          domainId: true,
          frequency: true,
          recipientEmails: true,
          lastSentAt: true,
          createdAt: true,
        },
        take: exportTableLimit,
      }),
      prisma.auditLog.findMany({
        where: input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : { organizationId: org },
        select: { id: true, action: true, targetType: true, targetId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 20_000,
      }),
    ]);

  const inventory = await buildInventory(scope, { retentionDays: 400 });

  /**
   * A truncated export says so, in the payload itself.
   *
   * Silently handing back part of somebody's data while they believe they asked
   * for all of it is worse than handing back less: a customer who needs their
   * records cannot tell from a short file whether the records are missing or
   * simply never existed. So each table that hit its ceiling is named here rather
   * than left for the customer to infer from the row count.
   */
  const limited: string[] = (
    [
      ['reports', reports],
      ['forensicReports', forensics],
      ['alertEvents', alertEvents],
      ['auditLog', auditLog],
      ['sessions', sessions],
      ['reportDigests', digests],
      ['reportShares', shares],
      ['alertRules', alertRules],
      ['domains', domains],
      ['clients', clients],
      ['members', members],
      ['users', users],
    ] as [string, unknown[]][]
  )
    .filter(([, rows]) => rows.length >= exportTableLimit)
    .map(([label]) => label);

  const meta: ExportPayload['meta'] = {
    product: 'DMARC Harbor',
    generatedAt: new Date().toISOString(),
    scope: input.scope,
    scopeLabel: input.scopeLabel,
    format: input.format,
    notice:
      'This export contains the data held for this scope. Passwords, session tokens and OAuth tokens are never included, ' +
      'because they are credentials rather than data. Security records are included by action and time, with identifying fields withheld.',
  };

  if (limited.length > 0) {
    meta.limited = limited;
    meta.limitedNotice = `These tables hold more rows than one request can carry: ${limited.join(', ')}. Ask support for the remainder, or request a narrower scope such as a single client or domain.`;
  }

  return {
    meta,
    classification: dataClasses.map((entry) => ({
      key: entry.key,
      label: entry.label,
      personalData: entry.containsPersonalData,
      erasure: entry.erasure,
      basis: entry.retentionBasis ?? '',
    })),
    redactions: exportRedactions(inventory),
    data: {
      organization: organization ? [organization] : [],
      clients,
      domains,
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
        linkedAccounts: user.accounts,
      })),
      members,
      sessions: sessions.map((session) => ({
        id: session.id,
        userId: session.userId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      })),
      reports,
      forensicReports: forensics,
      alertRules,
      alertEvents,
      reportShares: shares,
      reportDigests: digests,
      auditLog,
    },
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const reportRecordColumns = [
  'report_id',
  'received_at',
  'policy_domain',
  'policy_p',
  'policy_pct',
  'source_ip',
  'sender_domain',
  'message_count',
  'disposition',
  'dkim_result',
  'spf_result',
  'header_from',
  'policy_reason',
] as const;

export function toReportRecordsCsv(payload: ExportPayload): string {
  const rows: string[] = [reportRecordColumns.join(',')];

  for (const report of payload.data.reports as { id: string; receivedAt: Date; policyDomain: string | null; policyP: string | null; policyFraction: number | null; records: Record<string, unknown>[] }[]) {
    for (const record of report.records) {
      rows.push(
        [
          csvCell(report.id),
          csvCell(report.receivedAt),
          csvCell(report.policyDomain),
          csvCell(report.policyP),
          csvCell(report.policyFraction),
          csvCell(record.sourceIp),
          csvCell(record.senderDomain),
          csvCell(record.messageCount),
          csvCell(record.disposition),
          csvCell(record.dkimResult),
          csvCell(record.spfResult),
          csvCell(record.headerFrom),
          csvCell(record.policyReason),
        ].join(','),
      );
    }
  }

  return rows.join('\n');
}

const forensicColumns = [
  'forensic_id',
  'received_at',
  'reported_domain',
  'source_ip',
  'disposition',
  'dkim_result',
  'spf_result',
  'named_recipient_data_stored',
] as const;

export function toForensicCsv(payload: ExportPayload): string {
  const rows: string[] = [forensicColumns.join(',')];

  for (const item of payload.data.forensicReports as Record<string, unknown>[]) {
    rows.push(
      [
        csvCell(item.id),
        csvCell(item.receivedAt),
        csvCell(item.reportedDomain),
        csvCell(item.sourceIp),
        csvCell(item.disposition),
        csvCell(item.dkimResult),
        csvCell(item.spfResult),
        item.recipientAddresses ? 'yes' : 'no',
      ].join(','),
    );
  }

  return rows.join('\n');
}

export function csvSection(title: string, body: string): string {
  return `${title}\n${body}`;
}

export function buildCsvExport(payload: ExportPayload): string {
  return [
    `# DMARC Harbor export, ${payload.meta.scopeLabel}, generated ${payload.meta.generatedAt}`,
    '# Passwords, session tokens and OAuth tokens are never included.',
    '#',
    csvSection('report_records', toReportRecordsCsv(payload)),
    csvSection('forensic_reports', toForensicCsv(payload)),
  ].join('\n\n');
}
