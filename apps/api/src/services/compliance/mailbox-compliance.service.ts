import { prisma } from '../../database/prisma.js';
import { domainRef } from '../domain-ref.js';
import { normaliseIpAddress } from '../senders/ip-intel.service.js';
import {
  evaluateMailboxCompliance,
  mailboxRecordCap,
  providerForReport,
  type MailboxIpIntel,
  type MailboxRecordInput,
  type MailboxReportInput,
  type MailboxScanInput,
} from './mailbox-requirements.js';

export async function getMailboxCompliance(input: {
  organizationId: string;
  domainIdOrSlug: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const domain = await prisma.domain.findFirst({
    where: {
      client: { organizationId: input.organizationId },
      ...domainRef(input.domainIdOrSlug),
    },
    select: { id: true, name: true },
  });

  if (!domain) {
    return null;
  }

  const reportWindow = {
    OR: [
      { dateRangeEnd: { gte: windowStart } },
      { dateRangeEnd: null, receivedAt: { gte: windowStart } },
    ],
  };

  const [scan, reportRows, recordRows, reviews] = await Promise.all([
    prisma.scan.findFirst({
      where: { domainId: domain.id, status: 'COMPLETED', completedAt: { not: null } },
      orderBy: { completedAt: 'desc' },
      select: { id: true, completedAt: true, result: true },
    }),
    prisma.dmarcReport.findMany({
      where: {
        domainId: domain.id,
        reportType: 'AGGREGATE',
        ...reportWindow,
      },
      select: {
        id: true,
        reportingEmail: true,
        reportingOrganization: true,
        dateRangeBegin: true,
        dateRangeEnd: true,
        receivedAt: true,
      },
    }),
    prisma.dmarcReportRecord.findMany({
      where: {
        report: {
          domainId: domain.id,
          reportType: 'AGGREGATE',
          ...reportWindow,
        },
      },
      select: {
        reportId: true,
        sourceIp: true,
        messageCount: true,
        dkimResult: true,
        spfResult: true,
        senderKey: true,
        senderDomain: true,
        authResults: { select: { type: true, result: true, scope: true } },
      },
      orderBy: { report: { receivedAt: 'desc' } },
      take: mailboxRecordCap + 1,
    }),
    prisma.senderReview.findMany({
      where: { organizationId: input.organizationId, domainId: domain.id },
      select: { senderKey: true, status: true },
    }),
  ]);

  const rowsTruncated = recordRows.length > mailboxRecordCap;
  const cappedRecords = rowsTruncated ? recordRows.slice(0, mailboxRecordCap) : recordRows;

  const providerByReport = new Map<string, ReturnType<typeof providerForReport>>();
  for (const report of reportRows) {
    providerByReport.set(
      report.id,
      providerForReport(report.reportingEmail, report.reportingOrganization),
    );
  }

  // Every reporter's records are kept. Per-provider checks filter to their own
  // provider; reverse DNS and DKIM evidence use all of them, because a sending
  // IP's PTR does not depend on which receiver reported the mail.
  const recordsByReport = new Map<string, MailboxRecordInput[]>();
  const intelIps = new Set<string>();
  for (const record of cappedRecords) {
    if (!providerByReport.has(record.reportId)) {
      continue;
    }
    const spfRawPass = record.authResults.some(
      (result) =>
        result.type.trim().toUpperCase() === 'SPF' &&
        result.result.trim().toLowerCase() === 'pass' &&
        (result.scope === null || result.scope.trim().toLowerCase() === 'mfrom'),
    );
    const mapped: MailboxRecordInput = {
      sourceIp: record.sourceIp,
      messageCount: record.messageCount,
      dkimResult: record.dkimResult,
      spfResult: record.spfResult,
      senderKey: record.senderKey,
      senderDomain: record.senderDomain,
      spfRawPass,
    };
    const rows = recordsByReport.get(record.reportId) ?? [];
    rows.push(mapped);
    recordsByReport.set(record.reportId, rows);
    intelIps.add(normaliseIpAddress(record.sourceIp) ?? record.sourceIp.trim().toLowerCase());
  }

  const intelRows =
    intelIps.size > 0
      ? await prisma.sourceIpIntel.findMany({
          where: { ip: { in: [...intelIps] } },
          select: {
            ip: true,
            ptr: true,
            ptrConfirmed: true,
            status: true,
            expiresAt: true,
          },
        })
      : [];
  const intelByIp = new Map<string, MailboxIpIntel>(
    intelRows.map((row) => [
      row.ip,
      {
        ptr: row.ptr,
        ptrConfirmed: row.ptrConfirmed,
        status: row.status,
        expiresAt: row.expiresAt,
      },
    ]),
  );

  const ipIntel: Record<string, MailboxIpIntel | null> = {};
  for (const record of cappedRecords) {
    const normalised = normaliseIpAddress(record.sourceIp) ?? record.sourceIp.trim().toLowerCase();
    ipIntel[record.sourceIp] = intelByIp.get(normalised) ?? null;
  }

  const reports: MailboxReportInput[] = [];
  for (const report of reportRows) {
    reports.push({
      id: report.id,
      provider: providerByReport.get(report.id) ?? null,
      dateRangeBegin: report.dateRangeBegin,
      dateRangeEnd: report.dateRangeEnd,
      receivedAt: report.receivedAt,
      records: recordsByReport.get(report.id) ?? [],
    });
  }

  const reviewStatusBySender: Record<string, 'APPROVED' | 'NOT_OURS' | null> = {};
  for (const review of reviews) {
    reviewStatusBySender[review.senderKey] = review.status;
  }

  const scanInput =
    scan?.completedAt && scan.result
      ? {
          id: scan.id,
          completedAt: scan.completedAt.toISOString(),
          result: scan.result as unknown as MailboxScanInput,
        }
      : null;

  return evaluateMailboxCompliance({
    domain,
    scan: scanInput,
    reports,
    reviewStatusBySender,
    ipIntel,
    now,
    rowsTruncated,
  });
}
