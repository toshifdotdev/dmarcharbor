import { prisma } from '../database/prisma.js';
import { toCsv } from '../utils/csv.js';
import { acknowledgeAlertEvent } from './alert.service.js';
import { recordAuditEvent } from './audit.service.js';
import { clientAggregateAddress } from './report-address.service.js';

/**
 * operations.service.ts — the everyday operations an MSP runs on what it
 * already has: rename a client, rename the workspace, hand over the client book
 * as a spreadsheet, and act on many alerts or share links at once.
 *
 * Each write records an audit row, using the same action the single-item route
 * records, so the trail reads the same whichever way the work was done. Bulk
 * writes record one row per item, with `bulk: true` in the detail, because "who
 * acknowledged this alert" is asked about one alert, not about a batch.
 */

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

// ─── clients ─────────────────────────────────────────────────────────────────

export type RenameClientOutcome =
  | { ok: true; changed: boolean; client: { id: string; name: string; slug: string } }
  | { ok: false; reason: 'not_found' | 'slug_taken' };

/**
 * Renames a client, changes its slug, or both.
 *
 * Nothing else changes: the client id, its report address (built from its
 * report token, not its slug), its Trust Center address (a random slug of its
 * own) and its domains stay as they are. The one thing a slug change can break
 * is an integration that looks the client up by slug, which is why the audit
 * row keeps the old one.
 */
export async function renameClient(input: {
  organizationId: string;
  clientId: string;
  name?: string;
  slug?: string;
  actorUserId?: string | null;
  requestId?: string;
}): Promise<RenameClientOutcome> {
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, organizationId: input.organizationId },
    select: { id: true, name: true, slug: true },
  });
  if (!client) {
    return { ok: false, reason: 'not_found' };
  }

  const name = input.name ?? client.name;
  const slug = input.slug ?? client.slug;
  if (name === client.name && slug === client.slug) {
    return { ok: true, changed: false, client };
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.client.update({
        where: { id: client.id },
        data: { name, slug },
        select: { id: true, name: true, slug: true },
      });
      await recordAuditEvent(
        {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId ?? undefined,
          action: 'CLIENT_UPDATED',
          targetType: 'client',
          targetId: client.id,
          detail: { from: { name: client.name, slug: client.slug }, to: { name, slug } },
          requestId: input.requestId,
        },
        tx,
      );
      return row;
    });
    return { ok: true, changed: true, client: updated };
  } catch (error) {
    if (isUniqueConstraint(error)) {
      return { ok: false, reason: 'slug_taken' };
    }
    throw error;
  }
}

export const clientBookCsvHeader = [
  'client',
  'client_slug',
  'client_id',
  'report_address',
  'domain',
  'domain_id',
  'ownership',
  'dmarc_policy',
  'score',
  'verified_at',
  'last_scan_at',
  'domain_added_at',
] as const;

const ownershipWords: Record<string, string> = {
  VERIFIED: 'verified',
  PENDING: 'awaiting ownership record',
  FAILED: 'ownership record gone',
};

/**
 * The client book as CSV: one row per domain, and one row for a client with no
 * domains, so the file is the whole book and an empty client is not lost.
 *
 * Written for the two places an MSP takes it: a PSA or CRM import, which wants
 * stable ids, and a spreadsheet handed to a client, which wants words. Cells go
 * through `toCsv`, which defuses anything a spreadsheet would run as a formula,
 * because client names are typed by people.
 */
export async function clientBookCsv(organizationId: string): Promise<{ csv: string; clients: number; domains: number }> {
  const clients = await prisma.client.findMany({
    where: { organizationId },
    select: {
      id: true,
      name: true,
      slug: true,
      reportToken: true,
      domains: {
        select: {
          id: true,
          name: true,
          status: true,
          dmarcPolicy: true,
          score: true,
          verifiedAt: true,
          lastScanAt: true,
          createdAt: true,
        },
        orderBy: { name: 'asc' },
      },
    },
    orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
  });

  const rows: unknown[][] = [];
  let domains = 0;
  for (const client of clients) {
    const address = clientAggregateAddress(client.reportToken);
    if (client.domains.length === 0) {
      rows.push([client.name, client.slug, client.id, address, '', '', '', '', '', '', '', '']);
      continue;
    }
    for (const domain of client.domains) {
      domains += 1;
      rows.push([
        client.name,
        client.slug,
        client.id,
        address,
        domain.name,
        domain.id,
        ownershipWords[domain.status] ?? domain.status.toLowerCase(),
        domain.dmarcPolicy ?? '',
        domain.score ?? '',
        domain.verifiedAt,
        domain.lastScanAt,
        domain.createdAt,
      ]);
    }
  }

  return { csv: toCsv(clientBookCsvHeader, rows), clients: clients.length, domains };
}

export function clientBookFilename(workspaceSlug: string, now = new Date()): string {
  const slug =
    workspaceSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'workspace';
  // No product name in the file name: on a white-labelled workspace the agency
  // hands this file to its own clients.
  return `client-book-${slug}-${now.toISOString().slice(0, 10)}.csv`;
}

// ─── workspace ───────────────────────────────────────────────────────────────

export type RenameWorkspaceOutcome =
  | { ok: true; changed: boolean; workspace: { id: string; name: string; slug: string } }
  | { ok: false; reason: 'not_found' };

/**
 * Renames the workspace. The slug stays: it is what the delete confirmation asks
 * for and what support looks a workspace up by, and changing it is not something
 * an agency needs when it renames itself.
 */
export async function renameWorkspace(input: {
  organizationId: string;
  name: string;
  actorUserId?: string | null;
  requestId?: string;
}): Promise<RenameWorkspaceOutcome> {
  const workspace = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { id: true, name: true, slug: true },
  });
  if (!workspace) {
    return { ok: false, reason: 'not_found' };
  }
  if (workspace.name === input.name) {
    return { ok: true, changed: false, workspace };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.organization.update({
      where: { id: workspace.id },
      data: { name: input.name },
      select: { id: true, name: true, slug: true },
    });
    await recordAuditEvent(
      {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId ?? undefined,
        action: 'WORKSPACE_UPDATED',
        targetType: 'workspace',
        targetId: workspace.id,
        detail: { from: { name: workspace.name }, to: { name: input.name } },
        requestId: input.requestId,
      },
      tx,
    );
    return row;
  });

  return { ok: true, changed: true, workspace: updated };
}

// ─── bulk: alerts ────────────────────────────────────────────────────────────

export const bulkLimit = 100;

export interface BulkSkip {
  id: string;
  reason: 'not_found' | 'already_handled' | 'already_revoked';
}

export interface BulkOutcome {
  /** Ids that were changed by this call. */
  done: string[];
  /** Ids that were not, each with why. */
  skipped: BulkSkip[];
}

/**
 * Acknowledges many alert events. Each one goes through the same service call
 * as the single acknowledge, so the PSA ticket note is queued per alert exactly
 * as it would be one at a time. Sequential on purpose: at most a hundred, and
 * each queues a PSA job that must not race its own siblings.
 */
export async function acknowledgeAlertsInBulk(input: {
  organizationId: string;
  eventIds: string[];
  actorUserId?: string;
  requestId?: string;
}): Promise<BulkOutcome> {
  const ids = [...new Set(input.eventIds)];
  const done: string[] = [];
  const skipped: BulkSkip[] = [];

  for (const id of ids) {
    const outcome = await acknowledgeAlertEvent(input.organizationId, id, input.actorUserId);
    if (outcome !== 'acknowledged') {
      skipped.push({ id, reason: outcome });
      continue;
    }
    // Written per alert, straight after it changed, so a failure part way
    // through never leaves an acknowledged alert without its audit row.
    await recordAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'ALERT_ACKNOWLEDGED',
      targetType: 'alert_event',
      targetId: id,
      detail: { bulk: true },
      requestId: input.requestId,
    });
    done.push(id);
  }

  return { done, skipped };
}

// ─── bulk: share links ───────────────────────────────────────────────────────

/**
 * Revokes many share links. A revoked link stops working on the next open and
 * its row stays, so the list still shows what was sent; removing the rows is
 * the separate "remove revoked" action. Expired links are revoked too: an
 * expired link already fails, and revoking it makes that permanent and visible.
 */
export async function revokeReportSharesInBulk(input: {
  organizationId: string;
  shareIds: string[];
  actorUserId?: string;
  requestId?: string;
  now?: Date;
}): Promise<BulkOutcome> {
  const ids = [...new Set(input.shareIds)];
  const now = input.now ?? new Date();

  const rows = await prisma.reportShare.findMany({
    where: { id: { in: ids }, organizationId: input.organizationId },
    select: { id: true, revokedAt: true, domainId: true, domain: { select: { name: true } } },
  });
  const found = new Map(rows.map((row) => [row.id, row]));
  const live = rows.filter((row) => row.revokedAt === null).map((row) => row.id);

  const skipped: BulkSkip[] = [];
  for (const id of ids) {
    const row = found.get(id);
    if (!row) skipped.push({ id, reason: 'not_found' });
    else if (row.revokedAt !== null) skipped.push({ id, reason: 'already_revoked' });
  }

  // One conditional update per link, so a link revoked by someone else in the
  // meantime is reported as already revoked rather than revoked and audited twice.
  const done: string[] = [];
  for (const id of live) {
    const result = await prisma.reportShare.updateMany({
      where: { id, organizationId: input.organizationId, revokedAt: null },
      data: { revokedAt: now },
    });
    if (result.count === 0) {
      skipped.push({ id, reason: 'already_revoked' });
      continue;
    }
    await recordAuditEvent({
      organizationId: input.organizationId,
      domainId: found.get(id)?.domainId,
      actorUserId: input.actorUserId,
      action: 'REPORT_SHARE_REVOKED',
      targetType: 'report_share',
      targetId: id,
      detail: { bulk: true, domainName: found.get(id)?.domain.name ?? null },
      requestId: input.requestId,
    });
    done.push(id);
  }

  return { done, skipped };
}
