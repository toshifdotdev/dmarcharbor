import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

/**
 * Every 429 has the same JSON body.
 *
 * The scan limiter, and the report ingest one beside it, were created without a
 * `message`, so a refusal was express-rate-limit's default: plain text, "Too
 * many requests, please try again later." That is the one 429 an integration
 * calling `POST /api/v1/domains/{domain}/scans` is most likely to meet, and a
 * client that parses every error as `{ error: { code, message } }` failed on
 * it. Every other limiter already answered in JSON.
 *
 * The counters live in Postgres, which a unit test does not have, so the store
 * is replaced with one whose window is always spent: the first request through
 * any limiter is refused, and the refusal body is what is asserted. The limiters
 * are found by name, so a limiter added later without a body fails here.
 */
vi.mock('../src/middleware/postgres-rate-limit-store.js', () => {
  class SpentStore {
    // One instance per limiter, as the real store is, so the library's
    // double-count check does not mistake two limiters for one.
    readonly localKeys = true;

    async increment() {
      return { totalHits: 1_000_000, resetTime: new Date(Date.now() + 60_000) };
    }

    async decrement() {}

    async resetKey() {}
  }

  return { rateLimitStoreFor: () => new SpentStore() };
});

const limiters = await import('../src/middleware/rate-limit.middleware.js');

/** Limiter factories are called with their defaults; the rest are instances already. */
function everyLimiter(): { name: string; handler: RequestHandler }[] {
  return Object.entries(limiters)
    .filter(([name, value]) => name.endsWith('RateLimiter') && typeof value === 'function')
    .map(([name, value]) => ({
      name,
      handler: name.startsWith('create') ? (value as () => RequestHandler)() : (value as RequestHandler),
    }));
}

/** The path each limiter actually counts; the session-read one skips everything else. */
function pathFor(name: string): string {
  return name === 'createSessionReadRateLimiter' ? '/get-session' : '/probe';
}

describe('rate limit refusals', () => {
  it('finds the limiters, including the two that used to answer in plain text', () => {
    const names = everyLimiter().map((limiter) => limiter.name);

    expect(names).toContain('createScanRateLimiter');
    expect(names).toContain('createReportIngestRateLimiter');
    expect(names.length).toBeGreaterThan(10);
  });

  it.each(everyLimiter().map((limiter) => [limiter.name, limiter.handler] as const))(
    '%s answers 429 with the JSON error body and Retry-After',
    async (name, handler) => {
      const app = express();
      app.use(handler);
      app.get(/.*/, (_request, response) => {
        response.json({ reached: true });
      });

      const response = await request(app).get(pathFor(name));

      expect(response.status).toBe(429);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body?.error?.code).toBe('RATE_LIMITED');
      expect(typeof response.body?.error?.message).toBe('string');
      expect(response.body.error.message.length).toBeGreaterThan(0);
      expect(response.text).not.toContain('Too many requests, please try again later.');
      expect(response.headers['retry-after']).toBeDefined();
    },
  );

  it('tells the scan caller what was spent', async () => {
    const app = express();
    app.use(limiters.createScanRateLimiter(1));
    app.get('/probe', (_request, response) => {
      response.json({ reached: true });
    });

    const response = await request(app).get('/probe');

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many scans from this network. Wait a minute and try again.' },
    });
  });
});
