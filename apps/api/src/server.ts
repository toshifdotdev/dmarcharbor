import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './database/prisma.js';
import { startAlertScheduler, stopAlertScheduler } from './scheduler/alert-scheduler.js';
import { startWebhookScheduler, stopWebhookScheduler } from './scheduler/webhook-scheduler.js';
import { startInboxScheduler, stopInboxScheduler } from './scheduler/inbox-scheduler.js';

if (env.NODE_ENV !== 'test') {
  const server = createApp().listen(env.PORT, () => {
    console.log(`DMARC Harbor API listening on port ${env.PORT}`);
  });

  startAlertScheduler();
  startWebhookScheduler();
  startInboxScheduler();

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

  const shutdown = (): void => {
    stopAlertScheduler();
    stopWebhookScheduler();
    stopInboxScheduler();
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
