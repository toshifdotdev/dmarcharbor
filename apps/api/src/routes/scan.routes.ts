import { Router } from 'express';
import { scanController } from '../controllers/scan.controller.js';
import { createScanRateLimiter } from '../middleware/rate-limit.middleware.js';

export const scanRouter = Router();

scanRouter.post('/scan', createScanRateLimiter(), scanController);
