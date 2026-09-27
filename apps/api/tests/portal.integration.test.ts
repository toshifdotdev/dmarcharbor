import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { grantPlan } from './helpers/plan.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function createUser(email: string, name = 'Portal Person') {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/sign-up/email').send({ name, email, password });
  expect(response.status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  return { agent, email };
}

async function signIn(email: string) {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  return agent;
}

async function setup(plan: 'MOORING' | 'FAIRWAY' | 'HARBOR' | 'ADMIRALTY' = 'HARBOR') {
  fixtureId += 1;
  const ownerEmail = `owner-${Date.now()}-${fixtureId}@northgate.test`;
  const owner = await createUser(ownerEmail, 'Agency Owner');

  const workspace = await owner.agent.post('/api/workspaces').send({ name: 'Northgate Digital', slug: `ng-${Date.now()}-${fixtureId}` });
  const organizationId = workspace.body.id as string;
  if (plan !== 'MOORING') {
    await grantPlan(organizationId, plan);
  }

  const clients: { id: string; name: string; domainId: string }[] = [];
  for (const [index, label] of ['Acme Corp', 'Beta Ltd', 'Gamma Inc'].entries()) {
    const client = await owner.agent.post(`/api/workspaces/${organizationId}/clients`).send({
      name: label,
      slug: `client-${index}-${Date.now()}-${fixtureId}`,
    });
    expect(client.status).toBe(201);

    const domain = await owner.agent
      .post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`)
      .send({ name: `${label.split(' ')[0]!.toLowerCase()}.test` });
    expect(domain.status).toBe(201);

    await prisma.domain.update({ where: { id: domain.body.id }, data: { status: 'VERIFIED', verifiedAt: new Date(), dmarcPolicy: 'reject', score: 92 } });
    clients.push({ id: client.body.id as string, name: label, domainId: domain.body.id as string });
  }

  return { ...owner, organizationId, clients };
}

describe('client portal access', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('grants access by email, unbound until that person signs in', async () => {
    const { agent, organizationId, clients } = await setup();

    const granted = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`)
      .send({ email: 'IT@Acme.test', displayName: 'Acme IT Lead' });

    expect(granted.status).toBe(201);
    expect(granted.body.email).toBe('it@acme.test');
    expect(granted.body.bound).toBe(false);
    expect(granted.body.clientName).toBe('Acme Corp');
    expect(granted.body.notice).toContain('activates');
  });

  it('rejects a malformed email and a client that is not in the workspace', async () => {
    const { agent, organizationId, clients } = await setup();
    const other = await setup();

    expect(
      (await agent.post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`).send({ email: 'not-an-email' })).status,
    ).toBe(400);

    expect(
      (
        await agent
          .post(`/api/workspaces/${organizationId}/clients/${other.clients[0]!.id}/portal-access`)
          .send({ email: 'someone@other.test' })
      ).status,
    ).toBe(404);
  });

  it('is a Harbor feature and refused on the cheaper plans', async () => {
    const { agent, organizationId, clients } = await setup('FAIRWAY');

    const refused = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`)
      .send({ email: 'it@acme.test' });

    expect(refused.status).toBe(402);
    expect(refused.body.error.feature).toBe('portal.client');
    expect(refused.body.error.requiredIn).toBe('HARBOR');

    await grantPlan(organizationId, 'HARBOR');
    expect(
      (
        await agent
          .post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`)
          .send({ email: 'it@acme.test' })
      ).status,
    ).toBe(201);
  });

  it('refuses the portal to a signed in person with no grant', async () => {
    const contact = await createUser(`stranger-${Date.now()}@elsewhere.test`);

    const response = await contact.agent.get('/api/portal');
    expect(response.status).toBe(403);
    expect(response.body.error.message).toContain('invitation');
  });

  it('requires sign in', async () => {
    expect((await request(app).get('/api/portal')).status).toBe(401);
  });

  it('shows only the granted client, never the others', async () => {
    const { agent, organizationId, clients } = await setup();
    const contactEmail = `acme-it-${Date.now()}@acme.test`;

    await agent
      .post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`)
      .send({ email: contactEmail });

    const contact = await createUser(contactEmail);
    const overview = await contact.agent.get('/api/portal');

    expect(overview.status).toBe(200);
    expect(overview.body.workspace.name).toBe('Northgate Digital');
    expect(overview.body.clients).toHaveLength(1);
    expect(overview.body.clients[0].name).toBe('Acme Corp');
    expect(overview.body.totals.clients).toBe(1);
    expect(overview.body.totals.domains).toBe(1);
  });

  it('binds the grant on first sign in so the agency can see it was accepted', async () => {
    const { agent, organizationId, clients } = await setup();
    const contactEmail = `bind-${Date.now()}@acme.test`;

    const granted = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`)
      .send({ email: contactEmail });
    expect(granted.body.bound).toBe(false);

    await createUser(contactEmail);
    await signIn(contactEmail).then((c) => c.get('/api/portal'));

    const list = await agent.get(`/api/workspaces/${organizationId}/portal-access`);
    expect(list.status).toBe(200);
    expect(list.body.grants[0].bound).toBe(true);
    expect(list.body.grants[0].firstSeenAt).toBeTruthy();
  });

  it('never shows another client domain, even by guessing the identifier', async () => {
    const { agent, organizationId, clients } = await setup();
    const contactEmail = `guess-${Date.now()}@acme.test`;

    await agent
      .post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`)
      .send({ email: contactEmail });

    const contact = await createUser(contactEmail);

    const own = await contact.agent.get(`/api/portal/domains/${clients[0]!.domainId}`);
    expect(own.status).toBe(200);
    expect(own.body.domain.name).toBe('acme.test');

    for (const other of [clients[1]!, clients[2]!]) {
      const attempt = await contact.agent.get(`/api/portal/domains/${other.domainId}`);
      expect(attempt.status).toBe(404);
      expect(attempt.body.error.message).toContain('not available');
    }
  });

  it('gives the contact senders and spoofing warnings but never forensic data', async () => {
    const { agent, organizationId, clients } = await setup();
    const contactEmail = `senders-${Date.now()}@acme.test`;
    const domainId = clients[0]!.domainId;

    await prisma.dmarcReport.create({
      data: {
        domainId,
        reportType: 'AGGREGATE',
        fingerprint: `fp-portal-${Date.now()}`,
        recordCount: 2,
        records: {
          create: [
            { sourceIp: '10.0.0.1', messageCount: 100, dkimResult: 'pass', spfResult: 'pass', senderDomain: 'legit.test' },
            { sourceIp: '45.83.12.9', messageCount: 300, dkimResult: 'fail', spfResult: 'fail', senderDomain: 'evil.test' },
          ],
        },
      },
    });

    await agent
      .post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`)
      .send({ email: contactEmail });

    const contact = await createUser(contactEmail);
    const response = await contact.agent.get(`/api/portal/domains/${domainId}`);

    expect(response.status).toBe(200);
    expect(response.body.senders.length).toBeGreaterThan(0);
    expect(response.body.possibleSpoofingSources.length).toBeGreaterThan(0);
    expect(response.body.possibleSpoofingSources[0].senderDomain).toBe('evil.test');

    const serialised = JSON.stringify(response.body);
    expect(serialised.toLowerCase()).not.toContain('forensic');
    expect(serialised).not.toContain('recipient');
  });

  it('stops showing a client the moment the grant is revoked', async () => {
    const { agent, organizationId, clients } = await setup();
    const contactEmail = `revoke-${Date.now()}@acme.test`;

    const granted = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`)
      .send({ email: contactEmail });

    const contact = await createUser(contactEmail);
    expect((await contact.agent.get('/api/portal')).status).toBe(200);

    const revoked = await agent.delete(
      `/api/workspaces/${organizationId}/portal-access/${granted.body.id}`,
    );
    expect(revoked.status).toBe(204);

    expect((await contact.agent.get('/api/portal')).status).toBe(403);
    expect((await contact.agent.get(`/api/portal/domains/${clients[0]!.domainId}`)).status).toBe(403);
  });

  it('lets one contact hold grants for two clients and shows only those two', async () => {
    const { agent, organizationId, clients } = await setup();
    const contactEmail = `two-${Date.now()}@agency.test`;

    await agent.post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`).send({ email: contactEmail });
    await agent.post(`/api/workspaces/${organizationId}/clients/${clients[1]!.id}/portal-access`).send({ email: contactEmail });

    const contact = await createUser(contactEmail);
    const overview = await contact.agent.get('/api/portal');

    expect(overview.body.clients).toHaveLength(2);
    expect(overview.body.clients.map((client: { name: string }) => client.name).sort()).toEqual(['Acme Corp', 'Beta Ltd']);
    expect((await contact.agent.get(`/api/portal/domains/${clients[2]!.domainId}`)).status).toBe(404);
  });

  it('keeps a staff member from losing their own access through the portal', async () => {
    const { agent, organizationId, clients } = await setup();
    const contactEmail = `also-staff-${Date.now()}@northgate.test`;

    const staff = await createUser(contactEmail, 'Analyst At Agency');
    const staffUser = await prisma.user.findUniqueOrThrow({ where: { email: contactEmail }, select: { id: true } });
    await prisma.member.create({
      data: {
        id: `member-staff-${Date.now()}`,
        organizationId,
        userId: staffUser.id,
        role: 'analyst',
        createdAt: new Date(),
      },
    });

    await agent.post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`).send({ email: contactEmail });

    // The portal surface is scoped to the grant, even for a user with the
    // internal analyst role and its wider report permissions.
    const portal = await staff.agent.get('/api/portal');
    expect(portal.body.clients).toHaveLength(1);

    // Their internal permissions are untouched.
    const internal = await staff.agent.get(`/api/workspaces/${organizationId}/clients`);
    expect(internal.status).toBe(200);
    expect(Array.isArray(internal.body) ? internal.body.length : internal.body.clients.length).toBe(3);
  });

  it('never lets a contact list or revoke grants, or read billing', async () => {
    const { agent, organizationId, clients } = await setup();
    const contactEmail = `limited-${Date.now()}@acme.test`;

    await agent.post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`).send({ email: contactEmail });
    const contact = await createUser(contactEmail);

    expect((await contact.agent.get(`/api/workspaces/${organizationId}/portal-access`)).status).toBe(403);
    expect(
      (await contact.agent.post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`).send({ email: 'x@y.test' })).status,
    ).toBe(403);
    expect((await contact.agent.get(`/api/workspaces/${organizationId}/entitlements`)).status).toBe(403);
    expect((await contact.agent.get(`/api/workspaces/${organizationId}/api-keys`)).status).toBe(403);
  });

  it('records granting and revoking in the audit trail', async () => {
    const { agent, organizationId, clients } = await setup();

    const granted = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`)
      .send({ email: `audit-${Date.now()}@acme.test` });
    await agent.delete(`/api/workspaces/${organizationId}/portal-access/${granted.body.id}`);

    const actions = (
      await prisma.auditLog.findMany({
        where: { organizationId, targetId: { in: [granted.body.id] } },
      })
    ).map((entry) => entry.action);

    expect(actions).toEqual(expect.arrayContaining(['PORTAL_ACCESS_GRANTED', 'PORTAL_ACCESS_REVOKED']));
  });

  it('lists grants per client and reports inactive ones', async () => {
    const { agent, organizationId, clients } = await setup();
    const contactEmail = `listed-${Date.now()}@acme.test`;

    const granted = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`)
      .send({ email: contactEmail });
    await agent.delete(`/api/workspaces/${organizationId}/portal-access/${granted.body.id}`);

    const scoped = await agent.get(`/api/workspaces/${organizationId}/portal-access?clientId=${clients[0]!.id}`);
    expect(scoped.body.grants).toHaveLength(1);
    expect(scoped.body.grants[0].active).toBe(false);
  });

  it('restores a revoked grant when the contact is invited again', async () => {
    const { agent, organizationId, clients } = await setup();
    const contactEmail = `restore-${Date.now()}@acme.test`;

    const first = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`)
      .send({ email: contactEmail });
    await agent.delete(`/api/workspaces/${organizationId}/portal-access/${first.body.id}`);

    const again = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clients[0]!.id}/portal-access`)
      .send({ email: contactEmail });

    expect(again.status).toBe(201);
    expect(again.body.active).toBe(true);

    const contact = await createUser(contactEmail);
    expect((await contact.agent.get('/api/portal')).status).toBe(200);
  });
});
