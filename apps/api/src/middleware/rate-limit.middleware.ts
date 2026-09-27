import rateLimit from 'express-rate-limit';

export const scanRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

export const reportIngestRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

export const secureSessionRouterRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many security requests. Wait a minute and try again.',
    },
  },
});

export const apiRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (request) => {
    const header = request.header('authorization');
    return header ? header.slice(-24) : request.ip ?? 'unknown';
  },
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many API requests. Wait a minute and try again.',
    },
  },
});

export const publicReportRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many report views. Try again shortly.',
    },
  },
});
