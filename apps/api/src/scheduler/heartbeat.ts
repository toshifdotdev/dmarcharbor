/**
 * When each scheduled job last did something useful.
 *
 * A scheduler that is failing is the hardest kind of outage to notice, because
 * nothing breaks. Requests still succeed, the dashboard still loads, and the alert
 * that should have fired about a customer's domain simply never arrives, along with
 * the digest, the domain re-verification, the webhook retries and the retention
 * sweep. Every one of those jobs logs its own failures, but a log line in a container
 * that nobody is watching is not an alarm.
 *
 * This is the in-process half of the answer. The job records a heartbeat only after
 * it has actually completed work, so a job that is looping and erroring shows as
 * stale. `/ready` reports the ages, which is the signal an external monitor can alert
 * on: a monitor should page when this endpoint has reported a stale job for longer
 * than that job tolerates, not when the endpoint stops answering at all. The monitor
 * itself is outside this repository, so what is built here is the honest signal
 * rather than a pretend alarm.
 */

export interface JobHeartbeat {
  name: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  runs: number;
  failures: number;
}

const heartbeats = new Map<string, JobHeartbeat>();

/**
 * When this process started, so a job that has simply not reached its first interval
 * is not reported as broken.
 *
 * A freshly started replica has never run `alert-evaluation`, because it runs every
 * fifteen minutes. Reporting that as stale makes every single deploy look like an
 * outage, and a monitor that pages on every deploy is a monitor that gets switched
 * off. A job that has never run counts as stale only once the process has been up
 * long enough that it should have.
 */
const processStartedAt = Date.now();

/**
 * How long a job may go without completing before it counts as stale.
 *
 * Deliberately generous. Several of these run every fifteen minutes or hourly, and a
 * job that is merely slow, or briefly skipped because another replica held the lease,
 * is not an outage. Alerting on a job being fifteen minutes late when its interval is
 * fifteen minutes would page someone for nothing.
 */
const staleness: Record<string, number> = {
  'alert-evaluation': 45 * 60 * 1000,
  'domain-reverify': 6 * 60 * 60 * 1000,
  'webhook-delivery': 30 * 60 * 1000,
  'inbox-poll': 12 * 60 * 60 * 1000,
  'retention-sweep': 25 * 60 * 60 * 1000,
  'email-queue': 30 * 60 * 1000,
};

function entry(name: string): JobHeartbeat {
  const existing = heartbeats.get(name);
  if (existing) {
    return existing;
  }

  const created: JobHeartbeat = { name, lastSuccessAt: null, lastErrorAt: null, runs: 0, failures: 0 };
  heartbeats.set(name, created);
  return created;
}

/** Called by a job once it has completed successfully. */
export function recordJobSuccess(name: string): void {
  const job = entry(name);
  job.lastSuccessAt = new Date().toISOString();
  job.runs += 1;
}

/** Called by a job that failed. Does not clear the last success, on purpose. */
export function recordJobFailure(name: string): void {
  const job = entry(name);
  job.lastErrorAt = new Date().toISOString();
  job.failures += 1;
}

export interface JobStatus extends JobHeartbeat {
  stale: boolean;
  maxSilenceMs: number;
  /** True while the job is still within its first interval since this process booted. */
  awaitingFirstRun: boolean;
}

export interface SchedulerStatus {
  jobs: JobStatus[];
  staleJobs: string[];
}

export function schedulerStatus(now: Date = new Date()): SchedulerStatus {
  const uptimeMs = now.getTime() - processStartedAt;

  const jobs = Object.entries(staleness).map(([name, maxSilenceMs]) => {
    const job = heartbeats.get(name) ?? { name, lastSuccessAt: null, lastErrorAt: null, runs: 0, failures: 0 };
    const lastMs = job.lastSuccessAt ? new Date(job.lastSuccessAt).getTime() : null;

    return {
      ...job,
      maxSilenceMs,
      /**
       * Never run is stale, but only once the process has been up long enough that it
       * should have run.
       *
       * A job that died silently and one that is merely waiting for its first tick
       * look identical at boot, and only one of them is a problem. Calling the second
       * an outage makes every deploy look broken, and a monitor that pages on every
       * deploy is a monitor that gets ignored.
       */
      stale: lastMs === null ? uptimeMs > maxSilenceMs : now.getTime() - lastMs > maxSilenceMs,
      awaitingFirstRun: lastMs === null && uptimeMs <= maxSilenceMs,
    };
  });

  return { jobs, staleJobs: jobs.filter((job) => job.stale).map((job) => job.name) };
}

/** Test seam, so a suite can assert on a fresh map rather than a shared one. */
export function resetHeartbeats(): void {
  heartbeats.clear();
}