import { env } from '../config/env.js';
import { evaluateAlertRules, runAlertRollups } from '../services/alert.service.js';
import { runReportDigests } from '../services/report-digest.service.js';
import { executeDueErasures } from '../services/erasure/erasure.service.js';
import { reverifyUnverifiedDomains } from '../services/domain-reverify.service.js';
import { purgeExpiredIdempotencyRecords } from '../services/api-key.service.js';
import { runDunning, runReconciliation } from '../billing/dunning.js';
import { repairWebhookEndpoints } from '../services/webhook.service.js';
import { acquireDueLease, withJobLease } from './job-lease.service.js';
import { recordJobFailure, recordJobSuccess } from './heartbeat.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
let lastReverifyAt = 0;
let lastDunningAt = 0;
let lastReconcileAt = 0;

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
    const summary = await withJobLease('alert-evaluation', () => runAlertEvaluationPass());

    /**
     * Only after the work finished.
     *
     * A skipped run, because another replica held the lease, is not a failure and
     * must not count as liveness either way: the replica doing the work is the one
     * that beats.
     */
    if (summary !== undefined) {
      recordJobSuccess('alert-evaluation');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown alert evaluation error.';
    console.error(`[alerts] evaluation failed: ${detail}`);
    recordJobFailure('alert-evaluation');
  } finally {
    running = false;
  }
}

/** The work itself, run only by the instance that won the lease. */
async function runAlertEvaluationPass(): Promise<{ completed: true }> {
  // The return value is what distinguishes "this pass ran" from "the lease was
  // held elsewhere", which is the distinction the heartbeat needs.
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

    // Dunning and reconciliation are leased on their own schedule rather than on
    // the alert tick, because they make provider API calls and must not run more
    // often than the interval says. The schedule lives in the database, so a
    // deploy neither loses it nor turns six hours into six minutes.
    const dunningLease = await acquireDueLease(
      'billing-dunning',
      Math.max(env.BILLING_DUNNING_INTERVAL_MINUTES, 1) * 60 * 1000,
    );

    if (dunningLease.acquired) {
      lastDunningAt = Date.now();
      const dunning = await runDunning();
      if (dunning.warned > 0 || dunning.downgraded > 0) {
        console.info(
          `[billing] dunning examined ${dunning.examined}, ${dunning.warned} still retrying, ${dunning.downgraded} moved to the free plan`,
        );
      }

      await dunningLease.release();
    }

    const reconcileLease = await acquireDueLease(
      'billing-reconciliation',
      Math.max(env.BILLING_RECONCILE_INTERVAL_MINUTES, 1) * 60 * 1000,
    );

    if (reconcileLease.acquired) {
      lastReconcileAt = Date.now();
      const reconciled = await runReconciliation();
      if (reconciled.repaired > 0 || reconciled.unreachable > 0) {
        console.info(
          `[billing] reconciliation examined ${reconciled.examined}, ${reconciled.repaired} repaired, ${reconciled.unreachable} unreachable`,
        );
      }

      await reconcileLease.release();
    }

    // Repairs a webhook integration that has died permanently, which nothing
    // else would ever look at again. On the persisted schedule so it is not
    // re-examined on every tick, and leased so the fleet does not all probe.
    const repairLease = await acquireDueLease('webhook-repair', 60 * 60 * 1000);
    if (repairLease.acquired) {
      const repaired = await repairWebhookEndpoints();
      if (repaired.endpointsProbed > 0 || repaired.deliveriesRequeued > 0) {
        console.info(
          `[webhooks] probed ${repaired.endpointsProbed} suspended endpoint(s), requeued ${repaired.deliveriesRequeued} dead delivery(ies)`,
        );
      }
      await repairLease.release();
    }

    const digests = await runReportDigests();
    const digestSent = digests.filter((result) => result.sent).length;
    if (digestSent > 0) {
      console.info(`[digests] sent ${digestSent} client digest(s)`);
    }

    return { completed: true };
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

/**
 * Not disconnecting the database.
 *
 * This used to close the Prisma pool here, and `server.ts` closes it again on the way
 * out. Two owners for one shutdown step means whichever runs first wins and the other
 * throws against an already closed pool, and on a SIGTERM during a deploy that is the
 * difference between a clean exit and an unhandled rejection. The connection is
 * process-wide, so it belongs in exactly one place.
 */
export async function shutdownAlertScheduler(): Promise<void> {
  stopAlertScheduler();
}
