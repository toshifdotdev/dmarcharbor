import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';

const email = `owner-${Date.now()}@example.com`;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "organization", invitation, member, session, account, verification, "user" CASCADE');
}

describe('authentication and workspaces', () => {
  beforeAll(resetDatabase);

  it('reports that the auth handler is available', async () => {
    const response = await request(app).get('/api/auth/ok');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('rejects unauthenticated session requests', async () => {
    const response = await request(app).get('/api/me');

    expect(response.status).toBe(401);
  });

  it('requires email verification before creating a session and then creates an agency workspace', async () => {
    const agent = request.agent(app);
    const emailOutput = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      const signUp = await agent.post('/api/auth/sign-up/email').send({
        name: 'Workspace Owner',
        email,
        password,
      });

      expect(signUp.status).toBe(200);
      expect(signUp.body.user.email).toBe(email);

      const unverifiedSession = await agent.get('/api/me');
      expect(unverifiedSession.status).toBe(401);

      const unverifiedSignIn = await agent.post('/api/auth/sign-in/email').send({ email, password });
      expect(unverifiedSignIn.status).toBe(403);

      const verificationUrl = emailOutput.mock.calls
        .map(([message]) => String(message))
        .map((message) => message.match(/https?:\/\/[^\s]+\/api\/auth\/verify-email\?[^\s]+/)?.[0])
        .find((url): url is string => Boolean(url));

      expect(verificationUrl).toBeTruthy();
      const parsedVerificationUrl = new URL(verificationUrl as string);
      const verificationResponse = await agent.get(`${parsedVerificationUrl.pathname}${parsedVerificationUrl.search}`);
      expect([200, 302]).toContain(verificationResponse.status);

      const storedUser = await prisma.user.findUnique({ where: { email } });
      expect(storedUser?.emailVerified).toBe(true);
    } finally {
      emailOutput.mockRestore();
    }

    const me = await agent.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);

    const createWorkspace = await agent.post('/api/workspaces').send({
      name: 'Harbor Security',
      slug: `harbor-security-${Date.now()}`, dpaHasRead: true, dpaConfirmsAuthority: true});

    expect(createWorkspace.status).toBe(201);
    expect(createWorkspace.body.name).toBe('Harbor Security');
    expect(createWorkspace.body.id).toBeTruthy();

    const workspaces = await agent.get('/api/workspaces');
    expect(workspaces.status).toBe(200);
    expect(workspaces.body).toHaveLength(1);
    expect(workspaces.body[0].name).toBe('Harbor Security');

    const members = await agent.get(`/api/workspaces/${createWorkspace.body.id}/members`);
    expect(members.status).toBe(200);
    expect(members.body.total).toBe(1);
    expect(members.body.members).toHaveLength(1);
    expect(members.body.members[0].role).toBe('owner');
  });
});
