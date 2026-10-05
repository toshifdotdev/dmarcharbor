import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recordJobFailure,
  recordJobSuccess,
  resetHeartbeats,
  schedulerStatus,
} from '../src/scheduler/heartbeat.js';

/**
 * A failing scheduler breaks nothing visible.
 *
 * Requests keep succeeding, the dashboard keeps loading, and the alert that should
 * have fired about a customer's domain never arrives, along with the digest, the
 * re-verification, the webhook retries and the retention sweep. Every one of those
 * jobs logs its own failures, which is not an alarm.
 *
 * This is the signal an external monitor can page on, so what matters here is that it
 * distinguishes "quiet because healthy" from "quiet because broken", and that a job
 * which merely skipped its turn is not counted as either.
 */

beforeEach(resetHeartbeats);
afterEach(resetHeartbeats);

describe('scheduler liveness', () => {
it('treats a job that has never run as not yet stale, because it may not have been due', () => {
  const status = schedulerStatus();

  /**
   * A freshly started replica has never run `alert-evaluation`, because it runs every
   * fifteen minutes. Calling that stale makes every deploy look like an outage, and a
   * monitor that pages on every deploy is one that gets ignored. Staleness starts
   * counting from when the process came up.
   */
  expect(status.staleJobs).toEqual([]);
  expect(status.jobs.every((job) => job.awaitingFirstRun)).toBe(true);
  expect(status.jobs.find((job) => job.name === 'alert-evaluation')?.lastSuccessAt).toBeNull();
});

it('does call a job stale once the process has been up longer than it tolerates', () => {
  // Twenty six hours after boot: past every tolerance, so a job that never ran has
  // genuinely failed rather than merely not come round yet.
  const longAfterBoot = new Date(Date.now() + 26 * 60 * 60 * 1000);
  const status = schedulerStatus(longAfterBoot);

  expect(status.staleJobs).toContain('alert-evaluation');
  expect(status.staleJobs).toContain('retention-sweep');
  expect(status.jobs.every((job) => job.awaitingFirstRun)).toBe(false);
});

  it('reports a job as fresh once it has completed', () => {
    recordJobSuccess('alert-evaluation');

    const status = schedulerStatus();
    const job = status.jobs.find((candidate) => candidate.name === 'alert-evaluation');

    expect(job?.stale).toBe(false);
    expect(job?.runs).toBe(1);
    expect(status.staleJobs).not.toContain('alert-evaluation');
  });

  it('goes stale again once the job stops completing', () => {
    recordJobSuccess('retention-sweep');

    expect(schedulerStatus().staleJobs).not.toContain('retention-sweep');

    // Twenty six hours later, past the twenty five hour tolerance for an hourly job.
    const muchLater = new Date(Date.now() + 26 * 60 * 60 * 1000);
    const status = schedulerStatus(muchLater);

    expect(status.staleJobs).toContain('retention-sweep');
    expect(status.jobs.find((job) => job.name === 'retention-sweep')?.stale).toBe(true);
  });

  it('does not count a failure as success, and does not erase the last success', () => {
    recordJobSuccess('webhook-delivery');
    recordJobFailure('webhook-delivery');
    recordJobFailure('webhook-delivery');

    const job = schedulerStatus().jobs.find((candidate) => candidate.name === 'webhook-delivery');

    /**
     * The last success is kept rather than cleared, because the question an operator
     * asks is "when did this last work", and a job that worked an hour ago and has
     * been failing since is a different problem from one that has never worked.
     */
    expect(job?.lastSuccessAt).not.toBeNull();
    expect(job?.failures).toBe(2);
    expect(job?.runs).toBe(1);
    expect(job?.stale).toBe(false);
  });

  it('gives every scheduled job a tolerance, so none is silently unbounded', () => {
    const status = schedulerStatus();

    /**
     * A job missing from this table would report as stale forever, because nothing
     * defines when "too quiet" applies to it. This is the test that catches a new
     * scheduler being wired up without one.
     */
    for (const job of status.jobs) {
      expect(job.maxSilenceMs).toBeGreaterThan(0);
    }

    for (const name of [
      'alert-evaluation',
      'domain-reverify',
      'webhook-delivery',
      'inbox-poll',
      'retention-sweep',
    ]) {
      expect(status.jobs.map((job) => job.name)).toContain(name);
    }
  });

  it('tolerates a job that is merely slow rather than paging for it', () => {
    recordJobSuccess('alert-evaluation');

    /**
     * Twenty five minutes late on a fifteen minute interval is not an outage, and a
     * monitor that pages on it would train everyone to ignore it.
     */
    const somewhatLater = new Date(Date.now() + 25 * 60 * 1000);
    expect(schedulerStatus(somewhatLater).jobs.find((job) => job.name === 'alert-evaluation')?.stale).toBe(false);
  });
});