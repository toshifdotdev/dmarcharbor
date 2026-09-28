import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { deliverDueWebhooks } from '../services/webhook.service.js';
import { withJobLease } from './job-lease.service.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

export const webhookIntervalSeconds = 30;

export async function runWebhookDeliveryOnce(): Promise<{ delivered: number; retry: number; failed: number }> {
  if (running) {
    return { delivered: 0, retry: 0, failed: 0 };
  }

  running = true;
  try {
    // Deliveries are already claimed row by row, so a second instance sending a
    // different delivery is not a correctness problem. This lease is about the
    // batch: it stops every replica scanning the same due rows every thirty
    // seconds, which is N times the database work for the same outcome.
    const summary = await withJobLease('webhook-delivery', async () => {
      const outcomes = await deliverDueWebhooks();
      const computed = {
        delivered: outcomes.filter((outcome) => outcome.status === 'DELIVERED').length,
        retry: outcomes.filter((outcome) => outcome.status === 'RETRY').length,
        failed: outcomes.filter((outcome) => outcome.status === 'FAILED').length,
      };

      if (outcomes.length > 0) {
        console.info(
          `[webhooks] attempted ${outcomes.length}, delivered ${computed.delivered}, retrying ${computed.retry}, gave up ${computed.failed}`,
        );
      }

      return computed;
    });

    // Undefined when another instance holds the lease, which is a skip rather
    // than a failure.
    return summary ?? { delivered: 0, retry: 0, failed: 0 };
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
