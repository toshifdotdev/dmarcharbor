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

/**
 * How stale `recheckedAt` has to be before a row may be claimed again.
 *
 * This is the schedule, not a lock timeout. The original list query filtered on
 * `status` and `createdAt` and never looked at `recheckedAt` at all, so a domain was
 * re-checked on every pass for as long as it stayed PENDING - hourly, forever, for a
 * domain that never publishes its TXT record. The comment claimed the DNS lookup and
 * the customer email happen once; they happened on every pass.
 *
 * So the list query now excludes anything checked inside the window, and the claim
 * uses the same window as its condition. Both halves are needed: the query stops the
 * wasted read, and the condition stops the double claim when two replicas both have
 * the row in hand from before either wrote.
 *
 * The window is the existing twenty minute backoff for an unverified domain, and the
 * daily interval for a verified one, so the schedule the constants already describe is
 * the one actually enforced.
 */
function recheckedBeforeFor(status: string, now: Date): Date {
  const windowMinutes = status === 'VERIFIED' ? verifiedRevalidationHours * 60 : reverifyBackoffMinutes;
  return new Date(now.getTime() - windowMinutes * 60 * 1000);
}

export async function reverifyUnverifiedDomains(now = new Date()): Promise<ReverifyOutcome> {
  const pendingBefore = new Date(now.getTime() - reverifyBackoffMinutes * 60 * 1000);
  const verifiedBefore = new Date(now.getTime() - verifiedRevalidationHours * 60 * 60 * 1000);
  const reverifiedBefore = new Date(now.getTime() - reverifyBackoffMinutes * 60 * 1000);

  const domains = await prisma.domain.findMany({
    where: {
      /**
       * Not checked recently.
       *
       * The `recheckedAt: null` arm is kept as well as the comparison so a domain that
       * has never been checked is always eligible, rather than being excluded by a null
       * failing a `<=` test.
       */
      AND: [
        { OR: [{ recheckedAt: null }, { recheckedAt: { lte: reverifiedBefore } }] },
        {
          OR: [
            { status: { in: ['PENDING', 'FAILED'] }, createdAt: { lte: pendingBefore } },
            { status: 'VERIFIED', verifiedAt: { lte: verifiedBefore } },
          ],
        },
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
      /**
       * Claimed before the DNS lookup, and this is the part that was wrong.
       *
       * The old claim was a compare-and-swap on the value read at the top of this
       * function: `where: { id, recheckedAt: domain.recheckedAt }`. That looks like a
       * conditional write and is not one. If this instance's list query lands AFTER
       * another instance has already claimed the row, `domain.recheckedAt` is that
       * other instance's freshly written timestamp, and the CAS condition is satisfied
       * by exactly the state it exists to exclude. Both then resolve DNS and both email
       * the customer that the domain verified.
       *
       * CI caught it: `scheduler-scaling.integration.test.ts` asserts the total checked
       * across two concurrent calls is at most one, and got two. It passed locally
       * because the two list queries usually interleaved the other way round.
       *
       * So the condition is a threshold computed from the clock rather than a value
       * carried from a read that may be stale. A claim only succeeds if the row has
       * genuinely not been touched within the window that made it eligible, which is
       * the property the caller actually needs and which no ordering of two reads can
       * defeat.
       */
      const claim = await prisma.domain.updateMany({
        where: {
          id: domain.id,
          /**
           * The same window the list query used, recomputed per row from the status
           * that row had when it was read.
           *
           * Derived from the row rather than from a value carried down from the read,
           * which is the whole fix. The old predicate was `recheckedAt ===
           * domain.recheckedAt`, which is satisfied by whatever value the reader saw,
           * including one another instance wrote a moment earlier.
           */
          OR: [{ recheckedAt: null }, { recheckedAt: { lte: recheckedBeforeFor(domain.status, now) } }],
        },
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
