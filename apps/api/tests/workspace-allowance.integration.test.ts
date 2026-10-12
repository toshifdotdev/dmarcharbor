import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { grantPlan } from './helpers/plan.js';

/**
 * The workspace allowance.
 *
 * It did not exist: workspaces were unbounded, so every extra free workspace
 * carried its own client and its own two domains, which made the plan limits
 * above it decorative. The allowance is counted across every workspace a person
 * holds rather than within one, and it comes from the strongest plan they already
 * hold rather than the sum of their plans.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_log", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function account(label: string) {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });

  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  return { agent, userId: user.id };
}

async function createWorkspace(agent: request.Agent, label: string) {
  const response = await agent.post('/api/workspaces').send({
    name: label,
    slug: `${label.toLowerCase()}-${Date.now()}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  return response;
}

/** Workspaces this one account owns, which is what the allowance counts. */
async function workspacesOf(userId: string): Promise<string[]> {
  const orgs = await prisma.organization.findMany({
    where: { members: { some: { userId } } },
    select: { id: true },
  });
  return orgs.map((org) => org.id);
}

/**
 * Moves the account onto a plan through the same helper the rest of the suite
 * uses, rather than writing the workspace column directly.
 *
 * The plan now lives on the account, so a direct `organization.update` would set
 * the shadow and leave the allowance reading the old tier: the workspace would
 * look paid and the ceiling would still be the free one.
 */
async function setPlanFor(userId: string, plan: 'MOORING' | 'FAIRWAY' | 'HARBOR' | 'ADMIRALTY') {
  for (const id of await workspacesOf(userId)) {
    await grantPlan(id, plan);
  }
}

describe('workspace allowance', () => {
  beforeAll(resetDatabase);

  it('lets a free account create its one workspace', async () => {
    const { agent } = await account('allow-first');
    expect((await createWorkspace(agent, 'First')).status).toBe(201);
  });

  it('refuses a second workspace on the free plan, and names the limit', async () => {
    const { agent, userId } = await account('allow-free-cap');
    expect((await createWorkspace(agent, 'First')).status).toBe(201);

    const response = await createWorkspace(agent, 'Second');
    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe('WORKSPACE_LIMIT_REACHED');
    expect(response.body.error.limit).toBe(1);
    expect(response.body.error.used).toBe(1);

    // And nothing was created for this account: a refusal that leaves a workspace
    // behind is a success with an error message on it.
    expect(await workspacesOf(userId)).toHaveLength(1);
  });

  it('lets a paid account hold more, counted across every workspace it holds', async () => {
    const { agent, userId } = await account('allow-admiralty');

    expect((await createWorkspace(agent, 'First')).status).toBe(201);
    // The allowance is read from the strongest plan held, so the plan has to be
    // on a workspace before it raises the ceiling.
    await setPlanFor(userId, 'ADMIRALTY');

    expect((await createWorkspace(agent, 'Second')).status).toBe(201);
    expect((await createWorkspace(agent, 'Third')).status).toBe(201);
    expect((await createWorkspace(agent, 'Fourth')).status).toBe(201);
    expect((await createWorkspace(agent, 'Fifth')).status).toBe(201);

    const sixth = await createWorkspace(agent, 'Sixth');
    expect(sixth.status).toBe(402);
    expect(sixth.body.error.limit).toBe(5);
    expect(sixth.body.error.used).toBe(5);
    expect(await workspacesOf(userId)).toHaveLength(5);
  });

  it('counts the strongest plan held, not the sum of plans', async () => {
    const { agent, userId } = await account('allow-strongest');

    expect((await createWorkspace(agent, 'First')).status).toBe(201);
    await setPlanFor(userId, 'FAIRWAY');

    expect((await createWorkspace(agent, 'Second')).status).toBe(201);
    // Two Fairway workspaces would sum to four if the allowance were additive.
    // Fairway allows two, and this account already holds two.
    const third = await createWorkspace(agent, 'Third');
    expect(third.status).toBe(402);
    expect(third.body.error.limit).toBe(2);
    expect(await workspacesOf(userId)).toHaveLength(2);
  });

  it('does not count another account workspaces against this one', async () => {
    const mine = await account('allow-isolated-a');
    const theirs = await account('allow-isolated-b');

    // Fill the other account to its own cap.
    expect((await createWorkspace(theirs.agent, 'Theirs')).status).toBe(201);
    expect((await createWorkspace(theirs.agent, 'Theirs-second')).status).toBe(402);

    // Mine is untouched by theirs.
    expect((await createWorkspace(mine.agent, 'Mine')).status).toBe(201);
    expect(await workspacesOf(mine.userId)).toHaveLength(1);
  });
});
