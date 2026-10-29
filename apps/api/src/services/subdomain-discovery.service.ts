import { prisma } from '../database/prisma.js';
import { DomainValidationError, normalizeDomain } from '../scanner/domain.js';
import { recordAuditEvent } from './audit.service.js';
import { domainRef } from './domain-ref.js';

/**
 * Subdomains seen sending mail in a domain's aggregate reports that the
 * workspace does not monitor.
 *
 * Receivers report mail for the policy domain, so a message whose From header
 * is `news.example.com` lands in example.com's reports with that header_from.
 * Grouping the parent's records by header_from finds every name sending as the
 * organisation: a marketing platform on a subdomain nobody listed, a forgotten
 * app server, or a spoofer trying names that look internal. Only names below
 * the parent count; a header_from of another organisation is a different
 * question, answered by the senders table.
 *
 * Read from the reports already stored, so it costs no DNS lookups. Reports
 * whose own policy domain is the subdomain are not stored unless that name is
 * a verified domain, so a subdomain with its own DMARC record shows here only
 * through the parent's reports.
 */

/** How far back discovery looks, by the reports' own period. */
export const subdomainWindowDays = 90;
/** At most this many names, busiest first. */
export const subdomainListLimit = 100;

export class SubdomainError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'SubdomainError';
    this.code = code;
    this.status = status;
  }
}

export interface DiscoveredSubdomain {
  name: string;
  messages: number;
  /** Messages with an aligned DKIM or SPF pass, which is a DMARC pass. */
  dmarcPassMessages: number;
  /** To one decimal place, or null when no messages were counted. */
  dmarcPassPercent: number | null;
  /** Distinct sending IP addresses. */
  sourceCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  dismissed: { at: string; by: { id: string; name: string } | null } | null;
}

export interface SubdomainDiscovery {
  domain: { id: string; name: string };
  windowDays: number;
  subdomains: DiscoveredSubdomain[];
}

async function scopedDomain(organizationId: string, domainIdOrSlug: string): Promise<{ id: string; name: string }> {
  const domain = await prisma.domain.findFirst({
    where: { client: { organizationId }, ...domainRef(domainIdOrSlug) },
    select: { id: true, name: true },
  });
  if (!domain) {
    throw new SubdomainError('That domain is not in this workspace.', 'NOT_FOUND', 404);
  }
  return domain;
}

/** A header_from as stored: any case, maybe a trailing dot or spaces. */
function cleanName(value: string): string | null {
  try {
    return normalizeDomain(value);
  } catch (error) {
    if (error instanceof DomainValidationError) return null;
    throw error;
  }
}

function percent(passed: number, total: number): number | null {
  return total > 0 ? Math.round((passed * 1000) / total) / 10 : null;
}

export async function discoverSubdomains(
  organizationId: string,
  domainIdOrSlug: string,
  now = new Date(),
): Promise<SubdomainDiscovery> {
  const domain = await scopedDomain(organizationId, domainIdOrSlug);
  const suffix = `.${domain.name}`;
  const since = new Date(now.getTime() - subdomainWindowDays * 24 * 60 * 60 * 1000);

  // Grouped in the database: a busy domain has hundreds of thousands of
  // records, and only a handful of distinct header_from values. The suffix is
  // compared with right(), not LIKE, so nothing in a name acts as a wildcard.
  const rows = await prisma.$queryRaw<
    Array<{ name: string; messages: bigint; passed: bigint; sources: bigint; firstSeen: Date | null; lastSeen: Date | null }>
  >`
    SELECT rtrim(btrim(lower(rec."headerFrom")), '.') AS "name",
           SUM(rec."messageCount")::bigint AS "messages",
           SUM(CASE WHEN lower(rec."dkimResult") = 'pass' OR lower(rec."spfResult") = 'pass' THEN rec."messageCount" ELSE 0 END)::bigint AS "passed",
           COUNT(DISTINCT rec."sourceIp")::bigint AS "sources",
           MIN(r."dateRangeBegin") AS "firstSeen",
           MAX(COALESCE(r."dateRangeEnd", r."dateRangeBegin")) AS "lastSeen"
    FROM "dmarc_report_record" rec
    JOIN "dmarc_report" r ON r.id = rec."reportId"
    WHERE r."domainId" = ${domain.id}
      AND r."reportType" = 'AGGREGATE'
      AND r."dateRangeBegin" >= ${since}
      AND rec."headerFrom" IS NOT NULL
      AND right(rtrim(btrim(lower(rec."headerFrom")), '.'), ${suffix.length}::int) = ${suffix}
    GROUP BY 1
    ORDER BY 2 DESC, 1 ASC
    LIMIT ${subdomainListLimit * 2}
  `;

  const [monitored, dismissals] = await Promise.all([
    prisma.domain.findMany({
      where: { client: { organizationId }, name: { endsWith: suffix } },
      select: { name: true },
    }),
    prisma.subdomainDismissal.findMany({
      where: { organizationId, domainId: domain.id },
      select: { name: true, createdAt: true, dismissedBy: { select: { id: true, name: true } } },
    }),
  ]);
  const inInventory = new Set(monitored.map((row) => row.name));
  const dismissedBy = new Map(dismissals.map((row) => [row.name, row]));

  // Two stored spellings of one name (a trailing dot, an IDN in Unicode) are
  // one subdomain, so the rows are folded after normalising.
  const folded = new Map<string, { messages: number; passed: number; sources: number; firstSeen: Date | null; lastSeen: Date | null }>();
  for (const row of rows) {
    const name = cleanName(row.name);
    if (!name || !name.endsWith(suffix) || inInventory.has(name)) continue;
    const entry = folded.get(name);
    if (!entry) {
      folded.set(name, {
        messages: Number(row.messages),
        passed: Number(row.passed),
        sources: Number(row.sources),
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
      });
      continue;
    }
    entry.messages += Number(row.messages);
    entry.passed += Number(row.passed);
    // An upper bound when spellings are folded; exact in the usual case of one.
    entry.sources += Number(row.sources);
    if (row.firstSeen && (!entry.firstSeen || row.firstSeen < entry.firstSeen)) entry.firstSeen = row.firstSeen;
    if (row.lastSeen && (!entry.lastSeen || row.lastSeen > entry.lastSeen)) entry.lastSeen = row.lastSeen;
  }

  const subdomains = [...folded.entries()]
    .map(([name, entry]): DiscoveredSubdomain => {
      const dismissal = dismissedBy.get(name);
      return {
        name,
        messages: entry.messages,
        dmarcPassMessages: entry.passed,
        dmarcPassPercent: percent(entry.passed, entry.messages),
        sourceCount: entry.sources,
        firstSeenAt: entry.firstSeen?.toISOString() ?? null,
        lastSeenAt: entry.lastSeen?.toISOString() ?? null,
        dismissed: dismissal ? { at: dismissal.createdAt.toISOString(), by: dismissal.dismissedBy } : null,
      };
    })
    .sort((left, right) => right.messages - left.messages || left.name.localeCompare(right.name))
    .slice(0, subdomainListLimit);

  return { domain, windowDays: subdomainWindowDays, subdomains };
}

/**
 * Hides a discovered subdomain, or lists it again.
 *
 * The name must sit below the domain and must have appeared in its reports,
 * the same rule a sender review follows, so the table only ever holds
 * decisions about mail that was actually seen. Both directions are idempotent
 * and audited only when something changed.
 */
export async function setSubdomainDismissed(input: {
  organizationId: string;
  domainId: string;
  name: string;
  dismissed: boolean;
  actorUserId?: string | null;
}): Promise<{ name: string; dismissed: boolean }> {
  const domain = await scopedDomain(input.organizationId, input.domainId);
  const name = cleanName(input.name);
  if (!name || !name.endsWith(`.${domain.name}`)) {
    throw new SubdomainError(`Give a subdomain of ${domain.name}, such as mail.${domain.name}.`, 'INVALID_REQUEST', 400);
  }

  const seen = await prisma.$queryRaw<Array<{ found: number }>>`
    SELECT 1 AS "found"
    FROM "dmarc_report_record" rec
    JOIN "dmarc_report" r ON r.id = rec."reportId"
    WHERE r."domainId" = ${domain.id}
      AND rtrim(btrim(lower(rec."headerFrom")), '.') = ${name}
    LIMIT 1
  `;
  if (seen.length === 0) {
    throw new SubdomainError('That subdomain has not appeared in this domain reports.', 'SUBDOMAIN_NOT_FOUND', 404);
  }

  const key = { domainId_name: { domainId: domain.id, name } };
  const existing = await prisma.subdomainDismissal.findUnique({ where: key, select: { id: true } });

  if (input.dismissed && !existing) {
    try {
      await prisma.subdomainDismissal.create({
        data: {
          organizationId: input.organizationId,
          domainId: domain.id,
          name,
          dismissedById: input.actorUserId ?? null,
        },
      });
    } catch (error) {
      // A concurrent dismissal of the same name already wrote the row.
      if ((error as { code?: string }).code === 'P2002') return { name, dismissed: true };
      throw error;
    }
    await recordAuditEvent({
      organizationId: input.organizationId,
      domainId: domain.id,
      actorUserId: input.actorUserId ?? undefined,
      action: 'SUBDOMAIN_DISMISSED',
      targetType: 'subdomain',
      targetId: name,
      detail: { name, parent: domain.name },
    });
  }

  if (!input.dismissed && existing) {
    const removed = await prisma.subdomainDismissal.deleteMany({ where: { id: existing.id } });
    if (removed.count > 0) {
      await recordAuditEvent({
        organizationId: input.organizationId,
        domainId: domain.id,
        actorUserId: input.actorUserId ?? undefined,
        action: 'SUBDOMAIN_RESTORED',
        targetType: 'subdomain',
        targetId: name,
        detail: { name, parent: domain.name },
      });
    }
  }

  return { name, dismissed: input.dismissed };
}
