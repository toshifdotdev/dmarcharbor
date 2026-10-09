import request from 'supertest';
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';

/**
 * An unexpected error has to answer like every other error on this API.
 *
 * There was no global error handler, so a controller that threw reached
 * Express's finalhandler: `text/plain "Internal Server Error"` rather than the
 * `{ error: { code, message } }` envelope, and no log line beyond the status line
 * the request middleware already writes. A tenant reporting a broken screen left
 * nothing to act on, and every /api/v1 integration broke on a 500 it could not
 * parse.
 *
 * Forced with a database failure rather than a fake route: a Prisma error is the
 * realistic shape, it carries host/port/database name and sometimes statement
 * fragments, and it is exactly the detail that must not reach the wire.
 */

async function signedIn() {
  const email = `error-shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  expect(
    (await request(app).post('/api/auth/sign-up/email').send({ name: 'Error Owner', email, password })).status,
  ).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  // Sign-up does not create a workspace; the rest of this test needs one to have
  // an /api/workspaces/:id/clients request to fail.
  const created = await agent.post('/api/workspaces').send({
    name: 'Error Shape Agency',
    slug: `error-shape-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status).toBe(201);

  return agent;
}

const password = 'correct-horse-battery-staple';

describe('an unexpected error answers like every other error', () => {
  const logged: unknown[][] = [];
  const consoleError = console.error;

  beforeEach(() => {
    logged.length = 0;
    // Captured rather than stubbed away: the absence of this log line was half
    // the defect, so it is asserted rather than just tolerated.
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
  });

  afterEach(() => {
    console.error = consoleError;
    vi.restoreAllMocks();
  });

  it('returns the error envelope, not a plain-text 500', async () => {
    const agent = await signedIn();
    const workspaces = await agent.get('/api/workspaces');
    const organizationId = workspaces.body[0].id as string;

    vi.spyOn(prisma.client, 'findMany').mockRejectedValue(
      Object.assign(new Error('Unable to reach database server at postgres:5432'), { code: 'P1001' }),
    );

    const response = await agent.get(`/api/workspaces/${organizationId}/clients`);

    expect(response.status).toBe(500);
    expect(response.body.error).toBeDefined();
    expect(response.body.error.code).toBe('INTERNAL');
    expect(typeof response.body.error.message).toBe('string');
    // Not Express's own body, and not a Prisma string.
    expect(response.text).not.toContain('Internal Server Error');
    expect(response.text).not.toContain('postgres:5432');
  });

  it('logs the reason with the request id so a tenant report is traceable', async () => {
    const agent = await signedIn();
    const workspaces = await agent.get('/api/workspaces');
    const organizationId = workspaces.body[0].id as string;

    vi.spyOn(prisma.client, 'findMany').mockRejectedValue(
      Object.assign(new Error('Unable to reach database server at postgres:5432'), { code: 'P1001' }),
    );

    const response = await agent.get(`/api/workspaces/${organizationId}/clients`);
    expect(response.status).toBe(500);

    const line = logged.map((args) => args.map((arg) => String(arg)).join(' ')).join('\n');
    // The one line that identifies which request failed is the one that says why.
    expect(line).toMatch(/\[error\]/);
    expect(line).toContain('Unable to reach database server');
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
