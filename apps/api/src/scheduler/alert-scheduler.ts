import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { evaluateAlertRules } from '../services/alert.service.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

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
  console.info(`[alerts] scheduler started, evaluating every ${env.ALERT_EVALUATION_INTERVAL_MINUTES} minutes`);
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
