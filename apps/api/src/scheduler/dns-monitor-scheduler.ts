import { env } from '../config/env.js';
import { withJobLease } from './job-lease.service.js';
import { recordJobFailure, recordJobSuccess } from './heartbeat.js';
import { runDnsMonitorPass } from '../services/monitoring/dns-monitor.service.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * Looks for due domains on a short tick and rescans them.
 *
 * The interval on `Domain.monitorClaimedAt` is what makes each domain due; this
 * timer only decides how often work is looked for, so a forty-minute tick is
 * not a forty-minute monitoring interval.
 */
export async function runDnsMonitorOnce(): Promise<void> {
  if (running || !env.DNS_MONITOR_ENABLED) {
    return;
  }

  running = true;
  try {
    const summary = await withJobLease('dns-monitor', async () => runDnsMonitorPass());
    if (summary !== undefined) {
      recordJobSuccess('dns-monitor');
      if (summary.claimed > 0 || summary.changes > 0) {
        console.info(
          `[dns-monitor] claimed ${summary.claimed}, completed ${summary.completed}, failed ${summary.failed}, changes ${summary.changes}, skipped ${summary.skipped}`,
        );
      }
    }
  } catch (error) {
    console.error(
      `[dns-monitor] pass failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    recordJobFailure('dns-monitor');
  } finally {
    running = false;
  }
}

export function startDnsMonitorScheduler(): void {
  if (
    timer ||
    !env.DNS_MONITOR_ENABLED ||
    env.ALERT_SCHEDULER_DISABLED ||
    env.NODE_ENV === 'test'
  ) {
    return;
  }

  const intervalMs = env.DNS_MONITOR_TICK_MINUTES * 60 * 1000;
  timer = setInterval(() => {
    void runDnsMonitorOnce();
  }, intervalMs);
  timer.unref?.();

  console.info(
    `[dns-monitor] scheduler started, checking every ${env.DNS_MONITOR_TICK_MINUTES} minutes, rescanning each domain every ${env.DNS_MONITOR_INTERVAL_MINUTES} minutes`,
  );
}

export function stopDnsMonitorScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
