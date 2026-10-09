import { randomUUID } from 'node:crypto';
import { prisma } from '../database/prisma.js';

/**
 * Deciding which instance runs which job.
 *
 * Why this exists
 * ---------------
 * Every scheduler in this service is started on boot by `server.ts`. Node runs
 * one JavaScript thread per process, which is why an in-process `running` flag is
 * sufficient to stop a single process overlapping itself. But autoscaling means
 * several *processes*, each with its own thread and its own flag, and a flag
 * cannot see the others. Before this, three replicas meant three copies of the
 * same customer email.
 *
 * So the coordination has to live somewhere outside the process. A row in
 * PostgreSQL is that somewhere.
 *
 * Why not a Postgres advisory lock
 * --------------------------------
 * `pg_advisory_lock` is *session* scoped. Prisma pools connections, so the
 * statement that takes the lock and the statement that releases it can land on
 * two different pooled sessions, leaving the lock held on a session that stays
 * in the pool. The job then never runs again on that instance, and nothing
 * reports why. The transaction scoped variant, `pg_try_advisory_xact_lock`,
 * releases correctly but only at the end of its transaction, which means the
 * whole job would have to run inside a database transaction. That would hold a
 * pooled connection open across DNS lookups, IMAP logins and outbound HTTP,
 * which is worse than the problem being solved.
 *
 * A lease row avoids all of that: one statement, no session affinity, and it
 * expires on its own.
 *
 * What this is and is not responsible for
 * ---------------------------------------
 * This is a *coarse* gate. It stops N instances from doing N times the work,
 * which is what saves duplicate DNS lookups, duplicate provider API calls and
 * duplicate logins to a customer's mail host.
 *
 * It is not the thing that guarantees a customer email is sent once. That is the
 * job's own atomic row claim, and every job that sends something outward has
 * one, because a lease cannot cover a crash between "I decided to send" and "I
 * sent it". The two together: the lease stops the stampede, the row claim makes
 * the outcome correct even when the stampede happens anyway.
 */

/**
 * Renewal interval, and why it is not the obvious third of the lease.
 *
 * Renewing at `leaseMs / 3` leaves the last third of the lease as headroom, which
 * sounds generous and was measured to be too little: a timer fires, Prisma takes
 * a few milliseconds to write, and the timer can be delayed further by anything
 * else the event loop is doing - so at a 900ms lease a renewal landing at exactly
 * the third boundary loses the race to `expiresAt < now`. The window is then
 * smaller than it reads.
 *
 * At half the lease, a renewal that is seconds late still lands well inside the
 * window, and the job has to be almost twice its lease old before renewal can
 * stop helping.
 */
const renewIntervalMs = (leaseMs: number): number => Math.max(Math.floor(leaseMs / 2), 500);

/** Identifies this process in the lease, so a stuck job traces back to a process. */
let instanceId: string | undefined;

export function currentInstanceId(): string {
  instanceId ??= `${process.pid}-${randomUUID().slice(0, 8)}`;
  return instanceId;
}

/**
 * How long a lease is held for.
 *
 * Long enough to cover a slow run, because stealing a lease from an instance that
 * is still working would reintroduce exactly the duplication this prevents. An
 * instance that dies costs one interval of delay, not a job that never runs
 * again.
 */
export const defaultLeaseMs = 10 * 60 * 1000;

export type LeaseResult =
  | { acquired: true; release: () => Promise<void>; renew: (leaseMs?: number) => Promise<boolean> }
  | { acquired: false };

/**
 * Takes the lease for `name`, or reports that another instance holds it.
 *
 * The acquire is one statement. The insert creates the row if it is absent; the
 * conflict branch takes it over only if the current lease has already expired.
 * When the conflict branch's condition is not met, the row is left alone and
 * nothing comes back, which is how losing the race is detected. A read followed
 * by a write would leave a window where every instance believed it had won.
 */
export async function acquireLease(name: string, leaseMs = defaultLeaseMs): Promise<LeaseResult> {
  const holder = currentInstanceId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs);

  const rows = await prisma.$queryRaw<{ holder: string }[]>`
    INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
    VALUES (${name}, ${holder}, ${expiresAt}, ${now})
    ON CONFLICT ("name") DO UPDATE
      SET "holder" = EXCLUDED."holder",
          "expiresAt" = EXCLUDED."expiresAt",
          "updatedAt" = EXCLUDED."updatedAt"
      WHERE "job_lease"."expiresAt" < ${now}
    RETURNING "holder"
  `;

  if (rows.length !== 1 || rows[0]?.holder !== holder) {
    return { acquired: false };
  }

  let released = false;

  return {
    acquired: true,
    release: async () => {
      if (released) {
        return;
      }
      released = true;

      // Marked free rather than deleted, because the row's updatedAt is the
      // durable record of when the job last ran. Deleting it would throw that
      // away, and a schedule that lives in process memory resets on every
      // deploy.
      //
      // Scoped to the holder, so a lease that already expired and was taken by
      // somebody else is not released out from under them.
      await prisma.jobLease
        .updateMany({ where: { name, holder }, data: { expiresAt: new Date() } })
        .catch(() => undefined);
    },
    renew: async (leaseMs = 0) => {
      if (released) {
        return false;
      }

      const ms = leaseMs > 0 ? leaseMs : defaultLeaseMs;
      const expiry = new Date(Date.now() + ms);

      // Scoped to the holder and to a lease that has not already lapsed. Together
      // those two make this harmless to lose: if another instance has taken it,
      // the holder no longer matches, the statement changes nothing, and the
      // return value says so. Renewal cannot steal a lease back.
      const renewed = await prisma.jobLease
        .updateMany({
          where: { name, holder, expiresAt: { gt: new Date() } },
          data: { expiresAt: expiry },
        })
        .catch(() => ({ count: 0 }));

      return renewed.count === 1;
    },
  };
}

/**
 * Takes the lease only if the job has not run recently enough to be due.
 *
 * This is the whole fix for schedules being lost or bursted by a deploy. The
 * previous in-memory `lastRunAt` started at zero, so every restart considered
 * the job due immediately: deploying three times a day meant reconciling three
 * times a day regardless of a six hour interval, which is a great way to get
 * rate limited by a payment provider.
 *
 * Deciding "is it due" and "claim it" has to be one statement. Two would leave
 * a window where every instance agreed the job was due and all of them ran it.
 *
 * `updatedAt` is written only when the lease is actually taken, so it is the
 * time the job last started.
 */
export async function acquireDueLease(
  name: string,
  intervalMs: number,
  leaseMs = defaultLeaseMs,
): Promise<LeaseResult> {
  const holder = currentInstanceId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs);
  const dueBefore = new Date(now.getTime() - intervalMs);

  const rows = await prisma.$queryRaw<{ holder: string }[]>`
    INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
    VALUES (${name}, ${holder}, ${expiresAt}, ${now})
    ON CONFLICT ("name") DO UPDATE
      SET "holder" = EXCLUDED."holder",
          "expiresAt" = EXCLUDED."expiresAt",
          "updatedAt" = EXCLUDED."updatedAt"
      WHERE "job_lease"."expiresAt" < ${now}
        AND "job_lease"."updatedAt" < ${dueBefore}
    RETURNING "holder"
  `;

  if (rows.length !== 1 || rows[0]?.holder !== holder) {
    return { acquired: false };
  }

  let released = false;

  return {
    acquired: true,
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      await prisma.jobLease
        .updateMany({ where: { name, holder }, data: { expiresAt: new Date() } })
        .catch(() => undefined);
    },
    renew: async (leaseMs = 0) => {
      if (released) {
        return false;
      }

      const ms = leaseMs > 0 ? leaseMs : defaultLeaseMs;
      const renewed = await prisma.jobLease
        .updateMany({
          where: { name, holder, expiresAt: { gt: new Date() } },
          data: { expiresAt: new Date(Date.now() + ms) },
        })
        .catch(() => ({ count: 0 }));

      return renewed.count === 1;
    },
  };
}

/**
 * Runs `job` when the schedule says it is due and this process wins the lease.
 *
 * The same renewal reasoning as `withJobLease`, against `acquireDueLease`: these
 * jobs run on their own intervals but are still guarded by a fixed lease, and
 * reconciliation is the one that must not lose it, because it makes an unbounded
 * provider call per tenant and a fleet-wide re-run is exactly the provider
 * rate limit it is trying to avoid.
 *
 * Returns undefined either when the job is not due or when another instance holds
 * the lease, so the caller logs a skip rather than a result.
 */
export async function withDueLease<T>(
  name: string,
  intervalMs: number,
  job: () => Promise<T>,
  leaseMs?: number,
): Promise<T | undefined> {
  const lease = await acquireDueLease(name, intervalMs, leaseMs);
  if (!lease.acquired) {
    return undefined;
  }

  const ms = leaseMs && leaseMs > 0 ? leaseMs : defaultLeaseMs;
  const timer = setInterval(() => {
    void lease.renew(ms);
  }, renewIntervalMs(ms));
  timer.unref?.();

  try {
    return await job();
  } finally {
    clearInterval(timer);
    await lease.release();
  }
}

/** When a job last started. Exposed for observability and for tests. */
export async function lastRunAt(name: string): Promise<Date | null> {
  const row = await prisma.jobLease.findUnique({ where: { name } });
  return row?.updatedAt ?? null;
}

/**
 * Runs `job` only if this process wins the lease, renewing it while the job runs.
 *
 * Returns undefined when another instance holds it, so the caller can log a skip
 * rather than a result. A skipped cycle is free: every job here is periodic.
 *
 * A job that throws still releases its lease, otherwise one bad run would
 * silently disable the job for the whole lease duration.
 *
 * The renewal is the important part of this function and the reason it is not
 * just acquire/release. Ten minutes is long enough for a slow pass and short
 * enough that a crashed instance costs little, but it is a guess about how long
 * the work takes, and `alert-evaluation` runs reconciliation, dunning,
 * re-verification and erasure inside one lease. Reconciliation alone makes an
 * unbounded provider call per tenant. At a few hundred tenants the pass exceeds
 * ten minutes, the lease lapses, a second replica takes it, and the work runs
 * twice - which is the exact duplication the lease exists to prevent, arriving
 * precisely when the system is busiest.
 *
 * Renewing every third of the lease makes the lease cover the work instead of
 * the work fitting the lease. It cannot help once the lease has already lapsed,
 * because renewal is scoped to the holder and to a lease that has not expired;
 * that window is now one third of a lease rather than all of it.
 */
export async function withJobLease<T>(
  name: string,
  job: () => Promise<T>,
  leaseMs?: number,
): Promise<T | undefined> {
  const lease = await acquireLease(name, leaseMs);
  if (!lease.acquired) {
    return undefined;
  }

  const ms = leaseMs && leaseMs > 0 ? leaseMs : defaultLeaseMs;

  const timer = setInterval(() => {
    // Fire and forget: a renewal that fails leaves the job running and only
    // widens the window in which another instance may take over, which is what
    // release() in the finally block is for.
    void lease.renew(ms);
  }, renewIntervalMs(ms));

  // Does not hold the process open: a scheduler is a background timer, and an
  // unref'd renewal cannot be the reason a shutdown waits.
  timer.unref?.();

  try {
    return await job();
  } finally {
    clearInterval(timer);
    await lease.release();
  }
}
