import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { resolveEntitlements, setOrganizationPlan } from '../src/services/entitlements/entitlement.service.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "entitlement_override", "erasure_request", "subscription", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup() {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `entitle-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Ent Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Entitlement Agency',
    slug: `ent-${Date.now()}-${fixtureId}`,
  });
  expect(workspace.status).toBe(201);

  return { agent, organizationId: workspace.body.id as string, email };
}

async function addClient(agent: ReturnType<typeof request.agent>, organizationId: string) {
  const response = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name: 'Client',
    slug: `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return response;
}

async function addDomain(
  agent: ReturnType<typeof request.agent>,
  organizationId: string,
  clientId: string,
  name: string,
) {
  return agent.post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`).send({ name });
}

describe('plan entitlements', () => {
  beforeAll(resetDatabase);

  it('starts every new workspace on the free plan with no subscription', async () => {
    const { organizationId } = await setup();

    const entitlements = await resolveEntitlements(organizationId);
    expect(entitlements.plan).toBe('MOORING');
    expect(entitlements.label).toBe('Mooring');
    expect(entitlements.status).toBe('NONE');
    expect(entitlements.maxClients).toBe(1);
    expect(entitlements.maxActiveDomains).toBe(2);
  });

  it('serves the plan catalog without authentication', async () => {
    const response = await request(app).get('/api/plans');
    expect(response.status).toBe(200);
    expect(response.body.plans).toHaveLength(4);
    expect(response.body.order).toEqual(['MOORING', 'FAIRWAY', 'HARBOR', 'ADMIRALTY']);
  });

  it('exposes plans and the statutory floor through meta', async () => {
    const response = await request(app).get('/api/meta');
    expect(response.status).toBe(200);
    expect(response.body.plans).toHaveLength(4);
    expect(response.body.entitlements.alwaysAllowed).toEqual(['data.export', 'data.erase']);
  });

  it('lets the free plan create its one client then refuses the second with an upgrade path', async () => {
    const { agent, organizationId } = await setup();

    const first = await addClient(agent, organizationId);
    expect(first.status).toBe(201);

    const second = await addClient(agent, organizationId);
    expect(second.status).toBe(402);
    expect(second.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(second.body.error.quota).toBe('client');
    expect(second.body.error.used).toBe(1);
    expect(second.body.error.limit).toBe(1);
    expect(second.body.error.upgradeTo).toBe('FAIRWAY');
    expect(second.body.error.upgradeToLabel).toBe('Fairway');
    expect(second.body.error.message).toContain('Fairway');
  });

  it('allows more clients after an upgrade', async () => {
    const { agent, organizationId } = await setup();

    expect((await addClient(agent, organizationId)).status).toBe(201);
    expect((await addClient(agent, organizationId)).status).toBe(402);

    await setOrganizationPlan(organizationId, 'FAIRWAY');
    expect((await addClient(agent, organizationId)).status).toBe(201);
    expect((await addClient(agent, organizationId)).status).toBe(201);

    const entitlements = await resolveEntitlements(organizationId);
    expect(entitlements.plan).toBe('FAIRWAY');
    expect(entitlements.maxClients).toBe(5);
  });

  it('caps active domains on the free plan', async () => {
    const { agent, organizationId } = await setup();
    const client = await addClient(agent, organizationId);
    expect(client.status).toBe(201);

    expect((await addDomain(agent, organizationId, client.body.id, 'one.test')).status).toBe(201);
    expect((await addDomain(agent, organizationId, client.body.id, 'two.test')).status).toBe(201);

    const third = await addDomain(agent, organizationId, client.body.id, 'three.test');
    expect(third.status).toBe(402);
    expect(third.body.error.quota).toBe('activeDomain');
    expect(third.body.error.limit).toBe(2);
  });

  it('does not charge a domain that has been parked for longer than the grace period', async () => {
    const { agent, organizationId } = await setup();
    await setOrganizationPlan(organizationId, 'FAIRWAY');
    const client = await addClient(agent, organizationId);
    const clientId = client.body.id as string;

    for (const name of ['one.test', 'two.test', 'three.test', 'four.test']) {
      expect((await addDomain(agent, organizationId, clientId, name)).status).toBe(201);
    }

    expect(await prisma.domain.count({ where: { client: { organizationId } } })).toBe(4);

    await prisma.domain.updateMany({
      where: { client: { organizationId } },
      data: { createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
    });

    const after = await addDomain(agent, organizationId, clientId, 'five.test');
    expect(after.status).toBe(201);
  });

  it('still charges a domain created inside the grace period', async () => {
    const { agent, organizationId } = await setup();
    const client = await addClient(agent, organizationId);
    const clientId = client.body.id as string;

    expect((await addDomain(agent, organizationId, clientId, 'one.test')).status).toBe(201);
    expect((await addDomain(agent, organizationId, clientId, 'two.test')).status).toBe(201);
    expect((await addDomain(agent, organizationId, clientId, 'three.test')).status).toBe(402);
  });

  it('keeps charging for a domain that still receives reports', async () => {
    const { agent, organizationId } = await setup();
    await setOrganizationPlan(organizationId, 'FAIRWAY');
    const client = await addClient(agent, organizationId);
    const clientId = client.body.id as string;

    const first = await addDomain(agent, organizationId, clientId, 'live.test');
    expect(first.status).toBe(201);

    await prisma.domain.updateMany({
      where: { client: { organizationId } },
      data: { createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
    });

    await prisma.dmarcReport.create({
      data: {
        domainId: first.body.id,
        reportType: 'AGGREGATE',
        fingerprint: `fingerprint-${Date.now()}`,
        recordCount: 1,
        records: { create: { sourceIp: '10.0.0.1', messageCount: 10, dkimResult: 'pass', spfResult: 'pass' } },
      },
    });

    for (let index = 0; index < 20; index += 1) {
      await addDomain(agent, organizationId, clientId, `extra-${index}.test`);
    }

    const blocked = await addDomain(agent, organizationId, clientId, 'one-too-many.test');
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.quota).toBe('activeDomain');
  });

  it('refuses named forensic data below Harbor and allows it on Harbor', async () => {
    const { agent, organizationId } = await setup();
    const client = await addClient(agent, organizationId);
    const clientId = client.body.id as string;
    const domain = await addDomain(agent, organizationId, clientId, 'pii.test');

    const onFree = await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domain.body.id}/forensics/identities`)
      .send({ retainForensicPii: true, confirmLegalBasis: true });
    expect(onFree.status).toBe(402);
    expect(onFree.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    expect(onFree.body.error.feature).toBe('reports.forensicNamed');
    expect(onFree.body.error.requiredIn).toBe('HARBOR');

    await setOrganizationPlan(organizationId, 'HARBOR');
    const onHarbor = await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domain.body.id}/forensics/identities`)
      .send({ retainForensicPii: true, confirmLegalBasis: true });
    expect(onHarbor.status).toBe(200);
  });

  it('never paywalls export or erasure on the free plan', async () => {
    const { organizationId } = await setup();
    const entitlements = await resolveEntitlements(organizationId);

    expect(entitlements.features['data.export']).toBe(true);
    expect(entitlements.features['data.erase']).toBe(true);
  });

  it('records a plan change in the audit trail', async () => {
    const { agent, organizationId } = await setup();

    const changed = await agent.patch(`/api/workspaces/${organizationId}/plan`).send({
      plan: 'HARBOR',
      reason: 'Agency upgrade after trial',
    });
    expect(changed.status).toBe(200);
    expect(changed.body.plan).toBe('HARBOR');

    const events = await prisma.auditLog.findMany({ where: { organizationId, action: 'PLAN_CHANGED' } });
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({ from: 'MOORING', to: 'HARBOR', reason: 'Agency upgrade after trial' });
  });

  it('rejects an invalid plan change', async () => {
    const { agent, organizationId } = await setup();

    const invalid = await agent.patch(`/api/workspaces/${organizationId}/plan`).send({ plan: 'PLATINUM' });
    expect(invalid.status).toBe(400);
  });

  it('grants a temporary override and expires it automatically', async () => {
    const { agent, organizationId } = await setup();
    const client = await addClient(agent, organizationId);
    const domain = await addDomain(agent, organizationId, client.body.id, 'trial.test');

    const blocked = await agent.get(`/api/workspaces/${organizationId}/domains/${domain.body.id}/forensics`);
    expect(blocked.status).toBe(402);

    const override = await agent.post(`/api/workspaces/${organizationId}/entitlement-overrides`).send({
      entitlement: 'reports.forensic',
      enabled: true,
      reason: 'Comped for evaluation',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(override.status).toBe(200);
    expect(override.body.features['reports.forensic']).toBe(true);

    expect((await agent.get(`/api/workspaces/${organizationId}/domains/${domain.body.id}/forensics`)).status).toBe(200);

    await prisma.entitlementOverride.updateMany({
      where: { organizationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await agent.get(`/api/workspaces/${organizationId}/domains/${domain.body.id}/forensics`)).status).toBe(402);
  });

  it('lets an override be revoked and records both directions', async () => {
    const { agent, organizationId } = await setup();

    await agent.post(`/api/workspaces/${organizationId}/entitlement-overrides`).send({
      entitlement: 'api.access',
      enabled: true,
      reason: 'Pilot for a partner integration',
    });

    const removed = await agent.delete(
      `/api/workspaces/${organizationId}/entitlement-overrides/api.access`,
    );
    expect(removed.status).toBe(200);

    const set = await prisma.auditLog.findMany({
      where: { organizationId, action: 'ENTITLEMENT_OVERRIDE_SET' },
    });
    const cleared = await prisma.auditLog.findMany({
      where: { organizationId, action: 'ENTITLEMENT_OVERRIDE_REMOVED' },
    });
    expect(set).toHaveLength(1);
    expect(cleared).toHaveLength(1);
  });

  it('drops a cancelled plan to free once the paid period ends', async () => {
    const { organizationId } = await setup();

    await setOrganizationPlan(organizationId, 'HARBOR', {
      status: 'CANCELLED',
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    expect((await resolveEntitlements(organizationId)).plan).toBe('HARBOR');

    await prisma.subscription.updateMany({
      where: { organizationId },
      data: { currentPeriodEnd: new Date(Date.now() - 1000) },
    });
    expect((await resolveEntitlements(organizationId)).plan).toBe('MOORING');
  });

  it('keeps a trial on its trial plan while it is running', async () => {
    const { organizationId } = await setup();

    await setOrganizationPlan(organizationId, 'ADMIRALTY', {
      status: 'TRIALING',
      currentPeriodEnd: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });

    const entitlements = await resolveEntitlements(organizationId);
    expect(entitlements.plan).toBe('ADMIRALTY');
    expect(entitlements.status).toBe('TRIALING');
    expect(entitlements.features['api.access']).toBe(true);
  });

  it('lets a viewer read usage but never change the plan or see internal reasons', async () => {
    const { agent, organizationId, email } = await setup();

    await agent.post(`/api/workspaces/${organizationId}/entitlement-overrides`).send({
      entitlement: 'api.access',
      enabled: true,
      reason: 'comped for evaluation',
    });

    const asOwner = await agent.get(`/api/workspaces/${organizationId}/entitlements`);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.overrides[0].reason).toBe('comped for evaluation');

    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'viewer' } });
    const downgraded = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    await prisma.session.deleteMany({ where: { userId: downgraded.id } });

    const viewer = request.agent(app);
    expect((await viewer.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

    const asViewer = await viewer.get(`/api/workspaces/${organizationId}/entitlements`);
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.plan).toBe('MOORING');
    expect(asViewer.body.overrides[0].entitlement).toBe('api.access');
    expect(asViewer.body.overrides[0].reason).toBeUndefined();

    expect(
      (await viewer.patch(`/api/workspaces/${organizationId}/plan`).send({ plan: 'ADMIRALTY' })).status,
    ).toBe(403);
    expect(
      (
        await viewer.post(`/api/workspaces/${organizationId}/entitlement-overrides`).send({
          entitlement: 'api.access',
          enabled: true,
          reason: 'viewer should not do this',
        })
      ).status,
    ).toBe(403);
  });

  it('requires authentication for workspace entitlements', async () => {
    const { organizationId } = await setup();
    expect((await request(app).get(`/api/workspaces/${organizationId}/entitlements`)).status).toBe(401);
  });
});
