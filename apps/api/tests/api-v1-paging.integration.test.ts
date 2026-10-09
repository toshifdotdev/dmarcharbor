import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { createApiKey } from '../src/services/api-key.service.js';
import { grantPlan } from './helpers/plan.js';

/**
 * The public API stops returning every row it has.
 *
 * `GET /api/v1/domains` loaded every domain in a workspace and returned the whole
 * thing in one body. For an agency holding three thousand domains that is a
 * response measured in tens of megabytes, built and serialised inside the request,
 * which is one request away from the process running out of memory and taking
 * every tenant with it.
 *
 * The bounds are set by `parsePagination`, which is what every other list in this
 * codebase already used - these two were the ones that never got it.
 */

const password = 'correct-horse-battery-staple';

async function setup() {
  const email = `v1-page-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  expect(
    (await request(app).post('/api/auth/sign-up/email').send({ name: 'V1 Owner', email, password })).status,
  ).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const created = await agent.post('/api/workspaces').send({
    name: 'V1 Paging',
    slug: `v1-page-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  const organizationId = created.body.id as string;
  // The public API is a paid entitlement, so a free workspace cannot reach it and
  // every request here would be a 402 rather than a page.
  await grantPlan(organizationId, 'HARBOR');
  const client = await prisma.client.create({
    data: { organizationId, name: 'Paging Co', slug: `v1-page-c-${Date.now()}` },
  });

  await prisma.domain.createMany({
    data: Array.from({ length: 12 }, (_unused, index) => ({
      clientId: client.id,
      name: `page-${index}.test`,
      slug: `page-${index}-${Date.now()}`,
      status: 'VERIFIED' as const,
    })),
  });

  // The key is minted through the service rather than the route, because the
  // route needs a session and this test needs a usable key to exercise the
  // shaped request rather than the act of obtaining the key.
  const user = await prisma.user.findFirstOrThrow({
    where: { members: { some: { organizationId } } },
    select: { id: true },
  });
  const issued = await createApiKey({ organizationId, name: 'Paging', scopes: ['read'], createdById: user.id });
  const key = issued.key as string;

  return { organizationId, clientId: client.id, key };
}

describe('the public list endpoints are bounded', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "domain", "client", "api_key", "organization", member, session, account, verification, "user" CASCADE',
    );
  });

  it('returns a first page rather than everything the workspace holds', async () => {
    const { key } = await setup();

    const response = await request(app)
      .get('/api/v1/domains?limit=5')
      .set('Authorization', `Bearer ${key}`);

    expect(response.status).toBe(200);
    expect(response.body.domains).toHaveLength(5);
    expect(response.body.nextCursor).toBeTruthy();
  });

  it('walks to the end without repeating a row', async () => {
    const { key } = await setup();

    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page += 1) {
      const query = cursor ? `?limit=5&cursor=${encodeURIComponent(cursor)}` : '?limit=5';
      const response = await request(app)
        .get(`/api/v1/domains${query}`)
        .set('Authorization', `Bearer ${key}`);

      expect(response.status).toBe(200);
      seen.push(...response.body.domains.map((d: { id: string }) => d.id));
      cursor = response.body.nextCursor;
      if (!cursor) {
        break;
      }
    }

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it('refuses an unbounded limit rather than clamping it silently', async () => {
    const { key } = await setup();

    const response = await request(app)
      .get('/api/v1/domains?limit=100000')
      .set('Authorization', `Bearer ${key}`);

    // Refused rather than clamped, and refused rather than honoured: an
    // unbounded limit is the whole defect, and clamping in silence would give a
    // caller a page whose size is decided by the server.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
  });

  it('bounds the client list too, which loads every domain with it', async () => {
    const { key } = await setup();

    const response = await request(app)
      .get('/api/v1/clients?limit=2')
      .set('Authorization', `Bearer ${key}`);

    expect(response.status).toBe(200);
    expect(response.body.clients).toHaveLength(1);
  });
});
