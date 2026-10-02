import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { app } from '../src/index.js';

describe('sign-in provider discovery', () => {
  it('answers without a session, because the sign-in page has none', async () => {
    // The only reader of this endpoint is the sign-in form. Requiring a session
    // would make it unreachable for the one screen it exists to render.
    const response = await request(app).get('/api/auth/providers');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      password: expect.any(Boolean),
      google: expect.any(Boolean),
      microsoft: expect.any(Boolean),
    });
  });

  it('returns nothing but booleans', async () => {
    const response = await request(app).get('/api/auth/providers');
    const values = Object.values(response.body) as unknown[];

    expect(values.every((value) => typeof value === 'boolean')).toBe(true);
  });

  it('hides the social buttons when no OAuth application is registered', async () => {
    // This is the state of a fresh checkout and of any deployment before the
    // OAuth apps exist, and it is the case that was 404ing.
    const response = await request(app).get('/api/auth/providers');

    expect(response.body.password).toBe(true);
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      expect(response.body.google).toBe(false);
    }
    if (!process.env.MICROSOFT_CLIENT_ID || !process.env.MICROSOFT_CLIENT_SECRET) {
      expect(response.body.microsoft).toBe(false);
    }
  });

  it('leaves the Better Auth handler reachable underneath it', async () => {
    // This endpoint is mounted at /api/auth ahead of Better Auth, which owns
    // that whole prefix. If that mount ever started answering more than it
    // should, sign-in would break in a way no other test would notice, because
    // the rest of the auth suite exercises /api/me rather than /api/auth/*.
    const response = await request(app).get('/api/auth/ok');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('does not turn the sign-in routes into a session-issuing surface', async () => {
    const response = await request(app).get('/api/auth/providers');
    const cookies = response.headers['set-cookie'];

    expect(cookies).toBeUndefined();
  });
});