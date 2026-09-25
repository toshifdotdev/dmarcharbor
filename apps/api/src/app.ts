import cors from 'cors';
import express from 'express';
import { scanRouter } from './routes/scan.routes.js';

export function createApp(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10kb' }));
  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', service: 'dmarcharbor-api' });
  });
  app.use('/api', scanRouter);

  return app;
}
