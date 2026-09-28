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

export type LeaseResult = { acquired: true; release: () => Promise<void> } | { acquired: false };

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

      // Scoped to the holder, so a lease that already expired and was taken by
      // somebody else is not released out from under them.
      await prisma.jobLease
        .deleteMany({ where: { name, holder } })
        .catch(() => undefined);
    },
  };
}

/**
 * Runs `job` only if this process wins the lease.
 *
 * Returns undefined when another instance holds it, so the caller can log a skip
 * rather than a result. A skipped cycle is free: every job here is periodic.
 *
 * A job that throws still releases its lease, otherwise one bad run would
 * silently disable the job for the whole lease duration.
 */
export async function withJobLease<T>(name: string, job: () => Promise<T>, leaseMs?: number): Promise<T | undefined> {
  const lease = await acquireLease(name, leaseMs);
  if (!lease.acquired) {
    return undefined;
  }

  try {
    return await job();
  } finally {
    await lease.release();
  }
}
