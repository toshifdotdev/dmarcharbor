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
  /**
   * The domain this change belongs to.
   *
   * Added for the workspace-wide list the public API needs: a row without a
   * domain name says "SPF record changed" and nothing about where. The browser
   * list is per domain and ignores it, so this is additive there too.
   */
  domain: { id: string; name: string; slug: string };
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
  domain: { id: string; name: string; slug: string };
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
    domain: row.domain,
  };
}

export async function listDnsChanges(
  organizationId: string,
  /**
   * A domain id or slug, or `null` for the whole workspace.
   *
   * The browser route always names a domain. The public API's `GET /dns-changes`
   * is workspace-wide with an optional `?domain=` filter, and one function that
   * can do both keeps the two callers from drifting into two different answers
   * about what a change row is.
   */
  domainIdOrSlug: string | null,
  options: {
    limit?: number;
    cursor?: string;
    severity?: DnsChangeSeverityName[];
    acknowledged?: boolean;
  } = {},
): Promise<{ rows: DnsChangeRow[]; nextCursor: string | null } | null> {
  const domain = domainIdOrSlug
    ? await prisma.domain.findFirst({
        where: { client: { organizationId }, ...domainRef(domainIdOrSlug) },
        select: { id: true },
      })
    : null;

  if (domainIdOrSlug && !domain) {
    return null;
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const rows = await prisma.dnsChange.findMany({
    where: {
      organizationId,
      ...(domain ? { domainId: domain.id } : {}),
      ...(options.severity && options.severity.length > 0
        ? { severity: { in: options.severity } }
        : {}),
      ...(options.acknowledged === undefined
        ? {}
        : options.acknowledged
          ? { acknowledgedAt: { not: null } }
          : { acknowledgedAt: null }),
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
      domain: { select: { id: true, name: true, slug: true } },
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
  /** A domain id or slug, or `null`/omitted for the workspace-wide API route. */
  domainIdOrSlug?: string | null;
  changeId: string;
  actorUserId?: string | null;
  /**
   * Set when the caller is a public API key rather than a person. It changes the
   * PSA note from "by <name>" to "through the API", because "by a workspace
   * member" would be a guess and the technician reading the ticket deserves to
   * know which one it was.
   */
  actor?: { apiKeyId: string };
  now?: Date;
}): Promise<DnsChangeRow | null> {
  const change = await prisma.dnsChange.findFirst({
    where: {
      id: input.changeId,
      organizationId: input.organizationId,
      ...(input.domainIdOrSlug
        ? {
            domain: {
              client: { organizationId: input.organizationId },
              ...domainRef(input.domainIdOrSlug),
            },
          }
        : {}),
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
      // The API key is the actor when there is no person. Recorded so the audit
      // trail answers "who acknowledged this" with something a reader can act on
      // — a key can be revoked; "nobody" cannot.
      detail: input.actor ? { apiKeyId: input.actor.apiKeyId } : undefined,
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
        viaApi: input.actor !== undefined,
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
      domain: { select: { id: true, name: true, slug: true } },
    },
  });

  return publicRow(updated);
}
