import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './database/prisma.js';
import { startAlertScheduler, stopAlertScheduler } from './scheduler/alert-scheduler.js';

if (env.NODE_ENV !== 'test') {
  const server = createApp().listen(env.PORT, () => {
    console.log(`DMARC Harbor API listening on port ${env.PORT}`);
  });

  startAlertScheduler();

  const shutdown = (): void => {
    stopAlertScheduler();
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
