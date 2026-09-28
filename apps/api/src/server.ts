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
