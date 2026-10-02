import { domainSlug } from './domain-slug.js';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from './audit.service.js';
import { EntitlementError, quotaUsage, resolveEntitlements } from './entitlements/entitlement.service.js';

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
  created: { index: number; clientId: string; name: string; slug: string; domains: { domainId: string; name: string; verificationHost: string; verificationValue: string }[] }[];
  failed: BulkFailure[];
  planBlocked: { index: number; name: string; reason: string }[];
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

  const used = await quotaUsage(input.organizationId, 'client', (await resolveEntitlements(input.organizationId)).plan);
  const remainingClients = Math.max(0, used.limit - used.used);
  const entitlements = await resolveEntitlements(input.organizationId);
  const domainBudget = Math.max(0, entitlements.maxActiveDomains - (await quotaUsage(input.organizationId, 'activeDomain', entitlements.plan)).used);

  let clientSlots = remainingClients;
  let domainSlots = domainBudget;
  const usedSlugs = new Set(
    (await prisma.client.findMany({ where: { organizationId: input.organizationId }, select: { slug: true } })).map(
      (client) => client.slug,
    ),
  );
  const usedDomains = new Set(
    (
      await prisma.domain.findMany({
        where: { client: { organizationId: input.organizationId } },
        select: { name: true },
      })
    ).map((domain) => domain.name),
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
        reason: `${entitlements.label} includes ${used.limit} clients and ${used.used} already exist.`,
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

    const wanted = rawDomains as string[];
    const duplicates = wanted.filter((value) => usedDomains.has(value));
    if (duplicates.length > 0) {
      result.failed.push({ index, name, reason: `Already monitoring ${duplicates.join(', ')}.` });
      continue;
    }

    if (wanted.length > domainSlots) {
      result.planBlocked.push({
        index,
        name,
        reason: `${entitlements.label} includes ${entitlements.maxActiveDomains} active domains and only ${domainSlots} remain.`,
      });
      continue;
    }

    const client = await prisma.client.create({
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
    });
  }

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
    },
  });

  return result;
}

export interface BulkDomainResult {
  created: { index: number; domainId: string; name: string; clientId: string; verificationHost: string; verificationValue: string }[];
  failed: BulkFailure[];
  planBlocked: BulkFailure[];
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
    throw new EntitlementError('FEATURE_NOT_IN_PLAN', 'That client is not in this workspace.', {});
  }

  const entitlements = await resolveEntitlements(input.organizationId);
  const usage = await quotaUsage(input.organizationId, 'activeDomain', entitlements.plan);
  let slots = Math.max(0, usage.limit - usage.used);

  const existing = new Set(
    (
      await prisma.domain.findMany({
        where: { client: { organizationId: input.organizationId } },
        select: { name: true },
      })
    ).map((domain) => domain.name),
  );

  for (const [index, raw] of input.domains.entries()) {
    const name = normaliseDomain(raw);

    if (!name) {
      result.failed.push({ index, name: raw, reason: 'That is not a usable domain name.' });
      continue;
    }

    if (existing.has(name)) {
      result.failed.push({ index, name, reason: 'That domain is already in this workspace.' });
      continue;
    }

    if (slots <= 0) {
      result.planBlocked.push({
        index,
        name,
        reason: `${entitlements.label} includes ${usage.limit} active domains and ${usage.used} already exist.`,
      });
      continue;
    }

    const domain = await prisma.domain.create({
      data: { clientId: client.id, name, status: 'PENDING', slug: domainSlug(name) },
      select: { id: true, name: true, verificationToken: true, slug: true },
    });

    existing.add(name);
    slots -= 1;

    result.created.push({
      index,
      domainId: domain.id,
      name: domain.name,
      clientId: client.id,
      verificationHost: `_dmarc-harbor-verification.${domain.name}`,
      verificationValue: `dmarc-harbor-verification=${domain.verificationToken}`,
    });
  }

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
