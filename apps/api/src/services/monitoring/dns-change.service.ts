import { prisma } from '../../database/prisma.js';
import { recordAuditEvent } from '../audit.service.js';
import { domainRef } from '../domain-ref.js';
import { enqueueDnsChangeAcknowledged } from '../psa/psa-queue.service.js';

export type DnsChangeSeverityName = 'INFO' | 'WARNING' | 'CRITICAL';

export interface DnsChangeRow {
  id: string;
  kind: string;
  severity: string;
  code: string;
  summary: string;
  before: unknown;
  after: unknown;
  detectedAt: Date;
  scanId: string;
  acknowledgedAt: Date | null;
  acknowledgedBy: { id: string; name: string } | null;
}

function publicRow(row: {
  id: string;
  kind: string;
  severity: string;
  code: string;
  summary: string;
  before: unknown;
  after: unknown;
  detectedAt: Date;
  scanId: string;
  acknowledgedAt: Date | null;
  acknowledgedBy: { id: string; name: string } | null;
}): DnsChangeRow {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    code: row.code,
    summary: row.summary,
    before: row.before,
    after: row.after,
    detectedAt: row.detectedAt,
    scanId: row.scanId,
    acknowledgedAt: row.acknowledgedAt,
    acknowledgedBy: row.acknowledgedBy,
  };
}

export async function listDnsChanges(
  organizationId: string,
  domainIdOrSlug: string,
  options: { limit?: number; cursor?: string; severity?: DnsChangeSeverityName[] } = {},
): Promise<{ rows: DnsChangeRow[]; nextCursor: string | null } | null> {
  const domain = await prisma.domain.findFirst({
    where: { client: { organizationId }, ...domainRef(domainIdOrSlug) },
    select: { id: true },
  });

  if (!domain) {
    return null;
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const rows = await prisma.dnsChange.findMany({
    where: {
      organizationId,
      domainId: domain.id,
      ...(options.severity && options.severity.length > 0
        ? { severity: { in: options.severity } }
        : {}),
    },
    select: {
      id: true,
      kind: true,
      severity: true,
      code: true,
      summary: true,
      before: true,
      after: true,
      detectedAt: true,
      scanId: true,
      acknowledgedAt: true,
      acknowledgedBy: { select: { id: true, name: true } },
    },
    orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return {
    rows: items.map(publicRow),
    nextCursor: hasMore && items.length > 0 ? items[items.length - 1]!.id : null,
  };
}

export async function acknowledgeDnsChange(input: {
  organizationId: string;
  domainIdOrSlug: string;
  changeId: string;
  actorUserId?: string | null;
  now?: Date;
}): Promise<DnsChangeRow | null> {
  const change = await prisma.dnsChange.findFirst({
    where: {
      id: input.changeId,
      organizationId: input.organizationId,
      domain: { client: { organizationId: input.organizationId }, ...domainRef(input.domainIdOrSlug) },
    },
    select: {
      id: true,
      domainId: true,
      acknowledgedAt: true,
    },
  });

  if (!change) {
    return null;
  }

  if (!change.acknowledgedAt) {
    await prisma.dnsChange.update({
      where: { id: change.id },
      data: {
        acknowledgedAt: input.now ?? new Date(),
        acknowledgedById: input.actorUserId ?? null,
      },
    });

    await recordAuditEvent({
      organizationId: input.organizationId,
      domainId: change.domainId,
      actorUserId: input.actorUserId ?? undefined,
      action: 'DNS_CHANGE_ACKNOWLEDGED',
      targetType: 'dns_change',
      targetId: change.id,
    });

    /**
     * The PSA ticket that covers this change learns about it, and closes when
     * every change on that ticket has been acknowledged. Queued, never called:
     * acknowledging a change must not wait on a third party.
     */
    try {
      const detail = await prisma.dnsChange.findUnique({
        where: { id: change.id },
        select: { summary: true },
      });
      const actor = input.actorUserId
        ? await prisma.user.findUnique({ where: { id: input.actorUserId }, select: { name: true } })
        : null;
      await enqueueDnsChangeAcknowledged({
        organizationId: input.organizationId,
        changeId: change.id,
        changeSummary: detail?.summary ?? 'DNS change acknowledged.',
        actorName: actor?.name ?? null,
      });
    } catch (error) {
      console.warn(
        `[psa] could not queue the acknowledgement for DNS change ${change.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  const updated = await prisma.dnsChange.findUniqueOrThrow({
    where: { id: change.id },
    select: {
      id: true,
      kind: true,
      severity: true,
      code: true,
      summary: true,
      before: true,
      after: true,
      detectedAt: true,
      scanId: true,
      acknowledgedAt: true,
      acknowledgedBy: { select: { id: true, name: true } },
    },
  });

  return publicRow(updated);
}
