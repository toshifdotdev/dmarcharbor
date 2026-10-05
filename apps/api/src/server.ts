import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './database/prisma.js';
import { startAlertScheduler, stopAlertScheduler } from './scheduler/alert-scheduler.js';
import { startWebhookScheduler, stopWebhookScheduler } from './scheduler/webhook-scheduler.js';
import { startInboxScheduler, stopInboxScheduler } from './scheduler/inbox-scheduler.js';
import { startRetentionScheduler, stopRetentionScheduler } from './scheduler/retention-scheduler.js';
import { startEmailQueueScheduler, stopEmailQueueScheduler } from './scheduler/email-queue-scheduler.js';
import { checkSchemaIsCurrent } from './services/schema-check.service.js';

if (env.NODE_ENV !== 'test') {
  /**
   * Checked before the listener opens, so an instance on the wrong schema never
   * accepts a request rather than answering 500s on the first one that reads a column
   * it expects.
   */
  const schema = await checkSchemaIsCurrent();

  if (!schema.ok) {
    console.error(`[fatal] ${schema.detail}`);
    process.exit(1);
  }

  const server = createApp().listen(env.PORT, () => {
    console.log(`DMARC Harbor API listening on port ${env.PORT}`);
  });

  startAlertScheduler();
  startWebhookScheduler();
  startInboxScheduler();
  startRetentionScheduler();
  startEmailQueueScheduler();

  /**
   * Last line of defence against a silent death.
   *
   * Node's default since v15 is to treat an unhandled rejection as an uncaught
   * exception and terminate. Without these handlers a single floating promise
   * that rejects, on any route, at any hour, takes the process down for every
   * tenant at once and the orchestrator restarts it into the same fault. The
   * handlers make the cause explicit and exit non-zero so a crash loop is
   * visible to the platform rather than looking like a rolling restart.
   *
   * The message is logged first because the default reporter on an
   * uncaughtException can itself be the thing that was broken.
   */
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled promise rejection:', reason);
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    console.error('[fatal] uncaught exception:', error);
    process.exit(1);
  });

  /**
 * How long a shutdown is allowed to take before the process is killed anyway.
 *
 * A load balancer stops sending new requests the moment it sees the container go
 * unhealthy, but in-flight requests are still running. `server.close` waits for
 * them, which is correct and also unbounded: one slow report build or one wedged
 * database query holds the deploy open until the orchestrator's own grace period
 * expires, which then SIGKILLs mid-request.
 *
 * Thirty seconds is longer than the requests this service considers reasonable and
 * shorter than a typical platform grace period, so the drain normally finishes on
 * its own terms and the deadline is the backstop rather than the mechanism.
 */
const drainDeadlineMs = Number(process.env.SHUTDOWN_DRAIN_MS ?? 30_000);

const shutdown = (signal: string): void => {
  console.info(`[shutdown] ${signal} received, draining for up to ${drainDeadlineMs}ms`);

  // Timers first. Nothing new starts while the process is draining, and a webhook
  // delivery starting as we close the listener would add its own seconds.
  stopAlertScheduler();
  stopWebhookScheduler();
  stopInboxScheduler();
  stopRetentionScheduler();
    stopEmailQueueScheduler();

  // The deadline, armed before closing so it covers the drain and not just the
  // database close afterwards.
  const deadline = setTimeout(() => {
    console.error('[shutdown] drain deadline reached, exiting with requests still in flight');
    process.exit(1);
  }, drainDeadlineMs);
  deadline.unref?.();

  server.close(() => {
    void prisma
      .$disconnect()
      .catch((error: unknown) => {
        console.error('[shutdown] database close failed:', error instanceof Error ? error.message : error);
      })
      .finally(() => {
        clearTimeout(deadline);
        console.info('[shutdown] complete');
        process.exit(0);
      });
  });

  /**
   * Keeps a connection that never ends from holding the deploy open forever.
   *
   * Node's HTTP server has no idle timeout of its own, so a keep-alive connection
   * with no request on it will sit in `close` indefinitely. `closeIdleConnections`
   * drops the ones sitting between requests and leaves active ones alone.
   */
  server.closeIdleConnections?.();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
}
