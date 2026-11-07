/**
 * zone-import.service.ts — the domains a connected Cloudflare account holds,
 * so an agency can add them as client domains without typing each one.
 *
 * Read only: listing zones changes nothing at Cloudflare or here. Adding the
 * chosen ones goes through the ordinary bulk import (bulkImportDomains), with
 * its plan limit, duplicate and held-elsewhere checks, so an import can never
 * do what adding the same names by hand could not.
 *
 * Each zone is marked by where it already stands: monitored in this workspace
 * (and under which client), monitored by another workspace (which is not
 * named: that would tell one agency another's client list), or free to add.
 */

import { prisma } from '../../database/prisma.js';
import { createCloudflareClient, type CloudflareClient } from './cloudflare.client.js';
import { loadDnsConnectionSecret, markDnsConnectionError, markDnsConnectionSuccess } from './connections.service.js';

/** Twenty pages of fifty: an account with more zones is listed in part, and says so. */
const maxZonePages = 20;

export interface ImportableZone {
  name: string;
  accountName: string | null;
  state: 'available' | 'here' | 'elsewhere';
  /** For a zone already in this workspace: the client it is under. */
  clientName: string | null;
}

export async function listImportableZones(input: {
  organizationId: string;
  connectionId: string;
  client?: CloudflareClient;
}): Promise<{ zones: ImportableZone[]; truncated: boolean }> {
  const secret = await loadDnsConnectionSecret(input);
  const client = input.client ?? createCloudflareClient({ token: secret.token });

  const found: Array<{ name: string; accountName: string | null }> = [];
  let page = 1;
  let totalPages: number;
  try {
    do {
      const result = await client.listZones(page);
      found.push(...result.zones);
      totalPages = result.totalPages;
      page += 1;
    } while (page <= totalPages && page <= maxZonePages);
  } catch (error) {
    await markDnsConnectionError(secret.id, error instanceof Error ? error.message : 'Cloudflare refused the zone list.');
    throw error;
  }
  await markDnsConnectionSuccess({ connectionId: secret.id, accountName: found[0]?.accountName ?? null });

  const names = [...new Set(found.map((zone) => zone.name))];
  const held = names.length
    ? await prisma.domain.findMany({
        where: { name: { in: names } },
        select: { name: true, client: { select: { name: true, organizationId: true } } },
      })
    : [];
  const byName = new Map(held.map((row) => [row.name, row.client]));

  const zones = names
    .map((name): ImportableZone => {
      const owner = byName.get(name);
      const accountName = found.find((zone) => zone.name === name)?.accountName ?? null;
      if (!owner) return { name, accountName, state: 'available', clientName: null };
      return owner.organizationId === input.organizationId
        ? { name, accountName, state: 'here', clientName: owner.name }
        : { name, accountName, state: 'elsewhere', clientName: null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { zones, truncated: totalPages > maxZonePages };
}
