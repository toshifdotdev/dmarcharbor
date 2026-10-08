import express, { Router } from 'express';
import { inboundReportController } from '../controllers/inbound-report.controller.js';
import { createReportIngestRateLimiter } from '../middleware/rate-limit.middleware.js';

const rawEmailParser = express.text({
  type: ['message/rfc822', 'text/plain'],
  limit: '10mb',
});

export const inboundReportRouter = Router();

inboundReportRouter.post(
  '/internal/reports/inbound',
  createReportIngestRateLimiter(),
  rawEmailParser,
  inboundReportController,
);
