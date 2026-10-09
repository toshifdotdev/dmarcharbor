import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { buildExportPayload } from '../src/services/export/export.service.js';
import { app } from '../src/index.js';

/**
 * An export that cannot carry everything says so.
 *
 * Every table in `buildExportPayload` used to be an unbounded `findMany`, and the
 * result was materialised and serialised into one response. A workspace with a
 * large window built an object in the hundreds of megabytes inside the request,
 * which is one export away from the process running out of memory and taking
 * every tenant with it.
 *
 * The bound is the fix, but the reason the flag is asserted here is that the
 * bound on its own would silently hand a customer part of their data while they
 * believed they asked for all of it. A short file that does not say it is short
 * is indistinguishable from a short file that is complete.
 */

const password = 'correct-horse-battery-staple';

async function setup(domainCount: number) {
  const email = `exp-limit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  expect(
    (await request(app).post('/api/auth/sign-up/email').send({ name: 'Limit Owner', email, password })).status,
  ).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const created = await agent.post('/api/workspaces').send({
    name: 'Limit Agency',
    slug: `exp-limit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  const organizationId = created.body.id as string;

  const client = await prisma.client.create({
    data: { organizationId, name: 'Limit Co', slug: `exp-limit-c-${Date.now()}` },
  });

  for (let index = 0; index < domainCount; index += 1) {
    await prisma.domain.create({
      data: {
        clientId: client.id,
        name: `limit-${index}-${Date.now()}.test`,
        slug: `limit-${index}-${Date.now()}-${index}`,
        status: 'VERIFIED' as const,
      },
    });
  }

  return { organizationId, clientId: client.id };
}

describe('an export reports what it could not carry', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "domain", "client", "organization", member, session, account, verification, "user" CASCADE',
    ).catch(() => undefined);
  });

  it('keeps meta clean when the whole scope fits', async () => {
    const { organizationId } = await setup(3);

    const payload = await buildExportPayload({
      organizationId,
      scope: 'ORGANIZATION',
      format: 'JSON',
      scopeLabel: 'Everything',
    });

    expect(payload.meta.limited).toBeUndefined();
    expect(payload.meta.limitedNotice).toBeUndefined();
    expect(payload.data.domains).toHaveLength(3);
  });

  it('names the table it had to truncate', async () => {
    // 20 050 rows against a 20 000 row ceiling. Created directly rather than
    // through the route so the number is exact rather than approximate.
    const { organizationId } = await setup(0);
    const clientId = (await prisma.client.findFirstOrThrow({ where: { organizationId } })).id;

    const stamp = Date.now();
    await prisma.$executeRaw`
      INSERT INTO "domain" ("id", "clientId", "name", "slug", "status", "verificationToken", "createdAt", "updatedAt")
      SELECT
        'trunc-' || ${stamp} || '-' || i,
        ${clientId},
        'trunc-' || ${stamp} || '-' || i || '.test',
        'trunc-' || ${stamp} || '-' || i,
        'VERIFIED'::"DomainStatus",
        gen_random_uuid()::text,
        NOW(),
        NOW()
      FROM generate_series(1, 20_050) AS i
    `;

    const payload = await buildExportPayload({
      organizationId,
      scope: 'ORGANIZATION',
      format: 'JSON',
      scopeLabel: 'Everything',
    });

    expect(payload.data.domains).toHaveLength(20_000);
    expect(payload.meta.limited).toContain('domains');
    expect(payload.meta.limitedNotice).toContain('support for the remainder');
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
