import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { evaluateAlertRules, runAlertRollups } from '../services/alert.service.js';
import { runReportDigests } from '../services/report-digest.service.js';
import { executeDueErasures } from '../services/erasure/erasure.service.js';
import { reverifyUnverifiedDomains } from '../services/domain-reverify.service.js';
import { purgeExpiredIdempotencyRecords } from '../services/api-key.service.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
let lastReverifyAt = 0;

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

export async function runAlertEvaluationOnce(): Promise<void> {
  if (running) {
    return;
  }

  running = true;
  try {
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

    const digests = await runReportDigests();
    const digestSent = digests.filter((result) => result.sent).length;
    if (digestSent > 0) {
      console.info(`[digests] sent ${digestSent} client digest(s)`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown alert evaluation error.';
    console.error(`[alerts] evaluation failed: ${detail}`);
  } finally {
    running = false;
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
