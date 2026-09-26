import { toNodeHandler } from 'better-auth/node';
import cors from 'cors';
import express from 'express';
import { auth } from './auth/auth.config.js';
import { env } from './config/env.js';
import { scanRouter } from './routes/scan.routes.js';
import { clientRouter } from './routes/client.routes.js';
import { domainScanRouter } from './routes/domain-scan.routes.js';
import { forensicRouter } from './routes/forensic.routes.js';
import { inboundReportRouter } from './routes/inbound-report.routes.js';
import { reportRouter } from './routes/report.routes.js';
import { sessionRouter } from './routes/session.routes.js';

export function createApp(): express.Express {
  const app = express();

  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
  app.all('/api/auth/*splat', toNodeHandler(auth));
  app.use('/api', inboundReportRouter);
  app.use('/api', reportRouter);
  app.use('/api', forensicRouter);
  app.use(express.json({ limit: '10kb' }));
  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', service: 'dmarcharbor-api' });
  });
  app.use('/api', sessionRouter);
  app.use('/api', clientRouter);
  app.use('/api', domainScanRouter);
  app.use('/api', scanRouter);

  return app;
}
