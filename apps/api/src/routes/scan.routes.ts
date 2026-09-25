import { Router } from 'express';
import { scanController } from '../controllers/scan.controller.js';
import { scanRateLimiter } from '../middleware/rate-limit.middleware.js';

export const scanRouter = Router();

scanRouter.post('/scan', scanRateLimiter, scanController);
