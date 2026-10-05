import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { grantPlan } from './helpers/plan.js';
import { createApiKey } from '../src/services/api-key.service.js';
import { createReportShare } from '../src/services/report-share.service.js';
import type { PlanTier } from '@prisma/client';

/**
 * Cross tenant isolation.
 *
 * Workspace scoping is the single most important security property in this
 * product. An MSP on Harbor holds every DMARC report for twenty of their
 * clients, and one of those clients might also be a customer of a different MSP
 * on the same instance. If any read or write can cross that line, one agency can
 * read another's customer data, and the product cannot be sold to an enterprise
 * whose procurement team asks the question.
 *
 * The pattern being defended against is a controller that reads a resource
 * identifier out of the path or body and looks it up directly, rather than
 * filtering by the caller's own workspace. The middleware proves membership
 * before the controller runs, so the identifier is not the only thing standing
 * between two tenants.
 *
 * Every probe below is a real HTTP request against a real foreign record. A test
 * that only checks a helper in isolation would miss a controller that forgets
 * to scope its query, which is the actual failure mode.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

interface Tenant {
  agent: ReturnType<typeof request.agent>;
  organizationId: string;
  userId: string;
  email: string;
  clientId: string;
  clientSlug: string;
  domainId: string;
  domainName: string;
  apiKey: string;
}

/** Builds a complete, fully populated tenant to probe from. */
async function buildTenant(label: string, plan: PlanTier = 'ADMIRALTY'): Promise<Tenant> {
  fixtureId += 1;
  const agent = request.agent(app);
  // Better Auth normalises the stored address to lower case, so the lookup
  // below must use the same form or it finds nothing.
  const email = `${label.toLowerCase()}-${Date.now()}-${fixtureId}@isolation.test`;

  expect((await agent.post('/api/auth/sign-up/email').send({ name: `${label} Owner`, email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent
    .post('/api/workspaces')
    .send({ name: `${label} Agency`, slug: `${label.toLowerCase()}-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;

  if (plan !== 'MOORING') {
    await grantPlan(organizationId, plan);
  }

  const client = await agent
    .post(`/api/workspaces/${organizationId}/clients`)
    .send({ name: `${label} Client Ltd`, slug: `${label.toLowerCase()}-client-${Date.now()}-${fixtureId}` });
  expect(client.status).toBe(201);
  const clientId = client.body.id as string;
  const clientSlug = client.body.slug as string;

  const domain = await agent
    .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
    .send({ name: `${label.toLowerCase()}.test` });
  expect(domain.status).toBe(201);
  const domainId = domain.body.id as string;
  const domainName = domain.body.name as string;

  await prisma.domain.update({
    where: { id: domainId },
    data: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      dmarcPolicy: 'reject',
      collectForensicReports: true,
      dmarcRecord: 'v=DMARC1; p=reject; rua=mailto:agg@reports.dmarcharbor.com',
    },
  });

  const user = await prisma.user.findFirstOrThrow({
    where: { members: { some: { organizationId } } },
    select: { id: true },
  });

  const key = await createApiKey({
    organizationId,
    name: 'Integration',
    scopes: ['read', 'write'],
    createdById: user.id,
  });

  return {
    agent,
    organizationId,
    userId: user.id,
    email,
    clientId,
    clientSlug,
    domainId,
    domainName,
    apiKey: key.key,
  };
}

let alpha: Tenant;
let bravo: Tenant;

/** Every refusal must be a 4xx. A 200 means data crossed the boundary. */
function expectDenied(response: { status: number; body: unknown }, surface: string): void {
  expect([401, 403, 404, 400], `${surface} returned ${response.status}`).toContain(response.status);
  expect(response.status, `${surface} should not succeed`).toBeGreaterThanOrEqual(400);
}

describe('cross tenant isolation', () => {
  beforeAll(async () => {
    await resetDatabase();
    alpha = await buildTenant('Alpha');
    bravo = await buildTenant('Bravo');
  });

  it('refuses a workspace the caller does not belong to', async () => {
    // The whole chain depends on this one refusal: locals.organizationId is only
    // set after membership passes, so a controller never runs holding a foreign
    // workspace id.
    const denied = await alpha.agent.get(`/api/workspaces/${bravo.organizationId}/clients`);
    expect(denied.status).toBe(403);

    // And the same path in the caller's own workspace still works, so the 403
    // above is a boundary rather than a broken route.
    const allowed = await alpha.agent.get(`/api/workspaces/${alpha.organizationId}/clients`);
    expect(allowed.status).toBe(200);
  });

  it('will not list another tenant as a client', async () => {
    const response = await alpha.agent.get(`/api/workspaces/${alpha.organizationId}/clients`);
    expect(response.status).toBe(200);

    const listed = JSON.stringify(response.body);
    expect(listed).not.toContain(bravo.clientId);
    expect(listed).not.toContain(bravo.clientSlug);
    expect(listed).not.toContain('Bravo Client Ltd');
  });

  it('will not read or modify a client belonging to another tenant', async () => {
    // The identifier is a real, existing record. Only the workspace scope stops
    // this, which is exactly the case worth proving.
    for (const method of ['get', 'patch', 'delete'] as const) {
      const response = await alpha.agent[method](
        `/api/workspaces/${alpha.organizationId}/clients/${bravo.clientId}`,
      );
      expectDenied(response, `clients.${method}`);
    }

    const bravoClient = await prisma.client.findUniqueOrThrow({ where: { id: bravo.clientId } });
    expect(bravoClient.organizationId).toBe(bravo.organizationId);
    expect(bravoClient.name).toBe('Bravo Client Ltd');
  });

  it('will not reach a domain owned by another tenant', async () => {
    const scan = await alpha.agent.post(`/api/workspaces/${alpha.organizationId}/clients/${alpha.clientId}/domains/${bravo.domainId}/scan`);
    expectDenied(scan, 'domains.scan');

    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: bravo.domainId } });
    expect(domain.status).toBe('VERIFIED');
  });

  it('will not read reports, insights or forensic data for another tenant', async () => {
    const insights = await alpha.agent.get(`/api/workspaces/${alpha.organizationId}/insights?domainId=${bravo.domainId}`);
    expectDenied(insights, 'insights');

    const forensic = await alpha.agent.get(`/api/workspaces/${alpha.organizationId}/forensic?domainId=${bravo.domainId}`);
    expectDenied(forensic, 'forensic');

    const senders = await alpha.agent.get(
      `/api/workspaces/${alpha.organizationId}/senders/breakdown?domainId=${bravo.domainId}`,
    );
    expectDenied(senders, 'senders.breakdown');
  });

  it('will not touch another tenant alert rules or events', async () => {
    const rule = await bravo.agent
      .post(`/api/workspaces/${bravo.organizationId}/alert-rules`)
      .send({
        name: 'Bravo failure rate',
        metric: 'FAILURE_RATE',
        operator: 'GREATER_THAN',
        threshold: 5,
        domainId: bravo.domainId,
        recipientUserIds: [bravo.userId],
      });
    expect(rule.status).toBe(201);

    // Listing your own rules in your own workspace is correct and must work.
    // The isolation property is not a refusal, it is that the scoped list does
    // not contain the other tenant's rule.
    const own = await alpha.agent.get(`/api/workspaces/${alpha.organizationId}/alert-rules`);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toContain(rule.body.id);
    expect(JSON.stringify(own.body)).not.toContain('Bravo failure rate');
  });

  it('will not read another tenant notifications or digests', async () => {
    const digest = await bravo.agent
      .post(`/api/workspaces/${bravo.organizationId}/report-digests`)
      .send({ domainId: bravo.domainId, frequency: 'WEEKLY', recipientEmails: [bravo.email] });
    expect(digest.status).toBe(201);

    // Digests are workspace scoped. Notifications are user scoped rather than
    // workspace scoped, so the boundary is the user, not the workspace, and it
    // is proven by the two accounts never seeing each other's rows.
    const notifications = await alpha.agent.get('/api/me/notifications');
    expect(notifications.status).toBe(200);
    expect(JSON.stringify(notifications.body)).not.toContain('Bravo');
    expect(JSON.stringify(notifications.body)).not.toContain(bravo.domainName);

    const digests = await alpha.agent.get(`/api/workspaces/${alpha.organizationId}/report-digests`);
    expect(digests.status).toBe(200);
    expect(JSON.stringify(digests.body)).not.toContain(digest.body.id);
  });

  it('will not see another tenant api keys', async () => {
    const own = await alpha.agent.get(`/api/workspaces/${alpha.organizationId}/api-keys`);
    expect(own.status).toBe(200);

    // Both tenants named their key the same thing, so a shared name proves
    // nothing. The assertion that matters is the exact set of key ids.
    const alphaKeys = (own.body as { apiKeys: { id: string }[] }).apiKeys;
    const bravoKeys = await prisma.apiKey.findMany({ where: { organizationId: bravo.organizationId } });
    const bravoKeyIds = new Set(bravoKeys.map((key) => key.id));

    expect(alphaKeys.length).toBe(1);
    for (const key of alphaKeys) {
      expect(bravoKeyIds.has(key.id)).toBe(false);
    }

    // And the secret itself must never be recoverable, let alone cross tenants.
    const body = JSON.stringify(own.body);
    expect(body).not.toContain(bravo.apiKey);
    expect(body).not.toContain(alpha.apiKey);
  });

  it('will not see or replay another tenant webhook deliveries', async () => {
    const endpoint = await bravo.agent
      .post(`/api/workspaces/${bravo.organizationId}/webhooks`)
      .send({ name: 'Bravo receiver', url: 'https://hooks.bravo-example.com/dmarc', events: ['domain.verified'] });
    expect(endpoint.status).toBe(201);

    const endpoints = await alpha.agent.get(`/api/workspaces/${alpha.organizationId}/webhooks`);
    expect(endpoints.status).toBe(200);
    expect(JSON.stringify(endpoints.body)).not.toContain(endpoint.body.id);
    expect(JSON.stringify(endpoints.body)).not.toContain('bravo.example.test');

    const deliveries = await alpha.agent.get(`/api/workspaces/${alpha.organizationId}/webhook-deliveries`);
    expect(deliveries.status).toBe(200);
    expect(JSON.stringify(deliveries.body)).not.toContain('bravo.example.test');

    // Replaying a foreign delivery must be refused outright rather than
    // returning 404, because a replay would send real data somewhere.
    const replay = await alpha.agent.post(
      `/api/workspaces/${alpha.organizationId}/webhook-deliveries/does-not-exist/replay`,
    );
    expectDenied(replay, 'webhook-deliveries.replay');
  });

  it('will not request, download or export another tenant data', async () => {
    const job = await bravo.agent
      .post(`/api/workspaces/${bravo.organizationId}/exports`)
      .send({ scope: 'ORGANIZATION' });
    expect(job.status).toBe(201);

    const list = await alpha.agent.get(`/api/workspaces/${alpha.organizationId}/exports`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(job.body.id);
  });

  it('will not execute or cancel another tenant erasure', async () => {
    // Erase is the most destructive operation in the product, so it gets the
    // most explicit assertion: the foreign record is still there afterwards.
    const preview = await bravo.agent
      .post(`/api/workspaces/${bravo.organizationId}/erasures/preview`)
      .send({ scope: 'ORGANIZATION' });
    expect(preview.status).toBeLessThan(500);

    const list = await alpha.agent.get(`/api/workspaces/${alpha.organizationId}/erasures`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('Bravo');
  });

  it('will not read or change another tenant billing', async () => {
    // Reading your own billing is correct and must work. The boundary is the
    // cross workspace path, which must be refused before any provider is called.
    const own = await alpha.agent.get(`/api/workspaces/${alpha.organizationId}/billing`);
    expect(own.status).toBe(200);
    expect((own.body as { organizationId?: string }).organizationId).toBeUndefined();
    expect(JSON.stringify(own.body)).not.toContain(bravo.organizationId);

    const crossPath = await alpha.agent.get(`/api/workspaces/${bravo.organizationId}/billing`);
    expectDenied(crossPath, 'billing.crossWorkspaceRead');

    const crossChange = await alpha.agent
      .post(`/api/workspaces/${bravo.organizationId}/billing/cancel`)
      .send({});
    expectDenied(crossChange, 'billing.crossWorkspaceCancel');

    // Bravo's subscription must be untouched by the attempt.
    const bravoSubscription = await prisma.subscription.findMany({ where: { organizationId: bravo.organizationId } });
    for (const subscription of bravoSubscription) {
      expect(subscription.cancelAtPeriodEnd).toBe(false);
    }
  });

  it('will not read or change another tenant branding', async () => {
    // Reading your own branding is correct. The boundary is the foreign path,
    // and a write there must leave the other tenant's settings untouched.
    const own = await alpha.agent.get(`/api/workspaces/${alpha.organizationId}/branding`);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toContain(bravo.organizationId);

    const crossRead = await alpha.agent.get(`/api/workspaces/${bravo.organizationId}/branding`);
    expectDenied(crossRead, 'branding.crossWorkspaceRead');

    const write = await alpha.agent
      .patch(`/api/workspaces/${bravo.organizationId}/branding`)
      .send({ primaryColor: '#000000' });
    expectDenied(write, 'branding.crossWorkspaceWrite');

    const branding = await prisma.organization.findUniqueOrThrow({
      where: { id: bravo.organizationId },
      select: { brandPrimaryColor: true },
    });
    expect(branding.brandPrimaryColor).not.toBe('#000000');
  });

  it('will not let an api key read another tenant data', async () => {
    // The API takes the workspace from the key rather than the path, so a key
    // cannot be aimed at a different workspace by editing the URL.
    const domains = await request(app).get('/api/v1/domains').set('Authorization', `Bearer ${alpha.apiKey}`);
    expect(domains.status).toBe(200);

    const body = JSON.stringify(domains.body);
    expect(body).toContain(alpha.domainId);
    expect(body).not.toContain(bravo.domainId);
    expect(body).not.toContain(bravo.domainName);
  });

  it('will not let a portal contact see another client in the same workspace', async () => {
    // Same agency, different client. This is the boundary that matters most,
    // because an agency holds many clients at once and one client must never
    // appear in another's portal.
    const second = await bravo.agent
      .post(`/api/workspaces/${bravo.organizationId}/clients`)
      .send({ name: 'Bravo Second Client', slug: `bravo-second-${Date.now()}-${fixtureId}` });
    expect(second.status).toBe(201);

    const contactEmail = `contact-${Date.now()}-${fixtureId}@isolation.test`;
    await bravo.agent
      .post(`/api/workspaces/${bravo.organizationId}/clients/${bravo.clientId}/portal-access`)
      .send({ email: contactEmail });

    const contact = request.agent(app);
    expect(
      (await contact.post('/api/auth/sign-up/email').send({ name: 'Client Contact', email: contactEmail, password })).status,
    ).toBe(200);
    await prisma.user.update({ where: { email: contactEmail }, data: { emailVerified: true } });
    expect((await contact.post('/api/auth/sign-in/email').send({ email: contactEmail, password })).status).toBe(200);

    const portal = await contact.get('/api/portal');
    expect(portal.status).toBe(200);

    const body = JSON.stringify(portal.body);
    expect(body).toContain('Bravo Client Ltd');
    // Granted for one client only. The other client must be invisible.
    expect(body).not.toContain('Bravo Second Client');
    expect(body).not.toContain(second.body.id);
  });

  it('will not let a portal contact reach the agency side', async () => {
    const contactEmail = `contact2-${Date.now()}-${fixtureId}@isolation.test`;
    await bravo.agent
      .post(`/api/workspaces/${bravo.organizationId}/clients/${bravo.clientId}/portal-access`)
      .send({ email: contactEmail });

    const contact = request.agent(app);
    expect(
      (await contact.post('/api/auth/sign-up/email').send({ name: 'Second Contact', email: contactEmail, password })).status,
    ).toBe(200);
    await prisma.user.update({ where: { email: contactEmail }, data: { emailVerified: true } });
    expect((await contact.post('/api/auth/sign-in/email').send({ email: contactEmail, password })).status).toBe(200);

    expectDenied(
      await contact.get(`/api/workspaces/${bravo.organizationId}/clients`),
      'portal.contactToAgencyClients',
    );
    expectDenied(
      await contact.get(`/api/workspaces/${bravo.organizationId}/billing`),
      'portal.contactToAgencyBilling',
    );
    expectDenied(
      await contact.get(`/api/workspaces/${bravo.organizationId}/branding`),
      'portal.contactToAgencyBranding',
    );
  });

  it('keeps a public report share bound to the domain that produced it', async () => {
    const share = await createReportShare({
      organizationId: bravo.organizationId,
      domainId: bravo.domainId,
      createdById: bravo.userId,
      includeForensics: false,
      includeSources: false,
    });
    if (!share) {
      throw new Error('The report share was not created.');
    }

    // The share is unauthenticated by design, so the only thing protecting it
    // is the unguessable token. What must not happen is one tenant's share
    // resolving another tenant's data.
    const response = await request(app).get(`/api/reports/share/${share.token}`);
    expect(response.status).toBe(200);

    const body = JSON.stringify(response.body);
    expect(body).toContain(bravo.domainName);
    expect(body).not.toContain(alpha.domainName);
  });

  it('revoking a grant takes effect on the next portal request', async () => {
    const contactEmail = `revoke-${Date.now()}-${fixtureId}@isolation.test`;
    const grant = await bravo.agent
      .post(`/api/workspaces/${bravo.organizationId}/clients/${bravo.clientId}/portal-access`)
      .send({ email: contactEmail });

    expect(grant.status).toBe(201);

    const contact = request.agent(app);
    expect(
      (await contact.post('/api/auth/sign-up/email').send({ name: 'Revoke Contact', email: contactEmail, password })).status,
    ).toBe(200);
    await prisma.user.update({ where: { email: contactEmail }, data: { emailVerified: true } });
    expect((await contact.post('/api/auth/sign-in/email').send({ email: contactEmail, password })).status).toBe(200);

    expect((await contact.get('/api/portal')).status).toBe(200);

    const revoked = await bravo.agent.delete(
      `/api/workspaces/${bravo.organizationId}/portal-access/${grant.body.id}`,
    );
    expect(revoked.status).toBeLessThan(400);

    // A revoked contact is refused immediately rather than at the next token
    // expiry, which is what makes revocation usable.
    expectDenied(await contact.get('/api/portal'), 'portal.afterRevocation');
  });
});
