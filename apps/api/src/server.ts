import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './database/pool.js';

if (env.NODE_ENV !== 'test') {
  const server = createApp().listen(env.PORT, () => {
    console.log(`DMARC Harbor API listening on port ${env.PORT}`);
  });

  const shutdown = (): void => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
