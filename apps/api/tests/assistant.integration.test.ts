import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanTier } from '@prisma/client';
import { app } from '../src/index.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/database/prisma.js';
import { resetAssistantState } from '../src/services/assistant/assistant.service.js';
import { purgeOldAssistantQuestions } from '../src/services/assistant/question-log.js';
import { grantPlan } from './helpers/plan.js';

/**
 * The product assistant over HTTP.
 *
 * Runs in links mode: no provider key is configured in CI, so nothing here
 * can reach the network. A run with a key in the environment skips the file
 * rather than spend money or depend on a third party.
 */

const keyConfigured = Boolean(env.ASSISTANT_API_KEY || env.ANTHROPIC_API_KEY);
const staffKey = 'test-staff-key-not-a-real-secret';
const password = 'correct-horse-battery-staple';
let fixtureId = 0;

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "assistant_question", "entitlement_override", "subscription", "audit_log", "notification", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspace(label: string, plan: PlanTier | null = 'HARBOR') {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const created = await agent.post('/api/workspaces').send({
    name: `${label} Agency`,
    slug: `${label}-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status).toBe(201);
  const organizationId = created.body.id as string;
  if (plan) await grantPlan(organizationId, plan);
  return { agent, organizationId };
}

const ask = (agent: ReturnType<typeof request.agent>, organizationId: string, question: unknown) =>
  agent.post(`/api/workspaces/${organizationId}/assistant/ask`).send({ question });

describe.skipIf(keyConfigured)('product assistant', () => {
  beforeEach(async () => {
    await resetDatabase();
    resetAssistantState();
  });

  it('is refused below Harbor, naming the plan that carries it', async () => {
    for (const plan of ['MOORING', 'FAIRWAY'] as const) {
      const below = await workspace(`assistant-${plan.toLowerCase()}`, plan === 'MOORING' ? null : plan);
      const intro = await below.agent.get(`/api/workspaces/${below.organizationId}/assistant`);
      expect(intro.status).toBe(402);
      expect(intro.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
      expect(intro.body.error.feature).toBe('assistant.docs');
      expect(intro.body.error.requiredIn).toBe('HARBOR');
      expect((await ask(below.agent, below.organizationId, 'How is Fleet priced?')).status).toBe(402);
    }
  });

  it('is on Harbor, Admiralty and Fleet, in links mode without a provider key', async () => {
    for (const plan of ['HARBOR', 'ADMIRALTY', 'FLEET'] as const) {
      const owner = await workspace(`assistant-${plan.toLowerCase()}`, plan);
      const intro = await owner.agent.get(`/api/workspaces/${owner.organizationId}/assistant`);
      expect(intro.status).toBe(200);
      expect(intro.body.mode).toBe('links');
      expect(intro.body.starters.length).toBeGreaterThan(0);
      expect(intro.body.support).toEqual({ url: '/support', email: 'support@dmarcharbor.com' });
    }
  });

  it('answers with the matching pages and says written answers are not enabled', async () => {
    const owner = await workspace('assistant-links');
    const response = await ask(owner.agent, owner.organizationId, 'How is Fleet priced?');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: 'links_only', reason: 'not_enabled', mode: 'links', answer: null });
    expect(response.body.message).toContain('not enabled on this deployment');
    expect(response.body.sources.map((source: { url: string }) => source.url)).toContain('/faq#plans-and-billing');
    expect(response.body.support.url).toBe('/support');
    // A matched question in links mode is not an unanswered one.
    expect(await prisma.assistantQuestion.count()).toBe(0);
  });

  it('says "I don\'t know" and logs the question, redacted, with no user or workspace', async () => {
    const owner = await workspace('assistant-unknown');
    const response = await ask(
      owner.agent,
      owner.organizationId,
      'Can jo@quellbrook-test.example deploy a Kubernetes ingress for quellbrook-test.example?',
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: 'unknown', reason: 'no_match', sources: [] });
    expect(response.body.message).toMatch(/^I don't know\./);

    const rows = await prisma.assistantQuestion.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('no_match');
    expect(rows[0]!.question).not.toContain('quellbrook');
    expect(rows[0]!.question).toContain('[email]');
    expect(rows[0]!.question).toContain('[domain]');

    // The table cannot hold workspace data: there is nowhere to put it.
    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'assistant_question'`,
    );
    expect(columns.map((c) => c.column_name).sort()).toEqual(['closestSourceIds', 'createdAt', 'id', 'question', 'reason']);
  });

  it('refuses questions outside the product, and logs them as refused', async () => {
    const owner = await workspace('assistant-refused');
    const response = await ask(owner.agent, owner.organizationId, 'Which other agencies use this?');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: 'refused', reason: 'other_customer' });
    expect(response.body.support.email).toBe('support@dmarcharbor.com');
    expect((await prisma.assistantQuestion.findFirst())?.reason).toBe('refused');
  });

  it('refuses empty, overlong and garbage questions with a reason', async () => {
    const owner = await workspace('assistant-input');
    const empty = await ask(owner.agent, owner.organizationId, '   ');
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatchObject({ code: 'INVALID_REQUEST', reason: 'empty' });
    const long = await ask(owner.agent, owner.organizationId, `How ${'about this '.repeat(80)}?`);
    expect(long.status).toBe(400);
    expect(long.body.error.reason).toBe('too_long');
    const garbage = await ask(owner.agent, owner.organizationId, 'zzzzzzzzzzzz');
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.reason).toBe('garbage');
    const notText = await ask(owner.agent, owner.organizationId, { nested: true });
    expect(notText.status).toBe(400);
  });

  it('refuses the same question asked over and over', async () => {
    const owner = await workspace('assistant-repeat');
    for (let i = 0; i < 3; i += 1) {
      expect((await ask(owner.agent, owner.organizationId, 'How is Fleet priced?')).status).toBe(200);
    }
    const repeated = await ask(owner.agent, owner.organizationId, 'how is fleet priced');
    expect(repeated.status).toBe(429);
    expect(repeated.body.error).toMatchObject({ code: 'RATE_LIMITED', reason: 'repeated' });
  });

  it('limits one person per minute', async () => {
    const owner = await workspace('assistant-limit');
    const limit = env.ASSISTANT_RATE_LIMIT_PER_MINUTE;
    for (let i = 0; i < limit; i += 1) {
      const ok = await ask(owner.agent, owner.organizationId, `How do I prove I manage a domain, question ${i + 1}?`);
      expect(ok.status, `question ${i + 1}`).toBe(200);
    }
    const over = await ask(owner.agent, owner.organizationId, 'How long until reports arrive?');
    expect(over.status).toBe(429);
    expect(over.body.error).toMatchObject({ code: 'RATE_LIMITED', reason: 'per_person' });
  });

  it('needs a session and membership of the workspace', async () => {
    const mine = await workspace('assistant-mine');
    const theirs = await workspace('assistant-theirs');
    expect((await request(app).post(`/api/workspaces/${mine.organizationId}/assistant/ask`).send({ question: 'Hi there?' })).status).toBe(401);
    expect((await ask(mine.agent, theirs.organizationId, 'How is Fleet priced?')).status).toBe(403);
    expect((await mine.agent.get(`/api/workspaces/${theirs.organizationId}/assistant`)).status).toBe(403);
  });

  it('lets staff read the unanswered questions, and only staff', async () => {
    const owner = await workspace('assistant-staff');
    await ask(owner.agent, owner.organizationId, 'How do I bake sourdough bread with a Kubernetes cluster?');
    await ask(owner.agent, owner.organizationId, 'hello');

    expect((await request(app).get('/api/staff/assistant/questions')).status).toBe(403);
    expect((await owner.agent.get('/api/staff/assistant/questions')).status).toBe(403);

    const all = await request(app).get('/api/staff/assistant/questions').set('Authorization', `Bearer ${staffKey}`);
    expect(all.status).toBe(200);
    expect(all.body.items.map((item: { reason: string }) => item.reason).sort()).toEqual(['no_match', 'refused']);
    for (const item of all.body.items) {
      expect(Object.keys(item).sort()).toEqual(['closestSourceIds', 'createdAt', 'id', 'question', 'reason']);
    }

    const refused = await request(app)
      .get('/api/staff/assistant/questions?reason=refused')
      .set('Authorization', `Bearer ${staffKey}`);
    expect(refused.body.items).toHaveLength(1);
    expect(refused.body.items[0].question).toBe('hello');

    const bad = await request(app).get('/api/staff/assistant/questions?reason=other').set('Authorization', `Bearer ${staffKey}`);
    expect(bad.status).toBe(400);
  });

  it('deletes unanswered questions after the retention window', async () => {
    const old = new Date(Date.now() - (env.ASSISTANT_QUESTION_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    await prisma.assistantQuestion.create({ data: { question: 'old one', reason: 'no_match', createdAt: old } });
    await prisma.assistantQuestion.create({ data: { question: 'new one', reason: 'no_match' } });

    expect(await purgeOldAssistantQuestions()).toBe(1);
    expect((await prisma.assistantQuestion.findMany()).map((row) => row.question)).toEqual(['new one']);
  });
});
