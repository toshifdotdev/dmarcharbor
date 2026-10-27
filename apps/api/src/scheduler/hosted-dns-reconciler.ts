import { env } from '../config/env.js';
import { withJobLease } from './job-lease.service.js';
import { recordJobFailure, recordJobSuccess } from './heartbeat.js';
import { hostedDnsProvider } from '../services/hosted-dns/provider.js';
import { reconcileHostedDns } from '../services/hosted-dns/hosted-dmarc.service.js';
import { reconcileManagedSpf } from '../services/hosted-dns/managed-spf.service.js';
import { reconcileHostedBimi } from '../services/hosted-dns/hosted-bimi.service.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

const RECONCILE_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Repairs drift in our hosted zone: a hand-edited record is put back to the
 * value in the database, and token-shaped records with our comment that no row
 * owns are removed.
 *
 * The BIMI pass runs last and does one extra job: it purges logo and
 * certificate bytes that have been retired longer than the seven-day grace
 * period, which is why it needs the clock rather than only the rows.
 */
export async function runHostedDnsReconcileOnce(): Promise<void> {
  if (!hostedDnsProvider() || running) {
    return;
  }

  running = true;
  try {
    const summary = await withJobLease('hosted-dns-reconcile', async () => {
      const dmarc = await reconcileHostedDns();
      const spf = await reconcileManagedSpf();
      const bimi = await reconcileHostedBimi();
      return { dmarc, spf, bimi };
    });
    if (summary !== undefined) {
      recordJobSuccess('hosted-dns-reconcile');
      const { dmarc, spf, bimi } = summary;
      if (dmarc.synced > 0 || dmarc.removed > 0 || dmarc.failed > 0) {
        console.info(
          `[hosted-dns] synced ${dmarc.synced}, removed ${dmarc.removed}, failed ${dmarc.failed}`,
        );
      }
      if (spf.refreshed > 0 || spf.removed > 0 || spf.failed > 0) {
        console.info(
          `[hosted-spf] refreshed ${spf.refreshed}, removed ${spf.removed}, failed ${spf.failed}`,
        );
      }
      if (bimi.synced > 0 || bimi.removed > 0 || bimi.failed > 0 || bimi.purged > 0) {
        console.info(
          `[hosted-bimi] synced ${bimi.synced}, removed ${bimi.removed}, failed ${bimi.failed}, purged ${bimi.purged}`,
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
