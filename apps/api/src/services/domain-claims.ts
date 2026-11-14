import type { Prisma } from '@prisma/client';

/**
 * How long a claim on a domain name that was never verified holds the name
 * against every other workspace.
 */
export const unprovenClaimDays = 14;

/**
 * Releases claims on these names that another workspace added and never proved.
 *
 * A domain name is unique across all workspaces, so a workspace that added a
 * name and never verified it held that name for ever. Anyone on the free plan
 * could add a rival agency's client domains (or google.com) and the real owner,
 * or the agency they hired, was refused with no way to prove ownership and take
 * it. A claim that was never verified now gives the name up after two weeks to
 * the next workspace that adds it.
 *
 * Only a row that cannot hold anything is released: PENDING (a domain that was
 * verified and then lapsed is FAILED, and keeps its history), never verified,
 * and with no report of any kind (reports are only accepted for a verified
 * domain). Every relation to a domain cascades, so nothing is left dangling.
 * The workspace that loses the claim has it in its audit trail.
 */
export async function releaseUnprovenClaims(
  tx: Prisma.TransactionClient,
  organizationId: string,
  names: string[],
  now = new Date(),
): Promise<string[]> {
  if (names.length === 0) {
    return [];
  }
  const cutoff = new Date(now.getTime() - unprovenClaimDays * 24 * 60 * 60 * 1000);
  const stale = await tx.domain.findMany({
    where: {
      name: { in: names },
      status: 'PENDING',
      verifiedAt: null,
      createdAt: { lt: cutoff },
      client: { organizationId: { not: organizationId } },
      dmarcReports: { none: {} },
      forensicReports: { none: {} },
      tlsReports: { none: {} },
    },
    select: { id: true, name: true, client: { select: { organizationId: true } } },
  });
  if (stale.length === 0) {
    return [];
  }

  await tx.domain.deleteMany({ where: { id: { in: stale.map((row) => row.id) }, status: 'PENDING', verifiedAt: null } });
  await tx.auditLog.createMany({
    data: stale.map((row) => ({
      organizationId: row.client.organizationId,
      action: 'DOMAIN_DELETED' as const,
      targetType: 'domain',
      targetId: row.id,
      detail: {
        name: row.name,
        reason: `Never verified, so the name was released after ${unprovenClaimDays} days to another workspace that added it.`,
      },
    })),
  });
  return stale.map((row) => row.name);
}
