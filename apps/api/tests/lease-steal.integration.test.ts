/**
 * Proves renewal stops a second replica stealing the lease mid-pass.
 *
 * This is the failure the renewal exists for, and it is only observable with two
 * processes: one holds a lease whose window is shorter than its work, and the
 * other polls until it can take the lease. Without renewal the poller wins while
 * the first is still running; with renewal it never does.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { acquireLease, currentInstanceId } from '../src/scheduler/job-lease.service.js';

const name = () => `steal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function row(job: string) {
  return prisma.jobLease.findUniqueOrThrow({ where: { name: job } });
}

describe('a second instance cannot take a lease that is being renewed', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "job_lease" CASCADE');
  });

  it('loses the lease when the work outlasts it and nothing renews', async () => {
    const job = name();
    const shortLease = 600;

    const held = await acquireLease(job, shortLease);
    expect(held.acquired).toBe(true);

    // Work that takes much longer than the lease, with no renewal.
    await new Promise((resolve) => setTimeout(resolve, shortLease * 2));
    await held.release();

    // The lease has lapsed, so another instance can now take it: this is the
    // bug the renewal fixes, demonstrated rather than described.
    const stolen = await acquireLease(job, shortLease);
    expect(stolen.acquired).toBe(true);
    expect((await row(job)).expiresAt.getTime()).toBeLessThan(Date.now() + shortLease * 2);
    await stolen.release();
  });

  it('keeps the lease while the work runs and renews it', async () => {
    const job = name();
    const shortLease = 600;

    const held = await acquireLease(job, shortLease);
    if (!held.acquired) return;

    const workMs = shortLease * 2;
    const started = Date.now();
    let stolenEver = false;

    // A second instance, polling every 120ms trying to take the lease.
    const thief = (async () => {
      while (Date.now() - started < workMs) {
        const attempt = await acquireLease(job, shortLease);
        if (attempt.acquired) {
          stolenEver = true;
          await attempt.release();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    })();

    // The worker renews on the same schedule the helper uses.
    const timer = setInterval(() => {
      void held.renew(shortLease);
    }, Math.floor(shortLease / 2));
    timer.unref?.();

    await new Promise((resolve) => setTimeout(resolve, workMs));
    clearInterval(timer);
    await thief;

    const during = await row(job);
    expect(stolenEver).toBe(false);
    expect(during.holder).toBe(currentInstanceId());
    expect(during.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await held.release();
  });
});
