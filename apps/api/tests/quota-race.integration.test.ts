import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { planCatalog } from '../src/services/entitlements/plan-catalog.js';
import { setOrganizationPlan, withQuota } from '../src/services/entitlements/entitlement.service.js';

/**
 * The domain limit under concurrency.
 *
 * `assertQuota` counted, then the caller inserted. In principle two requests
 * arriving together both read "one slot left", both passed, and both inserted,
 * leaving the workspace over its plan with no error raised anywhere. `withQuota`
 * counts and inserts under a row lock on the workspace, so they cannot interleave.
 *
 * What this file does *not* claim is worth stating, because it was measured: firing
 * two concurrent adds does not reliably reproduce the race on a single Node process
 * against a local Postgres. An attempt to demonstrate it by doing the check and the
 * insert separately let one of the two through, because the second request's count
 * landed after the first request's insert had committed. So the "two adds race for
 * the last slot" test below is a smoke test, not proof, and treating it as proof
 * would be the exact mistake this file exists to avoid.
 *
 * The proof that the lock is actually taken is `blocks while the workspace row is
 * locked`, which fails deterministically if the lock is absent.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_plan", "subscription", "entitlement_override", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspaceOnFreePlan(): Promise<{
  agent: ReturnType<typeof request.agent>;
  organizationId: string;
  clientId: string;
}> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `quota-${Date.now()}-${fixtureId}@example.com`;

  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Quota Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Quota Agency',
    slug: `quota-${Date.now()}-${fixtureId}`,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);

  const client = await agent
    .post(`/api/workspaces/${workspace.body.id}/clients`)
    .send({ name: 'Quota Client', slug: `qc-${Date.now()}-${fixtureId}` });
  expect(client.status).toBe(201);

  return { agent, organizationId: workspace.body.id as string, clientId: client.body.id as string };
}

describe('quota enforcement under concurrency', () => {
  beforeEach(resetDatabase);

  it('refuses one of two adds when only one slot is left', async () => {
    const { agent, organizationId, clientId } = await workspaceOnFreePlan();

    const limit = planCatalog.MOORING.maxActiveDomains;
    expect(limit).toBe(2);

    // Fill all but the last slot.
    for (let index = 0; index < limit - 1; index += 1) {
      const response = await agent
        .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
        .send({ name: `race-seed-${index}.test` });
      expect(response.status).toBe(201);
    }

    expect(await prisma.domain.count({ where: { client: { organizationId } } })).toBe(limit - 1);

    /**
     * A smoke test. The two adds are fired together, but as measured above this does
     * not reliably force the interleaving that would expose the old check-then-act
     * gap, so a pass here is consistent with either implementation.
     */
    const [first, second] = await Promise.all([
      agent.post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`).send({ name: 'race-a.test' }),
      agent.post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`).send({ name: 'race-b.test' }),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 402]);
    expect(await prisma.domain.count({ where: { client: { organizationId } } })).toBe(limit);
  });

  it('blocks while the workspace row is locked, which is the actual guarantee', async () => {
    const { organizationId, clientId } = await workspaceOnFreePlan();

    await prisma.domain.create({ data: { clientId, name: 'lock-seed.test', slug: 'lock-seed-0' } });

    /**
     * A second client, so this is genuinely a different connection.
     *
     * The same pool would hand back the busy connection and the lock would be taken
     * by the transaction that already holds it, which would prove nothing.
     */
    const blocker = new PrismaClient();

    try {
      const holding = blocker.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "organization" WHERE id = ${organizationId} FOR UPDATE`;
        // Holds the transaction, and therefore the lock, for two seconds. Cast
        // because `pg_sleep` returns void, which Prisma cannot deserialise, and the
        // failure would abandon the transaction still holding the lock.
        await tx.$queryRaw`SELECT pg_sleep(2)::text AS waited`;
      });

      // Give the lock time to actually be taken before measuring.
      await new Promise((wait) => setTimeout(wait, 300));

      const inflight = withQuota(organizationId, 'activeDomain', async (tx) =>
        tx.domain.create({ data: { clientId, name: 'blocked.test', slug: 'blocked-slug' } }),
      );

      let settled = false;
      void inflight.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await new Promise((wait) => setTimeout(wait, 600));
      expect(settled, 'withQuota completed while another connection held the workspace lock').toBe(false);

      await holding;

      /**
       * And it proceeds once the lock is gone, so this is serialisation rather than a
       * deadlock or a connection that never frees.
       */
      const created = await inflight;
      expect(created.name).toBe('blocked.test');
      expect(await prisma.domain.count({ where: { client: { organizationId } } })).toBe(2);
    } finally {
      await blocker.$disconnect();
    }
  });

  it('lets two adds both succeed when there is room for both', async () => {
    const { agent, organizationId, clientId } = await workspaceOnFreePlan();

    const [first, second] = await Promise.all([
      agent.post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`).send({ name: 'room-a.test' }),
      agent.post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`).send({ name: 'room-b.test' }),
    ]);

    // The lock serialises per workspace; it must not refuse work that fits.
    expect([first.status, second.status].sort()).toEqual([201, 201]);
    expect(await prisma.domain.count({ where: { client: { organizationId } } })).toBe(2);
  });

  it('does not let one workspace\'s usage affect another', async () => {
    const first = await workspaceOnFreePlan();
    const second = await workspaceOnFreePlan();

    for (let index = 0; index < 2; index += 1) {
      expect(
        (
          await first.agent
            .post(`/api/workspaces/${first.organizationId}/clients/${first.clientId}/domains`)
            .send({ name: `isolated-${index}.test` })
        ).status,
      ).toBe(201);
    }

    // The second workspace is empty and has its own full allowance.
    const response = await second.agent
      .post(`/api/workspaces/${second.organizationId}/clients/${second.clientId}/domains`)
      .send({ name: 'isolated-other.test' });

    expect(response.status).toBe(201);
    await setOrganizationPlan(first.organizationId, 'FAIRWAY', {
      status: 'ACTIVE',
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
  });
});