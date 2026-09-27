import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { deliverDueWebhooks } from '../services/webhook.service.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

export const webhookIntervalSeconds = 30;

export async function runWebhookDeliveryOnce(): Promise<{ delivered: number; retry: number; failed: number }> {
  if (running) {
    return { delivered: 0, retry: 0, failed: 0 };
  }

  running = true;
  try {
    const outcomes = await deliverDueWebhooks();
    const summary = {
      delivered: outcomes.filter((outcome) => outcome.status === 'DELIVERED').length,
      retry: outcomes.filter((outcome) => outcome.status === 'RETRY').length,
      failed: outcomes.filter((outcome) => outcome.status === 'FAILED').length,
    };

    if (outcomes.length > 0) {
      console.info(
        `[webhooks] attempted ${outcomes.length}, delivered ${summary.delivered}, retrying ${summary.retry}, gave up ${summary.failed}`,
      );
    }

    return summary;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown webhook delivery error.';
    console.error(`[webhooks] delivery failed: ${detail}`);
    return { delivered: 0, retry: 0, failed: 0 };
  } finally {
    running = false;
  }
}

export function startWebhookScheduler(): void {
  if (timer || env.ALERT_SCHEDULER_DISABLED) {
    return;
  }

  timer = setInterval(() => {
    void runWebhookDeliveryOnce();
  }, webhookIntervalSeconds * 1000);

  timer.unref?.();
  console.info(`[webhooks] delivery scheduler started, every ${webhookIntervalSeconds} seconds`);
}

export function stopWebhookScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

export async function shutdownWebhookScheduler(): Promise<void> {
  stopWebhookScheduler();
  await prisma.$disconnect();
}
