import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { ssoIdentifiersFor, callbackUrlsFor } from '../src/services/sso/sso-flow.service.js';

/**
 * The three backend prerequisites the frontend work was blocked on: the IdP
 * fields an administrator cannot configure SSO without, the document reference
 * the verifier link is built from, and server side enforcement of the alerting
 * entitlement.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "compliance_pack", "sso_auth_request", "sso_connection_domain", "sso_connection", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspaceOwner(label: string, plan?: string) {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });

  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const created = await agent.post('/api/workspaces').send({ name: 'Agency', slug: `${label}-${Date.now()}-${fixtureId}` });
  expect(created.status).toBe(201);
  const organizationId = created.body.id as string;
  const userId = created.body.userId as string | undefined;

  if (plan) {
    await prisma.subscription.upsert({
      where: { organizationId },
      create: { organizationId, plan: plan as never, status: 'ACTIVE', provider: 'NONE' },
      update: { plan: plan as never, status: 'ACTIVE' },
    });
    await prisma.organization.update({ where: { id: organizationId }, data: { plan: plan as never } });
  }

  const resolvedUserId =
    userId ??
    (
      await prisma.user.findFirstOrThrow({
        where: { members: { some: { organizationId } } },
        select: { id: true },
      })
    ).id;

  return { email, agent, organizationId, userId: resolvedUserId };
}

/** A verified domain, which both alert rules and compliance packs require. */
async function verifiedDomain(
  agent: ReturnType<typeof request.agent>,
  organizationId: string,
  name: string,
): Promise<string> {
  const label = name.split('.')[0] ?? 'client';
  const created = await agent
    .post(`/api/workspaces/${organizationId}/clients`)
    .send({ name: `${label} Client`, slug: `${label}-${Date.now()}-${fixtureId}`.toLowerCase().replace(/[^a-z0-9-]/g, '') });
  expect(created.status).toBe(201);
  const clientId = created.body.id as string;

  const domain = await agent.post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`).send({ name });
  expect(domain.status).toBe(201);

  await prisma.domain.update({
    where: { id: domain.body.id as string },
    data: { status: 'VERIFIED', verifiedAt: new Date() },
  });

  return domain.body.id as string;
}

describe('SSO identifiers an IdP configuration needs', () => {
  beforeAll(resetDatabase);

  it('produces an entity id that is stable for a connection and unique between them', () => {
    const first = ssoIdentifiersFor({ id: 'conn_a', issuer: 'https://idp.test', entryPoint: 'https://idp.test/sso' });
    const second = ssoIdentifiersFor({ id: 'conn_b', issuer: 'https://idp.test', entryPoint: 'https://idp.test/sso' });

    expect(first.entityId).toContain('conn_a');
    expect(first.entityId).not.toBe(second.entityId);
    // Stable, so rotating a certificate does not change the entity id an IdP has
    // already been configured with.
    expect(ssoIdentifiersFor({ id: 'conn_a', issuer: 'https://other.test', entryPoint: 'https://other.test/sso' }).entityId).toBe(
      first.entityId,
    );
  });

  it('surfaces the IdP entity id and login URL verbatim, because the IdP asks for them', () => {
    const identifiers = ssoIdentifiersFor({
      id: 'conn_c',
      issuer: 'https://idp.test/entity',
      entryPoint: 'https://idp.test/sso',
    });

    expect(identifiers.idpEntityId).toBe('https://idp.test/entity');
    expect(identifiers.loginUrl).toBe('https://idp.test/sso');
  });

  it('returns both callback URLs from APP_URL, not from the request host', () => {
    const urls = callbackUrlsFor('conn_d');
    expect(urls.saml).toMatch(/\/api\/sso\/conn_d\/saml\/acs$/);
    expect(urls.oidc).toMatch(/\/api\/sso\/conn_d\/callback$/);
  });

  it('includes the identifiers on a listed connection so the UI can render them', async () => {
    const owner = await workspaceOwner('sso-identifiers', 'ADMIRALTY');

    const created = await owner.agent.post(`/api/workspaces/${owner.organizationId}/sso-connections`).send({
      label: 'Okta',
      protocol: 'SAML',
      issuer: 'https://okta.test/entity',
      entryPoint: 'https://okta.test/sso',
      clientId: 'client-1',
      clientSecret: 'a-signing-secret-value',
      allowedEmailDomains: ['northgate.test'],
      defaultRole: 'analyst',
      provisioning: 'JIT',
    });
    expect(created.status).toBe(201);

    const listed = await owner.agent.get(`/api/workspaces/${owner.organizationId}/sso-connections`);
    expect(listed.status).toBe(200);

    const connection = listed.body.connections.find((c: { id: string }) => c.id === created.body.id);
    expect(connection).toBeDefined();
    expect(connection.callbackUrls.saml).toContain(`/api/sso/${created.body.id}/saml/acs`);
    expect(connection.entityId).toContain(created.body.id);
    expect(connection.idpEntityId).toBe('https://okta.test/entity');
    expect(connection.loginUrl).toBe('https://okta.test/sso');

    // The signing secret must still never come back out.
    expect(JSON.stringify(listed.body)).not.toContain('a-signing-secret-value');
  });
});

describe('compliance pack references are obtainable', () => {
  beforeAll(resetDatabase);

  it('returns the document reference in the list, so a verifier link can be built', async () => {
    const owner = await workspaceOwner('pack-reference', 'ADMIRALTY');

    const client = await owner.agent
      .post(`/api/workspaces/${owner.organizationId}/clients`)
      .send({ name: 'Acme Freight', slug: `acme-freight-${Date.now()}-${fixtureId}` });
    expect(client.status).toBe(201);
    const clientId = client.body.id as string;

    const domain = await owner.agent.post(`/api/workspaces/${owner.organizationId}/clients/${clientId}/domains`).send({
      name: 'example-freight.test',
    });
    expect(domain.status).toBe(201);
    await prisma.domain.update({
      where: { id: domain.body.id as string },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    });

    const issued = await owner.agent.post(
      `/api/workspaces/${owner.organizationId}/clients/${clientId}/compliance-packs`,
    );
    expect([200, 201]).toContain(issued.status);

    const listed = await owner.agent.get(`/api/workspaces/${owner.organizationId}/clients/${clientId}/compliance-packs`);
    expect(listed.status).toBe(200);

    const rows = listed.body.items ?? listed.body.packs ?? listed.body;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    expect(row).toBeDefined();
    // Without this the frontend passed the row id where the verifier looks up by
    // reference, so every verify link 404s and nothing on screen could fix it.
    expect(row.reference).toMatch(/^DMARC-\d{8}-ACME-FREIGHT-[A-Z0-9]{6}$/);

    // And the reference really does resolve through the public verifier.
    const verified = await request(app).get('/api/compliance-packs/verify').query({ reference: row.reference });
    expect(verified.status).toBe(200);
    expect(verified.body.found).toBe(true);
    expect(verified.body.packs[0].reference).toBe(row.reference);
    expect(verified.body.packs[0].sha256).toBe(row.hash);
  });
});

describe('alerting is enforced where the money is', () => {
  beforeAll(resetDatabase);

  it('refuses to create an alert rule on the free plan', async () => {
    const owner = await workspaceOwner('alerts-free');
    const domainId = await verifiedDomain(owner.agent, owner.organizationId, 'free.test');

    const response = await owner.agent.post(`/api/workspaces/${owner.organizationId}/alert-rules`).send({
      name: 'Free plan rule',
      domainId,
      metric: 'FAILURE_RATE',
      operator: 'GREATER_THAN',
      threshold: 5,
      recipientUserIds: [owner.userId],
    });

    // The gate used to live only in the web app, so a free workspace could create
    // rules by calling the API directly and then be sent the emails for nothing.
    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    expect(response.body.error.feature).toBe('alerts.email');
  });

  it('allows an alert rule on a paid plan', async () => {
    const owner = await workspaceOwner('alerts-paid', 'HARBOR');
    const domainId = await verifiedDomain(owner.agent, owner.organizationId, 'paid.test');

    const response = await owner.agent.post(`/api/workspaces/${owner.organizationId}/alert-rules`).send({
      name: 'Paid plan rule',
      domainId,
      metric: 'FAILURE_RATE',
      operator: 'GREATER_THAN',
      threshold: 5,
      recipientUserIds: [owner.userId],
    });

    expect(response.status).toBe(201);
    expect(response.body.name ?? response.body.rule?.name).toBe('Paid plan rule');
  });

  it('still lets a downgraded workspace read the alerts it already earned', async () => {
    const owner = await workspaceOwner('alerts-downgraded', 'HARBOR');
    const domainId = await verifiedDomain(owner.agent, owner.organizationId, 'downgrade.test');

    const created = await owner.agent.post(`/api/workspaces/${owner.organizationId}/alert-rules`).send({
      name: 'Earned before the downgrade',
      domainId,
      metric: 'FAILURE_RATE',
      operator: 'GREATER_THAN',
      threshold: 5,
      recipientUserIds: [owner.userId],
    });
    expect(created.status).toBe(201);

    // Downgrade mid month.
    await prisma.organization.update({ where: { id: owner.organizationId }, data: { plan: 'MOORING' } });
    await prisma.subscription.updateMany({ where: { organizationId: owner.organizationId }, data: { plan: 'MOORING' } });

    const rules = await owner.agent.get(`/api/workspaces/${owner.organizationId}/alert-rules`);
    expect(rules.status).toBe(200);
    // Withholding these would hide the history that explains why they were charged.
    expect(JSON.stringify(rules.body)).toContain('Earned before the downgrade');

    const events = await owner.agent.get(`/api/workspaces/${owner.organizationId}/alerts`);
    expect(events.status).toBe(200);
  });
});

describe('idempotency is scoped per workspace', () => {
  beforeAll(resetDatabase);

  it('lets two workspaces hold the same key without colliding', async () => {
    const first = await workspaceOwner('idem-scope-a', 'HARBOR');
    const second = await workspaceOwner('idem-scope-b', 'HARBOR');
    const key = `shared_key_${Date.now()}`;

    await prisma.idempotencyRecord.create({
      data: { key, organizationId: first.organizationId, requestHash: 'hash_a', statusCode: 201, responseBody: { secret: 'a' } },
    });
    await prisma.idempotencyRecord.create({
      data: { key, organizationId: second.organizationId, requestHash: 'hash_b', statusCode: 201, responseBody: { secret: 'b' } },
    });

    const rows = await prisma.idempotencyRecord.findMany({ where: { key }, select: { organizationId: true, responseBody: true } });
    // The same key held by two workspaces used to be impossible, which is what
    // merged everyone's retry namespace into one and let a second workspace
    // overwrite the first one's stored response body.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.responseBody as { secret: string }).secret).sort()).toEqual(['a', 'b']);
  });
});