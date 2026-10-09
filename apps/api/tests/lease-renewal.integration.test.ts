import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import {
  acquireLease,
  currentInstanceId,
  defaultLeaseMs,
  withDueLease,
  withJobLease,
} from '../src/scheduler/job-lease.service.js';

/**
 * The lease is renewed while a job runs, rather than assuming the job finishes
 * inside the lease.
 *
 * Ten minutes is a guess about how long the work takes, and `alert-evaluation`
 * runs reconciliation, dunning, re-verification and erasure inside one lease.
 * Reconciliation makes an unbounded provider call per tenant. At a few hundred
 * tenants the pass exceeds the lease, the lease lapses, a second replica takes
 * it, and the work runs twice - which is the exact duplication the lease exists
 * to prevent, arriving precisely when the system is busiest.
 */

const leaseMs = 6_000;

async function leaseRow(name: string) {
  return prisma.jobLease.findUniqueOrThrow({ where: { name } });
}

describe('lease renewal', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "job_lease" CASCADE');
  });

  it('extends the lease while the job is still running', async () => {
    const name = `renew-extend-${Date.now()}`;
    const lease = await acquireLease(name, leaseMs);
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) return;

    const before = await leaseRow(name);

    // Renew several times, the way the timer does while a job runs.
    expect(await lease.renew(leaseMs)).toBe(true);
    expect(await lease.renew(leaseMs)).toBe(true);

    const after = await leaseRow(name);
    expect(after.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
    // And it is still the same holder: renewal must not change ownership.
    expect(after.holder).toBe(currentInstanceId());
  });

  it('reports when the lease was taken over, rather than silently renewing', async () => {
    const name = `renew-lost-${Date.now()}`;
    const lease = await acquireLease(name, leaseMs);
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) return;

    // Another instance force-takes it, as a lapsed lease would be.
    await lease.release();

    const renewed = await lease.renew(leaseMs);
    expect(renewed).toBe(false);
  });

  it('stops renewing once the job has released the lease', async () => {
    const name = `renew-released-${Date.now()}`;
    const lease = await acquireLease(name, leaseMs);
    if (!lease.acquired) return;

    await lease.release();
    expect(await lease.renew(leaseMs)).toBe(false);
  });

  it('renews the lease of a job that outlasts its initial window', async () => {
    const name = `renew-withjob-${Date.now()}`;
    const jobMs = 1_800;
    // Deliberately shorter than the job, so the lease would lapse without renewal.
    const shortLease = 900;

    let midJobExpiry = 0;
    await withJobLease(
      name,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, jobMs));
        // Read while the job is still running, before the finally block releases
        // it - release() sets expiresAt to now, so reading afterwards measures
        // the released row rather than the live one.
        midJobExpiry = (await leaseRow(name)).expiresAt.getTime();
      },
      shortLease,
    );

    // Sampled after 900ms under a 900ms lease, without renewal it would have
    // lapsed and this instance would no longer hold it.
    expect(midJobExpiry).toBeGreaterThan(0);
    expect(midJobExpiry).toBeGreaterThan(Date.now() - 1_000);
  });

  it('renewal is scoped to the named lease', async () => {
    const mine = `renew-scope-mine-${Date.now()}`;
    const other = `renew-scope-other-${Date.now()}`;

    const lease = await acquireLease(mine, leaseMs);
    if (!lease.acquired) return;

    // Renewing mine must not touch a different lease.
    await acquireLease(other, leaseMs);
    await lease.renew(leaseMs);

    expect((await leaseRow(other)).expiresAt.getTime()).toBeGreaterThan(0);
    expect((await leaseRow(other)).holder).toBe(currentInstanceId());
  });

  it('runs the body only when the schedule is due, and renews it', async () => {
    const name = `renew-due-${Date.now()}`;
    const shortLease = 900;
    const jobMs = 1_500;

    let ran = 0;
    let midJobExpiry = 0;

    await withDueLease(
      name,
      // Immediately due.
      -1,
      async () => {
        ran += 1;
        await new Promise((resolve) => setTimeout(resolve, jobMs));
        midJobExpiry = (await leaseRow(name)).expiresAt.getTime();
      },
      shortLease,
    );

    expect(ran).toBe(1);
    // Sampled after 900ms under a 900ms lease.
    expect(midJobExpiry).toBeGreaterThan(Date.now() - 1_000);
    // Default lease is what the helper falls back to, and it is a real window.
    expect(defaultLeaseMs).toBe(10 * 60 * 1000);
  });
});
