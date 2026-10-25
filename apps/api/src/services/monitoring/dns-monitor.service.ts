import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { systemDnsReader } from '../../scanner/dns.js';
import type { DnsReader } from '../../scanner/types.js';
import { runDomainScan } from '../domain-scan.service.js';
import { deliverDnsChangeNotifications } from './dns-change-notify.service.js';

export interface DnsMonitorPassOutcome {
  claimed: number;
  completed: number;
  failed: number;
  changes: number;
  skipped: number;
}

const passDeadlineMs = 5 * 60 * 1000;

/**
 * One monitoring pass: claim domains that are due, rescan them with bounded
 * concurrency, then deliver the change notifications for everything recorded.
 *
 * The claim is a conditional write computed from the clock in the predicate,
 * not from a value carried out of the read. Two replicas that both listed the
 * same domain therefore cannot both claim it, and an instance that dies costs
 * one interval rather than stranding the domain.
 */
export async function runDnsMonitorPass(
  now = new Date(),
  reader: DnsReader = systemDnsReader,
): Promise<DnsMonitorPassOutcome> {
  const claimBefore = new Date(now.getTime() - env.DNS_MONITOR_INTERVAL_MINUTES * 60 * 1000);

  const due = await prisma.domain.findMany({
    where: {
      status: 'VERIFIED',
      OR: [{ monitorClaimedAt: null }, { monitorClaimedAt: { lte: claimBefore } }],
    },
    select: {
      id: true,
      name: true,
      monitorClaimedAt: true,
      client: { select: { organizationId: true } },
    },
    orderBy: [{ monitorClaimedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    take: env.DNS_MONITOR_BATCH_SIZE,
  });

  const outcome: DnsMonitorPassOutcome = {
    claimed: 0,
    completed: 0,
    failed: 0,
    changes: 0,
    skipped: 0,
  };

  const claimed: typeof due = [];
  for (const domain of due) {
    const claim = await prisma.domain.updateMany({
      where: {
        id: domain.id,
        OR: [{ monitorClaimedAt: null }, { monitorClaimedAt: { lte: claimBefore } }],
      },
      data: { monitorClaimedAt: now },
    });

    if (claim.count !== 1) {
      outcome.skipped += 1;
      continue;
    }

    outcome.claimed += 1;
    claimed.push(domain);
  }

  const deadline = Date.now() + passDeadlineMs;
  let next = 0;

  const release = async (domain: (typeof claimed)[number]): Promise<void> => {
    await prisma.domain
      .updateMany({
        where: { id: domain.id, monitorClaimedAt: now },
        data: { monitorClaimedAt: domain.monitorClaimedAt },
      })
      .catch(() => undefined);
  };

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      const domain = claimed[index];
      if (!domain) {
        return;
      }

      if (Date.now() >= deadline) {
        // Not started. Release the claim so the next tick can take it.
        await release(domain);
        outcome.skipped += 1;
        continue;
      }

      try {
        const result = await runDomainScan({
          organizationId: domain.client.organizationId,
          domainId: domain.id,
          requestedById: null,
          trigger: 'SCHEDULED',
          reader,
        });

        if (result.status === 'completed') {
          outcome.completed += 1;
          outcome.changes += result.changes;
        } else if (result.status === 'failed') {
          outcome.failed += 1;
        } else {
          await release(domain);
          outcome.skipped += 1;
        }
      } catch (error) {
        // A single domain must never stop the batch.
        console.error(
          `[dns-monitor] ${domain.name} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        outcome.failed += 1;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(env.DNS_MONITOR_CONCURRENCY, claimed.length) }, () => worker()),
  );

  try {
    await deliverDnsChangeNotifications(now);
  } catch (error) {
    console.error(
      `[dns-monitor] change notifications failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  return outcome;
}
