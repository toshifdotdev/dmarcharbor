import { toNodeHandler } from 'better-auth/node';
import cors from 'cors';
import express from 'express';
import { auth } from './auth/auth.config.js';
import { env } from './config/env.js';
import { alertRouter } from './routes/alert.routes.js';
import { onboardingRouter, publicReportRouter } from './routes/onboarding.routes.js';
import { scanRouter } from './routes/scan.routes.js';
import { clientRouter } from './routes/client.routes.js';
import { entitlementRouter } from './routes/entitlement.routes.js';
import { exportRouter } from './routes/export.routes.js';
import { erasureRouter } from './routes/erasure.routes.js';
import { domainScanRouter } from './routes/domain-scan.routes.js';
import { forensicRouter } from './routes/forensic.routes.js';
import { inboundReportRouter } from './routes/inbound-report.routes.js';
import { notificationRouter } from './routes/notification.routes.js';
import { reportRouter } from './routes/report.routes.js';
import { sessionRouter } from './routes/session.routes.js';
import { sessionManagementRouter } from './routes/session-management.routes.js';
import { systemRouter } from './routes/system.routes.js';
import { requestContext } from './middleware/request-context.middleware.js';
import { sendError } from './utils/api-error.js';

export function createApp(): express.Express {
  const app = express();

  app.use(requestContext);
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
  app.all('/api/auth/*splat', toNodeHandler(auth));
  app.use('/api', systemRouter);
  app.use('/api', inboundReportRouter);
  app.use('/api', publicReportRouter);
  app.use('/api', reportRouter);
  app.use('/api', forensicRouter);
  app.use('/api', alertRouter);
  app.use('/api', onboardingRouter);
  app.use('/api', notificationRouter);
  app.use(express.json({ limit: '10kb' }));
  app.use('/api', sessionRouter);
  app.use('/api', sessionManagementRouter);
  app.use('/api', clientRouter);
  app.use('/api', entitlementRouter);
  app.use('/api', exportRouter);
  app.use('/api', erasureRouter);
  app.use('/api', domainScanRouter);
  app.use('/api', scanRouter);

  app.use('/api', (_request, response) => {
    sendError(response, 404, 'The requested endpoint does not exist.');
  });

  return app;
}
