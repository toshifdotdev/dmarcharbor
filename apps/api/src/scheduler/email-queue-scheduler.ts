import { env } from '../config/env.js';
import { runEmailQueueOnce } from '../services/email-queue.service.js';
import { recordJobFailure, recordJobSuccess } from './heartbeat.js';

let timer: NodeJS.Timeout | undefined;

/**
 * Every thirty seconds.
 *
 * The queue exists to survive a provider outage, so how quickly it drains during one
 * is the difference between a customer getting a password reset in a minute and not
 * getting one at all. Thirty seconds is well inside any provider retry tolerance and
 * the pass is a single indexed read when there is nothing to do.
 */
export const emailQueueIntervalSeconds = 30;

/**
 * One pass, wrapped with the heartbeat.
 *
 * The recording lives here rather than in the service so the dependency runs one way:
 * services do not import from the scheduler package, and every other scheduler does it
 * in the same place.
 */
export async function runEmailQueuePass(): Promise<void> {
  try {
    await runEmailQueueOnce();
    // A pass that delivered nothing is still a pass that worked.
    recordJobSuccess('email-queue');
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown email queue error.';
    console.error(`[email] queue pass failed: ${detail}`);
    recordJobFailure('email-queue');
  }
}

export function startEmailQueueScheduler(): void {
  if (timer || env.ALERT_SCHEDULER_DISABLED) {
    return;
  }

  timer = setInterval(() => {
    void runEmailQueuePass();
  }, emailQueueIntervalSeconds * 1000);

  timer.unref?.();
  console.info(`[email] queue scheduler started, every ${emailQueueIntervalSeconds} seconds`);

  /**
   * One pass on boot rather than waiting a full interval.
   *
   * Anything queued while this replica was down is sitting in the table, and the
   * previous instance's interval has already elapsed by definition.
   */
  void runEmailQueuePass();
}

export function stopEmailQueueScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}