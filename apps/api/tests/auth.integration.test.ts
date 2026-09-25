import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/database/pool.js';
import { app } from '../src/index.js';

const email = `owner-${Date.now()}@example.com`;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await pool.query('TRUNCATE TABLE "organization", invitation, member, session, account, verification, "user" CASCADE');
}

describe('authentication and workspaces', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await pool.end();
  });

  it('reports that the auth handler is available', async () => {
    const response = await request(app).get('/api/auth/ok');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('rejects unauthenticated session requests', async () => {
    const response = await request(app).get('/api/me');

    expect(response.status).toBe(401);
  });

  it('creates a user session and an agency workspace', async () => {
    const agent = request.agent(app);
    const signUp = await agent.post('/api/auth/sign-up/email').send({
      name: 'Workspace Owner',
      email,
      password,
    });

    expect(signUp.status).toBe(200);
    expect(signUp.body.user.email).toBe(email);

    const me = await agent.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);

    const createWorkspace = await agent.post('/api/workspaces').send({
      name: 'Harbor Security',
      slug: `harbor-security-${Date.now()}`,
    });

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
