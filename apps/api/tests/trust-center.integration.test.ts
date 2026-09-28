import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { grantPlan } from './helpers/plan.js';
import { setOverride } from '../src/services/entitlements/entitlement.service.js';
import type { PlanTier } from '@prisma/client';

/**
 * The public Trust Center.
 *
 * Two things are being defended here, and the second is the one that would end
 * the product.
 *
 * The first is the claim itself. The page states that this client's data cannot
 * be reached by anyone else, and an enterprise client reads that claim during
 * procurement. It has to be true, which is why the isolation suite runs first.
 *
 * The second is that the page only ever shows the client it belongs to. An
 * agency holds many clients, so a query scoped to the workspace rather than the
 * client would publish one customer's data on another customer's page, to the
 * public, permanently. That is a single unchecked query away, so the leak test
 * below builds a realistic workspace with several clients and asserts the
 * rendered payload contains only the right one.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setupWorkspace(plan: PlanTier = 'HARBOR') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `trust-${Date.now()}-${fixtureId}@example.com`;

  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Agency Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent
    .post('/api/workspaces')
    .send({ name: 'Northgate Digital', slug: `northgate-${Date.now()}-${fixtureId}` });
  const organizationId = workspace.body.id as string;

  if (plan !== 'MOORING') {
    await grantPlan(organizationId, plan);
  }

  return { agent, organizationId, email };
}

async function addClient(agent: ReturnType<typeof request.agent>, organizationId: string, name: string) {
  const created = await agent
    .post(`/api/workspaces/${organizationId}/clients`)
    .send({ name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${fixtureId}` });
  expect(created.status).toBe(201);
  return created.body as { id: string; name: string };
}

async function addDomain(agent: ReturnType<typeof request.agent>, organizationId: string, clientId: string, name: string) {
  const created = await agent.post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`).send({ name });
  expect(created.status).toBe(201);
  await prisma.domain.update({ where: { id: created.body.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } });
  return created.body.id as string;
}

describe('public Trust Center', () => {
  beforeAll(resetDatabase);

  it('publishes nothing on a plan that does not include it', async () => {
    const { agent, organizationId } = await setupWorkspace('FAIRWAY');
    const client = await addClient(agent, organizationId, 'Fairway Client');

    // Creating the link publishes a claim about this client's data, so it is
    // gated rather than a free toggle on every plan.
    const refused = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/trust-center`).send({});
    expect(refused.status).toBe(402);
    expect(refused.body.error.feature).toBe('trust.center');
    expect(refused.body.error.requiredIn).toBe('HARBOR');

    // Reading the status is harmless, so it is allowed.
    const status = await agent.get(`/api/workspaces/${organizationId}/clients/${client.id}/trust-center`);
    expect(status.status).toBe(200);
    expect(status.body.slug).toBeNull();
  });

  it('serves a published Trust Center with no authentication at all', async () => {
    const { agent, organizationId } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'Published Client');
    await addDomain(agent, organizationId, client.id, 'published-client.test');

    const created = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/trust-center`).send({});
    expect(created.status).toBe(200);
    expect(created.body.slug).toBeTruthy();

    // No session, no key, no headers. This is the auditor's request.
    const anonymous = request(app);
    const response = await anonymous.get(`/api/trust/${created.body.slug}`);

    expect(response.status).toBe(200);
    expect(response.body.client.name).toBe('Published Client');
    expect(response.body.client.domains).toEqual(['published-client.test']);
    expect(response.body.provider.workspaceName).toBe('Northgate Digital');
    expect(response.body.statement.isolation).toBeTruthy();
    expect(response.body.subProcessors.length).toBeGreaterThan(0);
  });

  it('publishes only its own client, never a sibling in the same workspace', async () => {
    const { agent, organizationId } = await setupWorkspace('HARBOR');

    // A realistic agency: several clients, each with domains and grants.
    const publicClient = await addClient(agent, organizationId, 'Acme Corporation');
    const secretClient = await addClient(agent, organizationId, 'Secret Client Holdings');
    const thirdClient = await addClient(agent, organizationId, 'Third Party Ltd');

    await addDomain(agent, organizationId, publicClient.id, 'acme.test');
    await addDomain(agent, organizationId, secretClient.id, 'secret-client.test');
    await addDomain(agent, organizationId, thirdClient.id, 'third-party.test');

    await agent
      .post(`/api/workspaces/${organizationId}/clients/${secretClient.id}/portal-access`)
      .send({ email: `secret-contact-${Date.now()}-${fixtureId}@example.com`, displayName: 'Confidential Contact' });

    const created = await agent.post(`/api/workspaces/${organizationId}/clients/${publicClient.id}/trust-center`).send({});
    expect(created.status).toBe(200);

    const response = await request(app).get(`/api/trust/${created.body.slug}`);
    expect(response.status).toBe(200);

    const body = JSON.stringify(response.body);

    // The page is public. Anything belonging to another client appearing here
    // would be a permanent public disclosure.
    expect(body).not.toContain('Secret Client Holdings');
    expect(body).not.toContain('secret-client.test');
    expect(body).not.toContain(secretClient.id);
    expect(body).not.toContain('Confidential Contact');
    expect(body).not.toContain('Third Party Ltd');
    expect(body).not.toContain('third-party.test');
    expect(body).not.toContain(thirdClient.id);

    // And it does contain its own, so the assertions above are not vacuous.
    expect(body).toContain('Acme Corporation');
    expect(body).toContain('acme.test');
  });

  it('names only this client portal contacts, not the agency roster', async () => {
    const { agent, organizationId, email } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'Granted Client');

    await agent
      .post(`/api/workspaces/${organizationId}/clients/${client.id}/portal-access`)
      .send({ email: `granted-${Date.now()}-${fixtureId}@example.com`, displayName: 'Named IT Contact' });

    const created = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/trust-center`).send({});
    const response = await request(app).get(`/api/trust/${created.body.slug}`);

    expect(response.status).toBe(200);
    const access = response.body.access as { role: string; canRead: string }[];

    // The contact is listed, and the statement of what they may read says so
    // explicitly, because "no forensic data" is the whole design decision.
    const contact = access.find((entry) => entry.role.includes('Named IT Contact'));
    expect(contact).toBeTruthy();
    expect(contact?.canRead.toLowerCase()).toContain('no forensic data');

    // A revoked contact disappears rather than lingering on a public page.
    const grants = await prisma.clientPortalAccess.findMany({ where: { clientId: client.id } });
    await prisma.clientPortalAccess.update({ where: { id: grants[0]!.id }, data: { revokedAt: new Date() } });

    const afterRevoke = await request(app).get(`/api/trust/${created.body.slug}`);
    expect(JSON.stringify(afterRevoke.body)).not.toContain('Named IT Contact');

    // The owning workspace's own address is not published as a contact either.
    expect(JSON.stringify(afterRevoke.body)).not.toContain(email);
  });

  it('quotes retention from the plan in force, not from marketing copy', async () => {
    const { agent, organizationId } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'Retained Client');
    const created = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/trust-center`).send({});

    const response = await request(app).get(`/api/trust/${created.body.slug}`);

    // Harbor is three years for data and audit.
    expect(response.body.retention.data).toBe('1095 days');
    expect(response.body.retention.audit).toBe('1095 days');
    expect(response.body.retention.deletionWindow).toContain('7 days');
  });

  it('states whether named recipient data is held, following the plan', async () => {
    const { agent, organizationId } = await setupWorkspace('FAIRWAY');
    await setOverride(organizationId, { entitlement: 'trust.center', enabled: true, reason: 'Test only.' });

    const client = await addClient(agent, organizationId, 'Named Data Client');
    const created = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/trust-center`).send({});
    expect(created.status).toBe(200);

    const onFairway = await request(app).get(`/api/trust/${created.body.slug}`);
    const categories = onFairway.body.dataHeld as { category: string; containsPersonalData: boolean }[];
    const namedOnFairway = categories.find((entry) => entry.category === 'Named recipients');

    // Fairway does not collect named recipients, so the page must not imply it
    // does. Overstating collection is as inaccurate as understating it.
    expect(namedOnFairway?.containsPersonalData).toBe(false);
  });

  it('withdraws the link, and a withdrawn page is indistinguishable from one that never existed', async () => {
    const { agent, organizationId } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'Revoked Client');
    const created = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/trust-center`).send({});

    expect((await request(app).get(`/api/trust/${created.body.slug}`)).status).toBe(200);

    const revoked = await agent.delete(`/api/workspaces/${organizationId}/clients/${client.id}/trust-center`);
    expect(revoked.status).toBe(200);

    const afterRevoke = await request(app).get(`/api/trust/${created.body.slug}`);
    const neverExisted = await request(app).get('/api/trust/this-slug-was-never-issued');

    // Identical answers. Otherwise the endpoint confirms which clients an
    // agency serves, which is the enumeration the slug exists to prevent.
    expect(afterRevoke.status).toBe(404);
    expect(neverExisted.status).toBe(404);
    expect(afterRevoke.body).toEqual(neverExisted.body);
  });

  it('will not publish a link for a client in another workspace', async () => {
    const mine = await setupWorkspace('HARBOR');
    const theirs = await setupWorkspace('HARBOR');
    const theirClient = await addClient(theirs.agent, theirs.organizationId, 'Their Client');

    // The client id is real and belongs to another agency. Only the workspace
    // check stands between this and overwriting someone else's link.
    const response = await mine.agent
      .post(`/api/workspaces/${mine.organizationId}/clients/${theirClient.id}/trust-center`)
      .send({});
    expect([403, 404]).toContain(response.status);

    const untouched = await prisma.client.findUniqueOrThrow({ where: { id: theirClient.id } });
    expect(untouched.trustSlug).toBeNull();
  });

  it('reuses the same link rather than invalidating one already shared', async () => {
    const { agent, organizationId } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'Idempotent Client');

    const first = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/trust-center`).send({});
    const second = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/trust-center`).send({});

    // Calling twice must not rotate the slug, because a link already forwarded
    // to an auditor would stop working for no reason.
    expect(second.body.slug).toBe(first.body.slug);
  });

  it('never returns a session, token or identifier belonging to a person', async () => {
    const { agent, organizationId, email } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'No Identifiers Client');
    const created = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/trust-center`).send({});

    const response = await request(app).get(`/api/trust/${created.body.slug}`);
    const body = JSON.stringify(response.body);

    // A public page must carry no personal identifiers, not even the agency's
    // own signing email.
    expect(body).not.toContain(email);
    expect(body).not.toContain('accessToken');
    expect(body).not.toContain('keyHash');
  });
});
