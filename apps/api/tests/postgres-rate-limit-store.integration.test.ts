import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { PostgresRateLimitStore } from '../src/middleware/postgres-rate-limit-store.js';

/**
 * Rate limit counters, and the reason they moved out of process memory.
 *
 * The library's default store is a per-process `Map`. Behind a load balancer that
 * makes every replica enforce its own complete budget, so a limit written as 600 a
 * minute is 1800 across three replicas and nothing in the configuration says so. The
 * same Map also resets on every deploy, which quietly turns a rolling restart into a
 * way to exceed a budget repeatedly.
 *
 * These assertions are about the store itself rather than about HTTP responses,
 * because the property that matters is that two independent callers share one number.
 * An HTTP test on a single process cannot see the defect it is guarding against.
 */

const authStore = new PostgresRateLimitStore('auth');
const apiStore = new PostgresRateLimitStore('api');

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "rate_limit_bucket"');
}

describe('shared rate limit store', () => {
  beforeEach(resetDatabase);

  it('counts the same key from two independent store instances', async () => {
    /**
     * Two objects against one limiter name, deliberately.
     *
     * One store instance is what a single process has, and it would pass against an
     * in-memory implementation too. Two is what two replicas look like, and it is the
     * only arrangement in which a shared store is distinguishable from a per-process
     * one.
     */
    const replicaA = new PostgresRateLimitStore('auth');
    const replicaB = new PostgresRateLimitStore('auth');

    expect((await replicaA.increment('203.0.113.10')).totalHits).toBe(1);
    expect((await replicaB.increment('203.0.113.10')).totalHits).toBe(2);
    expect((await replicaA.increment('203.0.113.10')).totalHits).toBe(3);
  });

  it('does not lose a hit when both replicas count at once', async () => {
    const replicaA = new PostgresRateLimitStore('auth');
    const replicaB = new PostgresRateLimitStore('auth');

    /**
     * The race a read-modify-write store loses.
     *
     * Both read the current total, both add one, both write. If the increment is not a
     * single statement the answer is 1 rather than 4, and in production it would be
     * wrong only under load, which is the worst place to discover it.
     */
    const results = await Promise.all([
      replicaA.increment('203.0.113.20'),
      replicaB.increment('203.0.113.20'),
      replicaA.increment('203.0.113.20'),
      replicaB.increment('203.0.113.20'),
    ]);

    const totals = results.map((result) => result.totalHits).sort((left, right) => left - right);

    expect(totals).toEqual([1, 2, 3, 4]);
  });

  it('keeps two limiters in separate buckets even for the same client', async () => {
    await authStore.increment('203.0.113.30');
    await authStore.increment('203.0.113.30');
    await apiStore.increment('203.0.113.30');

    /**
     * The isolation that was nearly lost.
     *
     * The library does not tell a store which limiter is calling it, so a shared store
     * instance cannot tell them apart from the key either. Sharing one instance would
     * have put every limiter's counters in the same rows, and a client who exhausted
     * their sign-in budget would have silently exhausted their API budget too. The
     * limiter name lives on the store, which is the only place it can be known.
     */
    expect(await authStore.currentHits('203.0.113.30')).toBe(2);
    expect(await apiStore.currentHits('203.0.113.30')).toBe(1);

    const rows = await prisma.$queryRawUnsafe<{ limiter: string; hits: number }[]>(
      'SELECT "limiter", "hits" FROM "rate_limit_bucket" ORDER BY "limiter", "hits"',
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.limiter).sort()).toEqual(['api', 'auth']);
  });

  it('reports an untouched key as zero rather than throwing', async () => {
    expect(await authStore.currentHits('198.51.100.99')).toBe(0);
  });

  it('starts a new window rather than accumulating for ever', async () => {
    // A window that closed a minute ago.
    await authStore.incrementWithWindow('203.0.113.40', Date.now() - 60_000);
    const afterReset = await authStore.incrementWithWindow('203.0.113.40', Date.now() + 60_000);

    /**
     * One, not two.
     *
     * A bucket whose window has passed is a fresh window, so a client is not
     * permanently blocked because their counters once ran high.
     */
    expect(afterReset.totalHits).toBe(1);
  });

  it('decrements without going below zero', async () => {
    await authStore.increment('203.0.113.50');

    await authStore.decrement('203.0.113.50');
    expect(await authStore.currentHits('203.0.113.50')).toBe(0);

    // One decrement more than there were hits. A negative count would be credit, and
    // credit is not a thing a limiter should be able to hand out.
    await authStore.decrement('203.0.113.50');
    expect(await authStore.currentHits('203.0.113.50')).toBe(0);
  });

  it('resets one key without touching another', async () => {
    await authStore.increment('203.0.113.60');
    await authStore.increment('203.0.113.61');

    await authStore.resetKey('203.0.113.60');

    expect(await authStore.currentHits('203.0.113.60')).toBe(0);
    expect(await authStore.currentHits('203.0.113.61')).toBe(1);
  });

  it('sweeps only buckets whose window has closed', async () => {
    await authStore.incrementWithWindow('203.0.113.70', Date.now() - 60_000);
    await authStore.incrementWithWindow('203.0.113.71', Date.now() + 600_000);

    const removed = await authStore.sweep();

    /**
     * The table holds one row per client address per limiter for ever unless this runs.
     * A bucket per address holding a single integer for traffic that ended days ago is
     * a table that only grows, and it is swept by the retention job rather than on the
     * request path so nothing blocks a user to tidy up.
     */
    expect(removed).toBe(1);
    expect(await authStore.currentHits('203.0.113.70')).toBe(0);
    expect(await authStore.currentHits('203.0.113.71')).toBe(1);
  });

  it('counts a real HTTP request into the shared table', async () => {
    const { app } = await import('../src/index.js');

    /**
     * The end-to-end shape, and a better assertion than reading a response header.
     *
     * `/api/auth/get-session` rather than `/api/health` or `/api/auth/providers`.
     * Health is deliberately not rate limited, because a probe being throttled is how a
     * healthy replica gets killed by its own orchestrator. And `authOptionsRouter` is
     * mounted ahead of the auth limiter, so `/api/auth/providers` is answered before
     * the limiter ever runs - which is also why that path cannot be used to prove
     * anything about limiting.
     *
     * The proof that the shared store is in the request path is that the request
     * leaves a row behind. A header the library chose to emit, or chose not to, is a
     * detail that changes between versions.
     */
    await authStore.resetAll();

    const response = await request(app).get('/api/auth/get-session');

    expect([200, 401]).toContain(response.status);

    const rows = await prisma.$queryRawUnsafe<{ hits: number }[]>(
      'SELECT "hits" FROM "rate_limit_bucket" WHERE "limiter" = $1',
      'auth',
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.hits).toBeGreaterThanOrEqual(1);
  });

  it('keeps serving requests when the counter store is unreachable', async () => {
    const { app } = await import('../src/index.js');
    const store = new PostgresRateLimitStore('auth');
    await store.resetAll();

    /**
     * Found by breaking it, not by reasoning about it.
     *
     * With Postgres down, every route returned 500 - including `/api/health` - because
     * the limiter rejected the request before a handler ran. Moving counters out of
     * process memory had quietly turned a counting table into a hard dependency of
     * every endpoint, so a storage blip became a total outage.
     *
     * Asserted against the real app rather than the store in isolation: the property
     * worth protecting is that a customer-visible endpoint keeps answering, which is
     * exactly what the failure took away.
     */
    const realQuery = prisma.$queryRawUnsafe.bind(prisma);
    vi.spyOn(prisma, '$queryRawUnsafe').mockImplementation((async () => {
      throw new Error('connection refused');
    }) as typeof prisma.$queryRawUnsafe);

    try {
      const response = await request(app).get('/api/auth/get-session');

      // A 500 here is the defect: the limiter answered instead of the route.
      expect(response.status).not.toBe(500);
      expect([200, 401]).toContain(response.status);
    } finally {
      vi.restoreAllMocks();
      await realQuery('TRUNCATE TABLE "rate_limit_bucket"');
    }
  });
});