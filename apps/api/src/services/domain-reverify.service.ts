import { prisma } from '../database/prisma.js';
import { applyOwnershipResult, checkDomainOwnership } from './client.service.js';

export const reverifyIntervalMinutes = 60;
export const reverifyBatchSize = 50;

/**
 * How long a verified domain goes between re-checks.
 *
 * Hourly for a domain still waiting, because DNS propagates in minutes and the
 * customer is waiting. Daily once verified, because detecting that someone
 * deleted the proof record matters but is not urgent, and re-querying every
 * verified domain hourly would be pointless load on the resolvers.
 */
export const reverifyBackoffMinutes = 20;
export const verifiedRevalidationHours = 24;

/**
 * How long to leave a domain alone after a failed check.
 *
 * DNS propagation is minutes, not hours, so a shorter wait would just hammer
 * every resolver. Twenty minutes avoids re-querying a record that cannot
 * possibly have appeared yet, while still picking up a record published the
 * previous evening before the next working morning.
 */
export interface ReverifyOutcome {
  checked: number;
  verified: number;
  failed: number;
  stillPending: number;
}

export async function reverifyUnverifiedDomains(now = new Date()): Promise<ReverifyOutcome> {
  const pendingBefore = new Date(now.getTime() - reverifyBackoffMinutes * 60 * 1000);
  const verifiedBefore = new Date(now.getTime() - verifiedRevalidationHours * 60 * 60 * 1000);

  const domains = await prisma.domain.findMany({
    where: {
      OR: [
        { status: { in: ['PENDING', 'FAILED'] }, createdAt: { lte: pendingBefore } },
        { status: 'VERIFIED', verifiedAt: { lte: verifiedBefore } },
      ],
    },
    select: {
      id: true,
      name: true,
      clientId: true,
      status: true,
      verificationToken: true,
      verifiedAt: true,
      recheckedAt: true,
      client: { select: { organizationId: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: reverifyBatchSize,
  });

  const outcome: ReverifyOutcome = { checked: 0, verified: 0, failed: 0, stillPending: 0 };

  for (const domain of domains) {
    try {
      // Claimed before the DNS lookup, keyed on the value that was read. Two
      // instances reaching the same row both see PENDING, both resolve the
      // record, and both would email the customer that the domain verified, so
      // the lookup is not just duplicated work, it is duplicated contact.
      const claim = await prisma.domain.updateMany({
        where: { id: domain.id, recheckedAt: domain.recheckedAt },
        data: { recheckedAt: now },
      });

      if (claim.count !== 1) {
        continue;
      }

      const check = await checkDomainOwnership(domain);
      const status = await applyOwnershipResult(domain.client.organizationId, domain, check, now);

      outcome.checked += 1;
      if (status === 'VERIFIED') {
        outcome.verified += 1;
      } else if (status === 'FAILED') {
        outcome.failed += 1;
      } else {
        outcome.stillPending += 1;
      }
    } catch {
      outcome.checked += 1;
      outcome.stillPending += 1;
    }
  }

  return outcome;
}
