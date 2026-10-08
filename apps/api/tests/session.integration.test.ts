import express, { Router } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { createSecureSessionRouterRateLimiter } from '../src/middleware/rate-limit.middleware.js';
import { rateLimitStoreFor } from '../src/middleware/postgres-rate-limit-store.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function createUser() {
  fixtureId += 1;
  const email = `sessions-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await request(app).post('/api/auth/sign-up/email').send({
    name: 'Session Owner',
    email,
    password,
  });
  expect(signUp.status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  return { email, password };
}

async function signIn(email: string, agentPassword = password) {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/sign-in/email').send({ email, password: agentPassword });
  expect(response.status).toBe(200);
  return agent;
}

describe('session management', () => {
  beforeAll(resetDatabase);

  it('requires authentication for every session endpoint', async () => {
    expect((await request(app).get('/api/me/sessions')).status).toBe(401);
    expect((await request(app).delete('/api/me/sessions/anything')).status).toBe(401);
    expect((await request(app).post('/api/me/sessions/revoke-others')).status).toBe(401);
    expect((await request(app).post('/api/me/sessions/revoke-all')).status).toBe(401);
  });

  it('lists every sign in and marks exactly one as current', async () => {
    const { email } = await createUser();
    const first = await signIn(email);
    const second = await signIn(email);

    const fromFirst = await first.get('/api/me/sessions');
    expect(fromFirst.status).toBe(200);
    expect(fromFirst.body.sessions).toHaveLength(2);
    expect(fromFirst.body.sessions.filter((session: { current: boolean }) => session.current)).toHaveLength(1);

    const fromSecond = await second.get('/api/me/sessions');
    const currentFromSecond = fromSecond.body.sessions.find((session: { current: boolean }) => session.current);
    const currentFromFirst = fromFirst.body.sessions.find((session: { current: boolean }) => session.current);
    expect(currentFromSecond.id).not.toBe(currentFromFirst.id);
  });

  it('never returns the session token', async () => {
    const { email } = await createUser();
    const agent = await signIn(email);
    await signIn(email);

    const response = await agent.get('/api/me/sessions');
    const serialized = JSON.stringify(response.body);

    expect(serialized).not.toContain('token');
    expect(response.body.sessions[0].token).toBeUndefined();
    expect(response.body.sessions[0]).not.toHaveProperty('token');
  });

  it('revokes another device and leaves the current one working', async () => {
    const { email } = await createUser();
    const first = await signIn(email);
    const second = await signIn(email);

    const listed = await first.get('/api/me/sessions');
    const other = listed.body.sessions.find((session: { current: boolean }) => !session.current);

    const revoked = await first.delete(`/api/me/sessions/${other.id}`);
    expect(revoked.status).toBe(204);

    const after = await first.get('/api/me/sessions');
    expect(after.body.sessions).toHaveLength(1);
    expect(after.body.sessions[0].current).toBe(true);

    expect((await first.get('/api/me/sessions')).status).toBe(200);
    expect((await second.get('/api/me/sessions')).status).toBe(401);
  });

  it('refuses to revoke the session in use', async () => {
    const { email } = await createUser();
    const agent = await signIn(email);

    const listed = await agent.get('/api/me/sessions');
    const current = listed.body.sessions.find((session: { current: boolean }) => session.current);

    const response = await agent.delete(`/api/me/sessions/${current.id}`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');

    expect((await agent.get('/api/me/sessions')).status).toBe(200);
  });

  it('never lets one user revoke another user session', async () => {
    const first = await createUser();
    const second = await createUser();
    const firstAgent = await signIn(first.email);
    await signIn(first.email);

    const listed = await firstAgent.get('/api/me/sessions');
    const victimSession = listed.body.sessions.find((session: { current: boolean }) => !session.current);

    const attacker = await signIn(second.email);
    const response = await attacker.delete(`/api/me/sessions/${victimSession.id}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect((await firstAgent.get('/api/me/sessions')).status).toBe(200);
  });

  it('signs out every other device but keeps the current one', async () => {
    const { email } = await createUser();
    const first = await signIn(email);
    const second = await signIn(email);
    const third = await signIn(email);

    const response = await first.post('/api/me/sessions/revoke-others');
    expect(response.status).toBe(200);
    expect(response.body.remaining).toBe(1);

    expect((await first.get('/api/me/sessions')).status).toBe(200);
    expect((await second.get('/api/me/sessions')).status).toBe(401);
    expect((await third.get('/api/me/sessions')).status).toBe(401);
  });

  it('signs out everywhere when asked', async () => {
    const { email } = await createUser();
    const first = await signIn(email);
    const second = await signIn(email);

    const response = await first.post('/api/me/sessions/revoke-all');
    expect(response.status).toBe(204);

    expect((await first.get('/api/me/sessions')).status).toBe(401);
    expect((await second.get('/api/me/sessions')).status).toBe(401);
    expect((await prisma.session.count({ where: { user: { email } } }))).toBe(0);
  });

  it('changes the password, rotates the current session, and evicts every other device', async () => {
    const { email } = await createUser();
    const first = await signIn(email);
    const second = await signIn(email);

    const response = await first.post('/api/auth/change-password').send({
      currentPassword: password,
      newPassword: 'a-much-better-password-2026',
      revokeOtherSessions: false,
    });

    expect(response.status).toBe(200);
    expect((await prisma.session.count({ where: { user: { email } } }))).toBe(1);
    expect((await second.get('/api/me/sessions')).status).toBe(401);

    const oldPassword = await request(app).post('/api/auth/sign-in/email').send({ email, password });
    expect(oldPassword.status).toBe(401);

    const newPassword = await request(app).post('/api/auth/sign-in/email').send({
      email,
      password: 'a-much-better-password-2026',
    });
    expect(newPassword.status).toBe(200);
  });

  it('rejects a wrong current password and a weak new one', async () => {
    const { email } = await createUser();
    const agent = await signIn(email);

    const wrongCurrent = await agent.post('/api/auth/change-password').send({
      currentPassword: 'definitely-not-the-password',
      newPassword: 'a-much-better-password-2026',
    });
    expect(wrongCurrent.status, 'wrong current password').toBe(400);

    const tooShort = await agent.post('/api/auth/change-password').send({
      currentPassword: password,
      newPassword: 'short1',
    });
    expect(tooShort.status, 'too short new password').toBe(400);

    const unchanged = await agent.post('/api/auth/change-password').send({
      currentPassword: password,
      newPassword: password,
    });
    expect(unchanged.status, 'unchanged password').toBe(400);

    const missing = await agent.post('/api/auth/change-password').send({ newPassword: 'a-much-better-password-2026' });
    expect(missing.status, 'missing current password').toBe(400);

    expect((await agent.get('/api/me/sessions')).status).toBe(200);
  });

  it('records every session action in the audit trail', async () => {
    const { email } = await createUser();
    const first = await signIn(email);
    await signIn(email);

    const listed = await first.get('/api/me/sessions');
    const other = listed.body.sessions.find((session: { current: boolean }) => !session.current);
    await first.delete(`/api/me/sessions/${other.id}`);
    await first.post('/api/me/sessions/revoke-others');
    await first.post('/api/auth/change-password').send({
      currentPassword: password,
      newPassword: 'audit-password-2026-x',
    });

    const actions = (await prisma.auditLog.findMany({ where: { actorUserId: { not: null } } })).map(
      (entry) => entry.action,
    );

    expect(actions).toContain('SESSION_REVOKED');
    expect(actions).toContain('SESSIONS_REVOKED_OTHERS');
    expect(actions).toContain('PASSWORD_CHANGED');
  });

  it('rate limits repeated revoke attempts', async () => {
    /**
     * Named explicitly rather than raised globally.
     *
     * The integration config lifts most budgets to 100000 because the shared
     * counters now survive between test files, and a limiter that is under test
     * cannot be lifted along with them. So this one is built at its own number
     * on a router of its own: the limit under test is the real limit, and the
     * library's own double-count protection still applies because a fresh store
     * instance is created for it.
     */
    const limit = 10;

    // Emptied first, and it has to be. The store is shared and lives in Postgres,
    // so the bucket survives both the rest of this run and the previous one. On
    // the second run the very first request was already over budget and the test
    // measured its own history rather than the limiter.
    await rateLimitStoreFor('session-router').resetAll();

    const isolated = Router();
    isolated.post('/revoke-others', (_request, response) => {
      response.json({ revoked: 0 });
    });

    // A bare Router is not something supertest can drive, so it is mounted on an
    // app. The limiter sits in front of the handler rather than being called per
    // request, which is how the real routes use it.
    const harness = express();
    harness.use(createSecureSessionRouterRateLimiter(limit));
    harness.use(isolated);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < limit + 5; attempt += 1) {
      const response = await request(harness).post('/revoke-others');
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.body.error.code).toBe('RATE_LIMITED');
        break;
      }
    }

    expect(statuses).toContain(429);
    // Exactly the budget, then refusal. An off-by-one either locks a legitimate
    // user out of revoking their own sessions or leaves the limit unenforced.
    expect(statuses.filter((status) => status === 200).length).toBe(limit);
  });
});
