import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { createApiKey, hashApiKey, verifyApiKey } from '../src/services/api-key.service.js';
import { grantPlan } from './helpers/plan.js';
import { setOverride } from '../src/services/entitlements/entitlement.service.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup(plan: 'MOORING' | 'FAIRWAY' | 'HARBOR' | 'ADMIRALTY' = 'HARBOR') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `api-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'API Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({ name: 'API Agency', slug: `api-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
  const organizationId = workspace.body.id as string;
  if (plan !== 'MOORING') {
    await grantPlan(organizationId, plan);
  }

  const user = await prisma.user.findFirstOrThrow({ where: { members: { some: { organizationId } } }, select: { id: true } });
  const key = await createApiKey({ organizationId, name: 'Integration', scopes: ['read', 'write'], createdById: user.id });

  return { agent, organizationId, userId: user.id, key: key.key, keyId: key.id };
}

describe('api keys', () => {
  beforeAll(resetDatabase);

  it('issues a key that is only ever shown once and stored as a hash', async () => {
    const { agent, organizationId, key } = await setup();

    const stored = await prisma.apiKey.findUniqueOrThrow({ where: { id: (await prisma.apiKey.findFirstOrThrow({ where: { organizationId } })).id } });
    expect(stored.keyHash).toBe(hashApiKey(key));
    expect(stored.keyHash).not.toBe(key);

    const list = await agent.get(`/api/workspaces/${organizationId}/api-keys`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect(list.body.apiKeys[0].prefix).toBe(stored.prefix);
  });

  it('only the owner may create or revoke a key', async () => {
    const { organizationId, userId } = await setup();
    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'admin' } });
    await prisma.session.deleteMany({ where: { userId } });

    const email = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email;
    const admin = request.agent(app);
    expect((await admin.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

    expect(
      (await admin.post(`/api/workspaces/${organizationId}/api-keys`).send({ name: 'Sneaky key', scopes: ['read'] })).status,
    ).toBe(403);
  });

  it('refuses a revoked key immediately', async () => {
    const { agent, organizationId, key, keyId } = await setup();

    expect((await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${key}`)).status).toBe(200);

    const revoked = await agent.delete(`/api/workspaces/${organizationId}/api-keys/${keyId}`);
    expect(revoked.status).toBe(204);

    expect((await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${key}`)).status).toBe(401);
  });

  it('refuses a missing, malformed or unknown key', async () => {
    expect((await request(app).get('/api/v1/clients')).status).toBe(401);
    expect((await request(app).get('/api/v1/clients').set('Authorization', 'Bearer not-a-key')).status).toBe(401);
    expect(
      (await request(app).get('/api/v1/clients').set('Authorization', 'Basic something')).status,
    ).toBe(401);
  });

  it('keeps a read scoped key away from writes', async () => {
    const { organizationId, userId } = await setup();
    const readOnly = await createApiKey({ organizationId, name: 'Read only', scopes: ['read'], createdById: userId });

    expect((await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${readOnly.key}`)).status).toBe(200);
    expect(
      (
        await request(app)
          .post('/api/v1/clients')
          .set('Authorization', `Bearer ${readOnly.key}`)
          .send({ name: 'Should not exist' })
      ).status,
    ).toBe(403);

    expect(await prisma.client.count({ where: { organizationId } })).toBe(0);
  });

  it('records use of a key and can resolve it directly', async () => {
    const { key } = await setup();
    await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${key}`);

    const resolved = await verifyApiKey(key);
    expect(resolved).toBeTruthy();
    expect(resolved?.scopes).toEqual(['read', 'write']);
  });

  it('never exposes one workspace through another workspace key', async () => {
    const first = await setup();
    const second = await setup();

    await request(app).post('/api/v1/clients').set('Authorization', `Bearer ${first.key}`).send({ name: 'First only' });

    const seenBySecond = await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${second.key}`);
    expect(seenBySecond.status, JSON.stringify(seenBySecond.body)).toBe(200);
    expect(seenBySecond.body.clients).toHaveLength(0);

    const seenByFirst = await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${first.key}`);
    expect(seenByFirst.body.clients).toHaveLength(1);
  });
});

describe('bulk onboarding', () => {
  beforeAll(resetDatabase);

  it('imports many clients with their domains in one call', async () => {
    const { key, organizationId } = await setup();

    const response = await request(app)
      .post('/api/v1/clients/bulk')
      .set('Authorization', `Bearer ${key}`)
      .send({
        clients: [
          { name: 'Acme Corp', domains: ['acme.com', 'acme.co.uk'] },
          { name: 'Beta Ltd', domains: ['beta.com'] },
          { name: 'Gamma Inc', domains: ['gamma.com', 'gamma.io', 'gamma.net'] },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.created).toBe(3);
    expect(response.body.failed).toBe(0);
    expect(response.body.planBlocked).toBe(0);

    const acme = response.body.clients[0];
    expect(acme.slug).toBe('acme-corp');
    expect(acme.domains).toHaveLength(2);

    for (const domain of acme.domains) {
      expect(domain.verificationHost).toBe(`_dmarc-harbor-verification.${domain.name}`);
      expect(domain.verificationValue).toMatch(/^dmarc-harbor-verification=/);
    }

    expect(await prisma.domain.count({ where: { client: { organizationId } } })).toBe(6);
  });

  it('skips a bad row and still creates the rest', async () => {
    const { key } = await setup();

    const response = await request(app)
      .post('/api/v1/clients/bulk')
      .set('Authorization', `Bearer ${key}`)
      .send({
        clients: [
          { name: 'Valid One', domains: ['valid1.test'] },
          { name: '', domains: [] },
          { name: 'Bad Domain', domains: ['not a domain'] },
          { name: 'Valid Two', domains: ['valid2.test'] },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.created).toBe(2);
    expect(response.body.failed).toBe(2);
    expect(response.body.failures.map((entry: { reason: string }) => entry.reason).join(' ')).toContain('required');
    expect(response.body.failures.some((entry: { reason: string }) => entry.reason.includes('not a usable domain'))).toBe(true);
  });

  it('reports plan limits rather than silently truncating', async () => {
    const { key, organizationId } = await setup('MOORING');
    // The API itself is not on Mooring, so the test grants just that feature.
    // The one client quota that makes this test meaningful is untouched.
    await setOverride(organizationId, { entitlement: 'api.access', enabled: true, reason: 'Test grants API access on a quota-limited plan.' });

    const response = await request(app)
      .post('/api/v1/clients/bulk')
      .set('Authorization', `Bearer ${key}`)
      .send({
        clients: [
          { name: 'First', domains: ['one.test'] },
          { name: 'Second', domains: ['two.test'] },
          { name: 'Third', domains: ['three.test'] },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.created).toBe(1);
    expect(response.body.planBlocked).toBe(2);
    expect(response.body.planLimitRejections[0].reason).toContain('Mooring');
  });

  it('rejects a batch larger than the hard cap', async () => {
    const { key } = await setup('ADMIRALTY');
    const clients = Array.from({ length: 201 }, (_, index) => ({ name: `Client ${index}` }));

    const response = await request(app)
      .post('/api/v1/clients/bulk')
      .set('Authorization', `Bearer ${key}`)
      .send({ clients });

    expect(response.status).toBe(402);
    expect(response.body.error.limit).toBe(200);
  });

  it('adds many domains to one client', async () => {
    const { key, organizationId } = await setup();
    const client = await prisma.client.create({
      data: { organizationId, name: 'Bulk Client', slug: 'bulk-client' },
      select: { id: true },
    });

    const response = await request(app)
      .post('/api/v1/domains/bulk')
      .set('Authorization', `Bearer ${key}`)
      .send({ clientId: client.id, domains: ['a.test', 'b.test', 'c.test', 'a.test'] });

    expect(response.status).toBe(201);
    expect(response.body.created).toBe(3);
    expect(response.body.failed).toBe(1);
    expect(response.body.failures[0].reason).toContain('already in this workspace');
  });

  it('refuses a client id from another workspace', async () => {
    const first = await setup();
    const second = await setup();

    const client = await prisma.client.create({
      data: { organizationId: first.organizationId, name: 'Foreign', slug: 'foreign' },
      select: { id: true },
    });

    const response = await request(app)
      .post('/api/v1/domains/bulk')
      .set('Authorization', `Bearer ${second.key}`)
      .send({ clientId: client.id, domains: ['x.test'] });

    expect(response.status).toBe(402);
    expect(await prisma.domain.count({ where: { name: 'x.test' } })).toBe(0);
  });

  it('replays a retried request instead of creating duplicates', async () => {
    const { key, organizationId } = await setup();
    const payload = { clients: [{ name: 'Idempotent Co', domains: ['idem.test'] }] };

    const first = await request(app)
      .post('/api/v1/clients/bulk')
      .set('Authorization', `Bearer ${key}`)
      .set('Idempotency-Key', 'ticket-4711')
      .send(payload);

    expect(first.status).toBe(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();

    const retry = await request(app)
      .post('/api/v1/clients/bulk')
      .set('Authorization', `Bearer ${key}`)
      .set('Idempotency-Key', 'ticket-4711')
      .send(payload);

    expect(retry.status).toBe(201);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect(retry.body.created).toBe(1);

    expect(await prisma.client.count({ where: { organizationId } })).toBe(1);
    expect(await prisma.domain.count({ where: { name: 'idem.test' } })).toBe(1);
  });

  it('records bulk imports in the audit trail', async () => {
    const { key, organizationId } = await setup();

    await request(app)
      .post('/api/v1/clients/bulk')
      .set('Authorization', `Bearer ${key}`)
      .send({ clients: [{ name: 'Audited Co', domains: ['audited.test'] }] });

    const events = await prisma.auditLog.findMany({ where: { organizationId, action: 'CLIENTS_BULK_IMPORTED' } });
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ created: 1, failed: 0, domains: 1 });
  });

  it('normalises a domain that was pasted with a scheme or a path', async () => {
    const { key, organizationId } = await setup();
    const client = await prisma.client.create({
      data: { organizationId, name: 'Normalise', slug: 'normalise' },
      select: { id: true },
    });

    const response = await request(app)
      .post('/api/v1/domains/bulk')
      .set('Authorization', `Bearer ${key}`)
      .send({ clientId: client.id, domains: ['https://HTTPS.Example.COM/mail', 'other.test'] });

    expect(response.body.created).toBe(2);
    expect(response.body.domains.map((entry: { name: string }) => entry.name)).toEqual([
      'https.example.com',
      'other.test',
    ]);
  });
});
