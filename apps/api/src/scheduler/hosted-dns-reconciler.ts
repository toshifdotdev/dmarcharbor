import { env } from '../config/env.js';
import { withJobLease } from './job-lease.service.js';
import { recordJobFailure, recordJobSuccess } from './heartbeat.js';
import { hostedDnsProvider } from '../services/hosted-dns/provider.js';
import { reconcileHostedDns } from '../services/hosted-dns/hosted-dmarc.service.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

const RECONCILE_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Repairs drift in our hosted zone: a hand-edited record is put back to the
 * value in the database, and token-shaped records with our comment that no row
 * owns are removed.
 */
export async function runHostedDnsReconcileOnce(): Promise<void> {
  if (!hostedDnsProvider() || running) {
    return;
  }

  running = true;
  try {
    const summary = await withJobLease('hosted-dns-reconcile', () => reconcileHostedDns());
    if (summary !== undefined) {
      recordJobSuccess('hosted-dns-reconcile');
      if (summary.synced > 0 || summary.removed > 0 || summary.failed > 0) {
        console.info(
          `[hosted-dns] synced ${summary.synced}, removed ${summary.removed}, failed ${summary.failed}`,
        );
      }
    }
  } catch (error) {
    console.error(
      `[hosted-dns] reconcile failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    recordJobFailure('hosted-dns-reconcile');
  } finally {
    running = false;
  }
}

export function startHostedDnsReconciler(): void {
  if (
    timer ||
    !hostedDnsProvider() ||
    env.ALERT_SCHEDULER_DISABLED ||
    env.NODE_ENV === 'test'
  ) {
    return;
  }

  timer = setInterval(() => {
    void runHostedDnsReconcileOnce();
  }, RECONCILE_EVERY_MS);
  timer.unref?.();

  console.info('[hosted-dns] reconciler started, every 6 hours');
}

export function stopHostedDnsReconciler(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
