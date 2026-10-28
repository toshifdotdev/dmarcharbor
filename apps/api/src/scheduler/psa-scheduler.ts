import { env } from '../config/env.js';
import { runPsaDelivery } from '../services/psa/psa-queue.service.js';
import { withJobLease } from './job-lease.service.js';
import { recordJobFailure, recordJobSuccess } from './heartbeat.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

export const psaDeliveryIntervalSeconds = env.PSA_DELIVERY_INTERVAL_SECONDS;

/**
 * Drains the PSA outbox.
 *
 * Same shape as the webhook scheduler: a lease so N replicas do not all scan
 * the same due rows every minute, a heartbeat so a stalled worker is visible,
 * and an unref'd interval so this never keeps the process alive on shutdown.
 *
 * The lease is about the batch, not correctness: jobs are claimed row by row,
 * so a second instance sending a different job is safe. It stops every replica
 * doing the same query every minute for the same result.
 */
export async function runPsaDeliveryOnce(): Promise<{
  processed: number;
  opened: number;
  noted: number;
  closed: number;
  retry: number;
  failed: number;
  skipped: number;
  paused: number;
}> {
  const empty = {
    processed: 0,
    opened: 0,
    noted: 0,
    closed: 0,
    retry: 0,
    failed: 0,
    skipped: 0,
    paused: 0,
  };
  if (running) return empty;

  running = true;
  try {
    const summary = await withJobLease('psa-delivery', async () => {
      const outcome = await runPsaDelivery();
      if (outcome.processed > 0) {
        console.info(
          `[psa] processed ${outcome.processed}: opened ${outcome.opened}, noted ${outcome.noted}, closed ${outcome.closed}, retrying ${outcome.retry}, failed ${outcome.failed}, skipped ${outcome.skipped}, paused ${outcome.paused}`,
        );
      }
      return outcome;
    });

    // Undefined when another instance holds the lease, which is a skip rather
    // than a failure.
    if (summary !== undefined) {
      recordJobSuccess('psa-delivery');
    }
    return summary ?? empty;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown PSA delivery error.';
    console.error(`[psa] delivery failed: ${detail}`);
    recordJobFailure('psa-delivery');
    return empty;
  } finally {
    running = false;
  }
}

export function startPsaScheduler(): void {
  if (timer || env.ALERT_SCHEDULER_DISABLED || env.PSA_SCHEDULER_DISABLED) {
    return;
  }

  timer = setInterval(() => {
    void runPsaDeliveryOnce();
  }, psaDeliveryIntervalSeconds * 1000);

  timer.unref?.();
  console.info(`[psa] delivery scheduler started, every ${psaDeliveryIntervalSeconds} seconds`);
}

export function stopPsaScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

export async function shutdownPsaScheduler(): Promise<void> {
  stopPsaScheduler();
}
