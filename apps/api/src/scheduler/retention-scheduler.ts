import { env } from '../config/env.js';
import { purgeExpiredData, type RetentionSweep } from '../services/retention.service.js';
import { withJobLease } from './job-lease.service.js';
import { recordJobFailure, recordJobSuccess } from './heartbeat.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * Hourly.
 *
 * Every window here is measured in days, so a shorter interval would delete nothing
 * extra and only add database work. Hourly means the worst case overshoot on a
 * seven day export window is an hour, which is well inside any retention claim the
 * service makes.
 */
export const retentionIntervalSeconds = 3600;

const empty: RetentionSweep = {
  exportJobs: 0,
  idempotencyRecords: 0,
  ssoAuthRequests: 0,
  billingPayloads: 0,
};

export async function runRetentionOnce(): Promise<RetentionSweep> {
  if (running) {
    return empty;
  }

  running = true;
  try {
    /**
     * Leased, because unlike per-row claiming this is a bulk delete.
     *
     * Every replica running it would delete the same rows and get the same counts,
     * which is wasted work rather than a correctness problem, but on a table holding
     * customer datasets the wasted work is the expensive part.
     */
    const summary = await withJobLease('retention-sweep', async () => {
      const swept = await purgeExpiredData();
      const total =
        swept.exportJobs + swept.idempotencyRecords + swept.ssoAuthRequests + swept.billingPayloads;

      if (total > 0) {
        console.info(
          `[retention] removed ${swept.exportJobs} export job(s), ${swept.idempotencyRecords} idempotency record(s), ${swept.ssoAuthRequests} SSO request(s) and emptied ${swept.billingPayloads} billing payload(s)`,
        );
      }

      return swept;
    });

    // Undefined when another instance holds the lease, which is a skip rather than a
    // failure.
    if (summary !== undefined) {
      recordJobSuccess('retention-sweep');
    }

    return summary ?? empty;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown retention sweep error.';
    console.error(`[retention] sweep failed: ${detail}`);
    recordJobFailure('retention-sweep');
    return empty;
  } finally {
    running = false;
  }
}

export function startRetentionScheduler(): void {
  if (timer || env.ALERT_SCHEDULER_DISABLED) {
    return;
  }

  timer = setInterval(() => {
    void runRetentionOnce();
  }, retentionIntervalSeconds * 1000);

  timer.unref?.();
  console.info(`[retention] sweep scheduler started, every ${retentionIntervalSeconds} seconds`);
}

export function stopRetentionScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}