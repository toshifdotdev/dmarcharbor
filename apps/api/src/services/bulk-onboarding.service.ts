import { domainSlug } from './domain-slug.js';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from './audit.service.js';
import {
  EntitlementError,
  quotaUpgradeSentence,
  quotaUsage,
  resolveEntitlements,
  withWorkspaceLock,
} from './entitlements/entitlement.service.js';

export const bulkLimits = {
  maxClients: 200,
  maxDomains: 500,
} as const;

export interface BulkFailure {
  index: number;
  name: string;
  reason: string;
}

export interface BulkClientResult {
  created: {
    index: number;
    clientId: string;
    name: string;
    slug: string;
    domains: { domainId: string; name: string; verificationHost: string; verificationValue: string }[];
    /**
     * Domains on this row that were not added because another workspace already
     * monitors them. `index` is the domain's position in the row's own `domains`
     * list. Always present, empty when there were none, so a caller can read it
     * without checking for it first.
     */
    domainConflicts: BulkFailure[];
  }[];
  failed: BulkFailure[];
  planBlocked: PlanBlocked[];
}

/**
 * A row the plan would not allow, and which limit stopped it.
 *
 * `quota` travels with the row so a caller can build the full refusal (the
 * counts and the plan to move to) for the limit that was actually hit: a client
 * row can be stopped by the client limit or by the domains it brings.
 */
export interface PlanBlocked extends BulkFailure {
  quota: 'client' | 'activeDomain';
}

/**
 * The words for a domain another workspace holds, shared by both imports so the
 * client import and the domain import say the same thing about the same name.
 * It never says which workspace: that would tell one tenant who another serves.
 */
export const domainHeldElsewhereReason =
  'That domain is already monitored by another workspace. Remove it there first, or ask them to release it.';

/**
 * Raised when a domain import names a client that is not in the workspace.
 *
 * It used to be an `EntitlementError('FEATURE_NOT_IN_PLAN')`, so a mistyped
 * client id answered 402 and read as "upgrade your plan". It is a 404, and it
 * answers exactly as a client that does not exist anywhere, so the id cannot be
 * used to find out what another workspace holds.
 */
export class ClientNotInWorkspaceError extends Error {
  readonly status = 404;
  readonly code = 'NOT_FOUND';

  constructor() {
    super('That client is not in this workspace.');
    this.name = 'ClientNotInWorkspaceError';
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function normaliseDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]?.split(':')[0] ?? '';
  if (!trimmed || !trimmed.includes('.') || /\s/.test(trimmed) || trimmed.length > 253) {
    return null;
  }
  return trimmed;
}

/**
 * Imports many clients at once. Every row is independent: a bad one is
 * reported and skipped rather than failing the batch, because an agency
 * importing a spreadsheet from a client CRM should not lose the other 180
 * clients because one row has a typo.
 */
export async function bulkImportClients(input: {
  organizationId: string;
  actorUserId?: string | null;
  clients: { name: string; slug?: string; domains?: string[] }[];
}): Promise<BulkClientResult> {
  const result: BulkClientResult = { created: [], failed: [], planBlocked: [] };

  if (input.clients.length > bulkLimits.maxClients) {
    throw new EntitlementError('PLAN_LIMIT_REACHED', `A single import accepts up to ${bulkLimits.maxClients} clients.`, {
      limit: bulkLimits.maxClients,
      requested: input.clients.length,
    });
  }

  /**
   * Counted and inserted under the workspace lock, as single creates are.
   *
   * The free slots were read once up front and the rows inserted one by one with
   * nothing held, so two imports sent together each saw the same free slots and
   * together created more clients and domains than the plan includes.
   */
  await withWorkspaceLock(input.organizationId, async (tx) => {
    const entitlements = await resolveEntitlements(input.organizationId, new Date(), tx);
    const used = await quotaUsage(input.organizationId, 'client', entitlements.plan, new Date(), tx);
    const remainingClients = Math.max(0, used.limit - used.used);
    const domainBudget = Math.max(
      0,
      entitlements.maxActiveDomains - (await quotaUsage(input.organizationId, 'activeDomain', entitlements.plan, new Date(), tx)).used,
    );

    let clientSlots = remainingClients;
    let domainSlots = domainBudget;
    const usedSlugs = new Set(
      (await tx.client.findMany({ where: { organizationId: input.organizationId }, select: { slug: true } })).map(
        (client) => client.slug,
      ),
    );
    const usedDomains = new Set(
      (
        await tx.domain.findMany({
          where: { client: { organizationId: input.organizationId } },
          select: { name: true },
        })
      ).map((domain) => domain.name),
    );

    /**
     * Every name in the import that any workspace already holds, in one query.
     *
     * `Domain.name` is unique across the whole table, so a row naming a domain
     * another workspace monitors used to reach `client.create`, hit the unique
     * constraint, and roll back the whole transaction: a 500, and not one client
     * of the import created. The domain import already checked this per row;
     * this is the same check, made before anything is written. A name this
     * workspace holds is in `usedDomains` too and is judged there first.
     */
    const requestedNames = [
      ...new Set(
        input.clients.flatMap((entry) =>
          (entry.domains ?? []).map(normaliseDomain).filter((name): name is string => name !== null),
        ),
      ),
    ];
    const claimedAnywhere = new Set(
      requestedNames.length > 0
        ? (
            await tx.domain.findMany({
              where: { name: { in: requestedNames } },
              select: { name: true },
            })
          ).map((domain) => domain.name)
        : [],
    );

    for (const [index, entry] of input.clients.entries()) {
      const name = (entry.name ?? '').trim();
      if (!name) {
        result.failed.push({ index, name: entry.name, reason: 'A client name is required.' });
        continue;
      }

      if (clientSlots <= 0) {
        result.planBlocked.push({
          index,
          name,
          quota: 'client',
          reason: `${entitlements.label} includes ${used.limit} clients and ${used.used} already exist. ${quotaUpgradeSentence(entitlements.plan, 'client')}`,
        });
        continue;
      }

      const slug = (entry.slug?.trim() || slugify(name)).toLowerCase().slice(0, 48);
      if (!slug) {
        result.failed.push({ index, name, reason: 'A usable slug could not be derived from that name.' });
        continue;
      }

      if (usedSlugs.has(slug)) {
        result.failed.push({ index, name, reason: `A client with the slug "${slug}" already exists.` });
        continue;
      }

      const rawDomains = (entry.domains ?? []).map(normaliseDomain);
      const invalid = rawDomains.findIndex((value) => value === null);
      if (invalid >= 0) {
        result.failed.push({ index, name, reason: `"${entry.domains?.[invalid]}" is not a usable domain name.` });
        continue;
      }

      // Once each: a name listed twice on one row is one domain, and creating it
      // twice would hit the unique constraint and fail the whole import.
      const listed = [...new Set(rawDomains as string[])];
      const duplicates = listed.filter((value) => usedDomains.has(value));
      if (duplicates.length > 0) {
        result.failed.push({ index, name, reason: `Already monitoring ${duplicates.join(', ')}.` });
        continue;
      }

      /**
       * A domain another workspace holds is reported for that domain only.
       *
       * The row itself is fine: the client is new, and its other domains are
       * free. Failing the row would make the caller strip the name and send it
       * again, and failing the request (what the unique constraint did) lost
       * every other row as well. A name already in this workspace still fails
       * the row above, because that usually means the client is being imported
       * a second time.
       */
      const domainConflicts: BulkFailure[] = [];
      for (const domain of listed.filter((value) => claimedAnywhere.has(value))) {
        domainConflicts.push({
          index: rawDomains.indexOf(domain),
          name: domain,
          reason: domainHeldElsewhereReason,
        });
      }
      const wanted = listed.filter((value) => !claimedAnywhere.has(value));

      if (wanted.length > domainSlots) {
        result.planBlocked.push({
          index,
          name,
          quota: 'activeDomain',
          reason: `${entitlements.label} includes ${entitlements.maxActiveDomains} active domains and only ${domainSlots} remain. ${quotaUpgradeSentence(entitlements.plan, 'activeDomain')}`,
        });
        continue;
      }

      const client = await tx.client.create({
        data: {
          organizationId: input.organizationId,
          name,
          slug,
          domains: {
            create: wanted.map((domain) => ({
              name: domain,
              status: 'PENDING' as const,
              slug: domainSlug(domain),
            })),
          },
        },
        include: { domains: true },
      });

      usedSlugs.add(slug);
      clientSlots -= 1;
      domainSlots -= wanted.length;
      for (const domain of wanted) {
        usedDomains.add(domain);
      }

      result.created.push({
        index,
        clientId: client.id,
        name: client.name,
        slug: client.slug,
        domains: client.domains.map((domain) => ({
          domainId: domain.id,
          name: domain.name,
          verificationHost: `_dmarc-harbor-verification.${domain.name}`,
          verificationValue: `dmarc-harbor-verification=${domain.verificationToken}`,
        })),
        domainConflicts,
      });
    }
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'CLIENTS_BULK_IMPORTED',
    targetType: 'workspace',
    targetId: input.organizationId,
    detail: {
      requested: input.clients.length,
      created: result.created.length,
      failed: result.failed.length,
      planBlocked: result.planBlocked.length,
      domains: result.created.reduce((total, entry) => total + entry.domains.length, 0),
      domainConflicts: result.created.reduce((total, entry) => total + entry.domainConflicts.length, 0),
    },
  });

  return result;
}

export interface BulkDomainResult {
  /**
   * `slug` travels with the created row so a caller can build the URL it wants
   * the operator to land on. Without it the only identifier available after a
   * bulk add is the cuid, and the app URL would carry a database key — which is
   * the thing `Domain.slug` exists to stop.
   */
  created: { index: number; domainId: string; slug: string; name: string; clientId: string; verificationHost: string; verificationValue: string }[];
  failed: BulkFailure[];
  planBlocked: PlanBlocked[];
}

/**
 * Adds domains to an existing client, which is the second half of onboarding.
 * Agencies usually receive the client list and the domain list at different
 * times, so the two are deliberately separate operations.
 */
export async function bulkImportDomains(input: {
  organizationId: string;
  actorUserId?: string | null;
  clientId: string;
  domains: string[];
}): Promise<BulkDomainResult> {
  const result: BulkDomainResult = { created: [], failed: [], planBlocked: [] };

  if (input.domains.length > bulkLimits.maxDomains) {
    throw new EntitlementError('PLAN_LIMIT_REACHED', `A single import accepts up to ${bulkLimits.maxDomains} domains.`, {
      limit: bulkLimits.maxDomains,
      requested: input.domains.length,
    });
  }

  const client = await prisma.client.findFirst({
    where: { id: input.clientId, organizationId: input.organizationId },
    select: { id: true },
  });

  if (!client) {
    throw new ClientNotInWorkspaceError();
  }

  // Counted and inserted under the workspace lock; see bulkImportClients.
  await withWorkspaceLock(input.organizationId, async (tx) => {
    const entitlements = await resolveEntitlements(input.organizationId, new Date(), tx);
    const usage = await quotaUsage(input.organizationId, 'activeDomain', entitlements.plan, new Date(), tx);
    let slots = Math.max(0, usage.limit - usage.used);

    /**
     * Lowercased for the same reason single adds are: a DNS name is case insensitive
     * and the global uniqueness constraint is plain, so one canonical stored form is
     * what makes the constraint mean what routing assumed it meant.
     */
    const candidates = input.domains.map(normaliseDomain);
    const wanted = [...new Set(candidates.filter((name): name is string => Boolean(name)).map((n) => n.toLowerCase()))];

    /**
     * One indexed query for the whole import rather than one per row.
     *
     * This is the path where a collision actually happens in volume: an agency's own
     * domain list routinely overlaps another agency's, and an import of several
     * hundred rows would otherwise be several hundred round trips.
     *
     * Held globally, because `Domain.name` is unique across the whole table, not per
     * client. Before that constraint, a single name in a customer's CSV could land a
     * second row against another workspace's verified domain and stop *both* of them
     * receiving reports for it, with nothing on either dashboard.
     */
    const claimed = new Map<string, string>();
    if (wanted.length > 0) {
      const held = await tx.domain.findMany({
        where: { name: { in: wanted } },
        select: { name: true, clientId: true },
      });
      for (const row of held) {
        claimed.set(row.name, row.clientId);
      }
    }

    const existing = new Set(
      (
        await tx.domain.findMany({
          where: { client: { organizationId: input.organizationId } },
          select: { name: true },
        })
      ).map((domain) => domain.name),
    );

    for (const [index, raw] of input.domains.entries()) {
      const name = candidates[index]?.toLowerCase();

      if (!name) {
        result.failed.push({ index, name: raw, reason: 'That is not a usable domain name.' });
        continue;
      }

      if (existing.has(name)) {
        result.failed.push({ index, name, reason: 'That domain is already in this workspace.' });
        continue;
      }

      const owner = claimed.get(name);
      if (owner !== undefined && owner !== client.id) {
        result.failed.push({ index, name, reason: domainHeldElsewhereReason });
        continue;
      }

      if (slots <= 0) {
        result.planBlocked.push({
          index,
          name,
          quota: 'activeDomain',
          reason: `${entitlements.label} includes ${usage.limit} active domains and ${usage.used} already exist. ${quotaUpgradeSentence(entitlements.plan, 'activeDomain')}`,
        });
        continue;
      }

      const domain = await tx.domain.create({
        data: { clientId: client.id, name, status: 'PENDING', slug: domainSlug(name) },
        select: { id: true, name: true, verificationToken: true, slug: true },
      });

      existing.add(name);
      claimed.set(name, client.id);
      slots -= 1;

      result.created.push({
        index,
        domainId: domain.id,
        slug: domain.slug,
        name: domain.name,
        clientId: client.id,
        verificationHost: `_dmarc-harbor-verification.${domain.name}`,
        verificationValue: `dmarc-harbor-verification=${domain.verificationToken}`,
      });
    }
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'DOMAINS_BULK_IMPORTED',
    targetType: 'client',
    targetId: client.id,
    detail: {
      requested: input.domains.length,
      created: result.created.length,
      failed: result.failed.length,
      planBlocked: result.planBlocked.length,
    },
  });

  return result;
}
