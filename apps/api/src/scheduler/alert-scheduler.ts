import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { evaluateAlertRules, runAlertRollups } from '../services/alert.service.js';
import { runReportDigests } from '../services/report-digest.service.js';
import { executeDueErasures } from '../services/erasure/erasure.service.js';
import { reverifyUnverifiedDomains } from '../services/domain-reverify.service.js';
import { purgeExpiredIdempotencyRecords } from '../services/api-key.service.js';
import { runDunning, runReconciliation } from '../billing/dunning.js';
import { withJobLease } from './job-lease.service.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
let lastReverifyAt = 0;
let lastDunningAt = 0;
let lastReconcileAt = 0;

/**
 * Dunning and reconciliation are slow, careful jobs, so each runs on its own
 * interval rather than on every alert tick.
 *
 * Dunning withdraws a plan after a payment failure, which must not happen
 * thirteen times an hour. Reconciliation is the safety net for webhooks that
 * never arrived, and there is no value in asking a provider more often than it
 * could plausibly have changed anything.
 */
function isDue(now: number, lastRun: number, intervalMinutes: number): boolean {
  return now - lastRun >= intervalMinutes * 60 * 1000;
}

/**
 * Re-verification is far slower than alert evaluation, so it only runs when
 * its own interval has elapsed. Alert evaluation runs every 15 minutes by
 * default, and querying the domain table four times an hour to find nothing
 * new is wasted database work.
 */
function reverificationIsDue(now: number): boolean {
  const intervalMs = Math.max(env.DOMAIN_REVERIFY_INTERVAL_MINUTES, 1) * 60 * 1000;
  return now - lastReverifyAt >= intervalMs;
}

/** Exposed so a test can assert the gating without waiting on real time. */
export function billingJobState(): { dunning: number; reconcile: number } {
  return { dunning: lastDunningAt, reconcile: lastReconcileAt };
}

export async function runAlertEvaluationOnce(): Promise<void> {
  if (running) {
    return;
  }

  running = true;
  try {
    // Every instance starts this scheduler on boot. The flag above only stops
    // one process overlapping itself, because Node is single threaded, so the
    // cross process gate has to live in the database.
    await withJobLease('alert-evaluation', () => runAlertEvaluationPass());
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown alert evaluation error.';
    console.error(`[alerts] evaluation failed: ${detail}`);
  } finally {
    running = false;
  }
}

/** The work itself, run only by the instance that won the lease. */
async function runAlertEvaluationPass(): Promise<void> {
  {
    const results = await evaluateAlertRules();
    const triggered = results.filter((result) => result.outcome === 'triggered').length;
    const escalated = results.filter((result) => result.outcome === 'escalated').length;
    const resolved = results.filter((result) => result.outcome === 'resolved').length;
    console.info(
      `[alerts] evaluated ${results.length} rules, ${triggered} triggered, ${escalated} escalated, ${resolved} resolved`,
    );

    const rollups = await runAlertRollups();
    const notified = rollups.filter((result) => result.notified).length;
    if (notified > 0) {
      console.info(`[alerts] sent ${notified} owner rollup(s)`);
    }

    const erasures = await executeDueErasures();
    if (erasures.length > 0) {
      console.info(`[erasure] completed ${erasures.length} due erasure request(s)`);
    }

    if (reverificationIsDue(Date.now())) {
      lastReverifyAt = Date.now();
      const reverified = await reverifyUnverifiedDomains();
      if (reverified.checked > 0) {
        console.info(
          `[domains] rechecked ${reverified.checked}, now verified ${reverified.verified}, lapsed ${reverified.failed}, still waiting ${reverified.stillPending}`,
        );
      }
    }

    const expiredIdempotency = await purgeExpiredIdempotencyRecords();
    if (expiredIdempotency > 0) {
      console.info(`[api] cleared ${expiredIdempotency} expired idempotency record(s)`);
    }

    if (isDue(Date.now(), lastDunningAt, env.BILLING_DUNNING_INTERVAL_MINUTES)) {
      lastDunningAt = Date.now();
      const dunning = await runDunning();
      if (dunning.warned > 0 || dunning.downgraded > 0) {
        console.info(
          `[billing] dunning examined ${dunning.examined}, ${dunning.warned} still retrying, ${dunning.downgraded} moved to the free plan`,
        );
      }
    }

    if (isDue(Date.now(), lastReconcileAt, env.BILLING_RECONCILE_INTERVAL_MINUTES)) {
      lastReconcileAt = Date.now();
      const reconciled = await runReconciliation();
      if (reconciled.repaired > 0 || reconciled.unreachable > 0) {
        console.info(
          `[billing] reconciliation examined ${reconciled.examined}, ${reconciled.repaired} repaired, ${reconciled.unreachable} unreachable`,
        );
      }
    }

    const digests = await runReportDigests();
    const digestSent = digests.filter((result) => result.sent).length;
    if (digestSent > 0) {
      console.info(`[digests] sent ${digestSent} client digest(s)`);
    }
  }
}

export function startAlertScheduler(): void {
  if (timer || env.ALERT_SCHEDULER_DISABLED) {
    return;
  }

  const intervalMs = Math.max(env.ALERT_EVALUATION_INTERVAL_MINUTES, 1) * 60 * 1000;
  timer = setInterval(() => {
    void runAlertEvaluationOnce();
  }, intervalMs);

  timer.unref?.();
  console.info(
    `[alerts] scheduler started, evaluating every ${env.ALERT_EVALUATION_INTERVAL_MINUTES} minutes, re-verifying every ${env.DOMAIN_REVERIFY_INTERVAL_MINUTES} minutes`,
  );
}

export function stopAlertScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

export async function shutdownAlertScheduler(): Promise<void> {
  stopAlertScheduler();
  await prisma.$disconnect();
}
