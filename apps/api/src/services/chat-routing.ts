/**
 * chat-routing.ts — which Slack and Teams channels a message goes to.
 *
 * A workspace can hold up to 20 channels of each. Each is limited, or not, to
 * chosen clients and chosen kinds of message; an empty list means all, which
 * is what the single channel per workspace used to do, so an existing channel
 * keeps receiving everything.
 *
 * A kind is what an MSP routes by, not our internal metric: failing mail,
 * spoofing and new senders, reports going quiet, DNS changes, and domain
 * expiry. Alert rules map onto the first three by their metric.
 */

import { z } from 'zod';
import type { AlertMetric } from '@prisma/client';
import { prisma } from '../database/prisma.js';

export const chatKinds = ['failures', 'spoofing', 'silence', 'dns', 'expiry'] as const;
export type ChatKind = (typeof chatKinds)[number];

/** The most channels of one service a workspace may hold. */
export const maxChatDestinations = 20;

const kindByMetric: Record<AlertMetric, ChatKind> = {
  FAILURE_COUNT: 'failures',
  FAILURE_RATE: 'failures',
  FORENSIC_FAILURES: 'failures',
  SOURCE_IP_VOLUME: 'spoofing',
  NEW_UNAUTHENTICATED_SOURCE: 'spoofing',
  REPORT_SILENCE: 'silence',
};

export function chatKindForMetric(metric: AlertMetric): ChatKind {
  return kindByMetric[metric];
}

export interface ChatRoute {
  clientIds: string[];
  kinds: string[];
}

/**
 * Whether a channel takes a message of this kind about this client. A message
 * with no client (none today) only reaches channels that are not limited to
 * clients: a client-limited channel is an agency's promise that it carries
 * that client and nobody else.
 */
export function routeAllows(route: ChatRoute, kind: ChatKind, clientId: string | null): boolean {
  if (route.kinds.length > 0 && !route.kinds.includes(kind)) return false;
  if (route.clientIds.length > 0 && (!clientId || !route.clientIds.includes(clientId))) return false;
  return true;
}

export const chatScopeSchema = z.object({
  clientIds: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
  kinds: z.array(z.enum(chatKinds)).max(chatKinds.length).optional(),
});

/** The ids, de-duplicated, if every one is a client of this workspace; otherwise the reason. */
export async function checkedChatClientIds(
  organizationId: string,
  ids: string[] | undefined,
): Promise<string[] | undefined | { error: string }> {
  if (ids === undefined) return undefined;
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const found = await prisma.client.count({ where: { organizationId, id: { in: unique } } });
  if (found !== unique.length) return { error: 'One of the chosen clients is not in this workspace.' };
  return unique;
}

/** "Alerts about every client", or "DNS changes and expiry about Pellowyn Dental and 2 more clients". */
export async function routeSentence(organizationId: string, route: { clientIds: string[]; kinds: string[] }): Promise<string> {
  const names: Record<string, string> = {
    failures: 'failing mail',
    spoofing: 'spoofing and new senders',
    silence: 'reports going quiet',
    dns: 'DNS changes',
    expiry: 'domain expiry',
  };
  const kinds = route.kinds.length ? route.kinds.map((k) => names[k] ?? k) : ['Alerts'];
  const what = kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}` : kinds[0]!;
  const lead = what.charAt(0).toUpperCase() + what.slice(1);
  if (route.clientIds.length === 0) return `${lead} about every client`;
  const clients = await prisma.client.findMany({
    where: { organizationId, id: { in: route.clientIds } },
    select: { name: true },
    orderBy: { name: 'asc' },
  });
  const first = clients[0]?.name ?? 'the chosen clients';
  return clients.length > 1 ? `${lead} about ${first} and ${clients.length - 1} more client${clients.length === 2 ? '' : 's'}` : `${lead} about ${first}`;
}