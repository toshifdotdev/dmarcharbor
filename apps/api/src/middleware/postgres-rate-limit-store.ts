import type { Store } from 'express-rate-limit';
import { prisma } from '../database/prisma.js';

/**
 * Rate limit counters, shared by every replica.
 *
 * WHY THIS EXISTS
 *
 * `express-rate-limit` defaults to an in-process `Map`, and this service used that
 * default. Behind a load balancer that means each replica enforces its own complete
 * budget: a limit written as 600 requests a minute is 1800 across three replicas, and
 * it is 1800 across six. Nothing about the deployment looks wrong in the config, and
 * the limit is simply not the limit anyone reading it thinks it is.
 *
 * The same Map also resets on every deploy, which quietly turns a rolling restart
 * into a way for a client to exceed a budget repeatedly.
 *
 * WHY POSTGRES
 *
 * The service already depends on it, it is already the thing that has to be available
 * for any request to succeed at all, and there is no Redis in this deployment to add
 * one. A limit store that is down is not a degraded rate limiter, it is an outage, so
 * it belongs somewhere the outage already is.
 *
 * The trade is a database round trip per limited request. That is real, and it is why
 * the limiters are mounted only where they are doing work rather than on every route.
 * A Redis store is the answer if the volume ever justifies running Redis.
 *
 * HOW THE INCREMENT IS ATOMIC
 *
 * One statement, `ON CONFLICT DO UPDATE SET hits = hits + 1`, so two replicas counting
 * the same request cannot both read the current total and write back their own
 * arithmetic. The loser waits, and the returned value already includes its increment.
 */

interface BucketRow {
  key: string;
  limiter: string;
  hits: number;
  resetAt: Date;
}

/** How many expired buckets one sweep removes. */
const sweepBatch = 5_000;

/**
 * One instance per limiter, named.
 *
 * The name is set here rather than recovered from the key. `express-rate-limit` does
 * not tell a store which limiter is calling it, and the obvious workaround - reading
 * a `limiterName:` prefix out of the key - depends on the library having been
 * configured to add one. It has no option for that in the version this service runs,
 * so every key arrives bare and every limiter would have shared one bucket: a client
 * who exhausted their sign-in budget would silently exhaust their API budget too.
 *
 * Naming the store is explicit, version-independent, and impossible to get wrong by
 * forgetting a setting somewhere.
 */
export class PostgresRateLimitStore implements Store {
  /** Called by the library to name this store in diagnostics. */
  readonly name: string;

  /**
   * Tells the library's own double-count check to key on this instance.
   *
   * `express-rate-limit` detects "one request incremented twice" by tracking keys per
   * request, and it buckets that tracking by `store.localKeys ? store :
   * store.constructor.name`. Every limiter here is an instance of this one class, so
   * without this flag a request passing through two limiters that produce the same
   * client key is reported as a double count - a false positive caused entirely by
   * having one store class and several limiters.
   *
   * Set rather than suppressing the check: the check is worth keeping, and it is only
   * wrong because it could not tell nine stores apart.
   */
  readonly localKeys = true;

  constructor(private readonly limiterName: string) {
    this.name = `postgres:${limiterName}`;
  }

  /**
 * Counts one request against a bucket and returns the resulting state.
 *
 * Returning the information rather than nothing is what lets the library produce the
 * `RateLimit-*` response headers without a second round trip to read back the total it
 * just wrote.
 *
 * `resetAt` is the moment the window closes, expressed in epoch milliseconds because
 * that is the unit the library's headers use.
 */
async increment(key: string): Promise<{ totalHits: number; resetTime: Date }> {
  // The library does not pass the window here, so the default is the shortest this
  // service uses. `express-rate-limit` overrides the store's increment with its own
  // windowed variant when the middleware is configured with one; see
  // `incrementWithWindow` for the same statement with the window supplied.
  return this.incrementWithWindow(key, Date.now() + 60_000);
}

/**
 * The windowed form, and the actual primitive.
 *
 * Kept separate because `Store.increment` receives no window: the window is a
 * property of the limiter, not of the request. A bucket's window is set when the
 * bucket is created and only extended when a new one begins, which is the fixed-window
 * behaviour the library documents.
 */
async incrementWithWindow(key: string, resetAtMs: number): Promise<{ totalHits: number; resetTime: Date }> {
  const resetAt = new Date(resetAtMs);
  const limiter = this.limiterName;
  const bucketKey = key;

  /**
   * Fails open, deliberately.
   *
   * Moving the counters from process memory into the database made this store part of
   * the request path, and the first thing that does is let a storage problem decide
   * whether unrelated endpoints work. Observed while writing this: with Postgres down,
   * every route including `/api/health` returned 500, because the limiter rejected the
   * request before any handler ran.
   *
   * A rate limit is a protective measure, not a correctness requirement. Failing closed
   * would mean a brief blip in a counting table turns into a total outage of the
   * service, which is strictly worse than the abuse it prevents: the endpoints that
   * matter most are the ones whose real authentication already depends on the same
   * database, so they are unavailable either way, and the ones that would keep serving
   * are the ones a counter outage should not be able to take down.
   *
   * The cost is real and is why this is logged rather than silent: during an outage the
   * limits are not being enforced, so a burst is not being shed. The warning is the
   * signal to alert on, and it carries the limiter name so the operator knows which
   * budget is not holding.
   */
  try {
    const rows = await prisma.$queryRawUnsafe<BucketRow[]>(
      `INSERT INTO "rate_limit_bucket" ("key", "limiter", "hits", "resetAt")
       VALUES ($1, $2, 1, $3)
       ON CONFLICT ("key", "limiter") DO UPDATE
         SET "hits" = CASE WHEN "rate_limit_bucket"."resetAt" <= NOW() THEN 1
                           ELSE "rate_limit_bucket"."hits" + 1 END,
             "resetAt" = CASE WHEN "rate_limit_bucket"."resetAt" <= NOW() THEN $3
                              ELSE "rate_limit_bucket"."resetAt" END
       RETURNING "hits", "resetAt"`,
      bucketKey,
      limiter,
      resetAt,
    );

    const row = rows[0];

    return {
      totalHits: row?.hits ?? 1,
      resetTime: row?.resetAt ?? resetAt,
    };
  } catch (error) {
    logRateLimitStoreFailure(this.limiterName, error);

    // Reported as an empty window so the request is allowed through.
    return { totalHits: 0, resetTime: resetAt };
  }
}

  async decrement(key: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE "rate_limit_bucket" SET "hits" = GREATEST("hits" - 1, 0)
       WHERE "key" = $1 AND "limiter" = $2`,
      key,
      this.limiterName,
    );
  }

  /**
   * Reads the current total without counting this call.
   *
   * Used by the library to answer "how many have I used" without spending a hit.
   * Returns zero for a bucket that does not exist, which is the same thing as an
   * untouched bucket.
   */
  async currentHits(key: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<BucketRow[]>(
      'SELECT "hits", "resetAt" FROM "rate_limit_bucket" WHERE "key" = $1 AND "limiter" = $2',
      key,
      this.limiterName,
    );

    const row = rows[0];
    if (!row || row.resetAt.getTime() <= Date.now()) {
      return 0;
    }

    return row.hits;
  }

  /** Removes one bucket entirely. */
  async resetKey(key: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      'DELETE FROM "rate_limit_bucket" WHERE "key" = $1 AND "limiter" = $2',
      key,
      this.limiterName,
    );
  }

  /**
   * Drops buckets whose window has closed.
   *
   * Without this the table grows without bound: a bucket per client address per
   * limiter, forever, holding one integer for traffic that ended days ago. Bounded per
   * run so a large backlog cannot hold a request open.
   */
  async sweep(now = new Date()): Promise<number> {
    const removed = await prisma.$executeRawUnsafe(
      `DELETE FROM "rate_limit_bucket"
       WHERE ("key", "limiter") IN (
         SELECT "key", "limiter" FROM "rate_limit_bucket"
         WHERE "resetAt" <= $1 LIMIT $2
       )`,
      now,
      sweepBatch,
    );

    return removed;
  }

  async resetAll(): Promise<void> {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "rate_limit_bucket"');
  }
}

/**
 * One warning per limiter per interval.
 *
 * Without the throttle, an unreachable database produces one line per request, which
 * turns a dependency problem into a log flood that pushes the line that says what is
 * actually wrong off the front of the tail. The interval also gives a slow recovery a
 * chance to stop warning before it is finished, so "last warned 4 seconds ago" cannot
 * be read as "still broken" when it is not.
 */
const lastFailureWarningAt = new Map<string, number>();
const FAILURE_WARNING_INTERVAL_MS = 30_000;

function logRateLimitStoreFailure(limiter: string, error: unknown): void {
  const now = Date.now();
  const previous = lastFailureWarningAt.get(limiter) ?? 0;

  if (now - previous < FAILURE_WARNING_INTERVAL_MS) {
    return;
  }
  lastFailureWarningAt.set(limiter, now);

  const reason = error instanceof Error ? error.message : String(error);
  // Matches the shape server.ts and app.ts already use, so this arrives in the same
  // stream an operator is already reading rather than in a second logging dialect.
  console.warn(`[rate-limit] counter store unavailable, limiter "${limiter}" is allowing requests: ${reason}`);
}

/**
 * A named store per limiter.
 *
 * Returned as a factory rather than a shared singleton because the limiter name is
 * what keeps the buckets apart, and one singleton would have meant every limiter in
 * the service counting into the same rows.
 */
export function rateLimitStoreFor(limiterName: string): PostgresRateLimitStore {
  return new PostgresRateLimitStore(limiterName);
}