import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { getDomain } from '../src/services/client.service.js';
import { grantPlan } from './helpers/plan.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspace(): Promise<{
  agent: ReturnType<typeof request.agent>;
  organizationId: string;
  clientId: string;
}> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `slug-${Date.now()}-${fixtureId}@example.com`;

  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Slug Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const created = await agent.post('/api/workspaces').send({
    name: 'Slug Workspace',
    slug: `slug-workspace-${Date.now()}-${fixtureId}`,
  });
  expect(created.status).toBe(201);
  // Mooring allows two domains, and this file creates more than that.
  await grantPlan(created.body.id as string);

  const client = await agent.post(`/api/workspaces/${created.body.id}/clients`).send({
    name: 'Slug Client',
    slug: `slug-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);

  return { agent, organizationId: created.body.id as string, clientId: client.body.id as string };
}

/**
 * The cuid used to be the address. A primary key in the URL is not wrong, it just
 * looks wrong - it reads as a malfunction to anyone who sees it, and a link
 * pasted into a chat or an email says nothing about which domain it is about.
 */
describe('domain URL identifier', () => {
  beforeAll(resetDatabase);

  it('gives a new domain a slug derived from its name', async () => {
    const { agent, organizationId, clientId } = await workspace();

    const response = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
      .send({ name: 'Example-Report.test' });

    expect(response.status).toBe(201);

    const stored = await prisma.domain.findUniqueOrThrow({ where: { id: response.body.id } });
    // Sanitised, lower case, and derived from the name rather than random.
    expect(stored.slug).toMatch(/^example-report-test-[a-z0-9]+$/);
    expect(stored.slug).not.toBe(stored.id);
  });

  it('never issues the same slug to two workspaces watching one domain', async () => {
    const mine = await workspace();
    const theirs = await workspace();

    const first = await mine.agent
      .post(`/api/workspaces/${mine.organizationId}/clients/${mine.clientId}/domains`)
      .send({ name: 'Duplicate.test' });
    const second = await theirs.agent
      .post(`/api/workspaces/${theirs.organizationId}/clients/${theirs.clientId}/domains`)
      .send({ name: 'Duplicate.test' });

    const a = await prisma.domain.findUniqueOrThrow({ where: { id: first.body.id } });
    const b = await prisma.domain.findUniqueOrThrow({ where: { id: second.body.id } });

    // Two agencies may legitimately watch the same domain, so a slug derived from
    // the name alone would collide and take out whichever imported second.
    expect(a.slug).not.toBe(b.slug);
  });

  it('gives every domain in a bulk import its own slug', async () => {
    const { agent, organizationId, clientId } = await workspace();

    for (const name of ['bulk-one.test', 'bulk-two.test', 'bulk-three.test']) {
      const created = await agent
        .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
        .send({ name });
      expect(created.status).toBe(201);
    }

    const domains = await prisma.domain.findMany({
      where: { client: { organizationId } },
      select: { slug: true },
    });

    expect(domains).toHaveLength(3);
    expect(domains.every((domain) => domain.slug.length > 0)).toBe(true);
    expect(new Set(domains.map((domain) => domain.slug)).size).toBe(3);
  });

  it('resolves a domain by slug as well as by id', async () => {
    const { agent, organizationId, clientId } = await workspace();

    const created = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
      .send({ name: 'Resolvable.test' });

    const stored = await prisma.domain.findUniqueOrThrow({ where: { id: created.body.id } });

    const bySlug = await getDomain(organizationId, stored.slug);
    const byId = await getDomain(organizationId, stored.id);

    // Both resolve, so the frontend can move to slugs in URLs without a flag day
    // and internal callers, stored links and webhook payloads keep using the id.
    expect(bySlug?.id).toBe(stored.id);
    expect(byId?.id).toBe(stored.id);
  });

  it('returns nothing for a domain in another workspace, by either identifier', async () => {
    const mine = await workspace();
    const theirs = await workspace();

    const created = await theirs.agent
      .post(`/api/workspaces/${theirs.organizationId}/clients/${theirs.clientId}/domains`)
      .send({ name: 'Foreign.test' });

    const stored = await prisma.domain.findUniqueOrThrow({ where: { id: created.body.id } });

    // Resolving by slug must not become a way to read someone else's domain.
    expect(await getDomain(mine.organizationId, stored.slug)).toBeNull();
    expect(await getDomain(mine.organizationId, stored.id)).toBeNull();
  });

  it('exposes the slug on the portfolio row and the onboarding payload', async () => {
    const { agent, organizationId, clientId } = await workspace();

    const created = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
      .send({ name: 'Exposed.test' });

    const onboarding = await agent.get(
      `/api/workspaces/${organizationId}/domains/${created.body.id}/onboarding`,
    );

    expect(onboarding.status).toBe(200);
    expect(onboarding.body.domain.slug).toBeTruthy();
    expect(onboarding.body.domain.slug).not.toBe(onboarding.body.domain.id);
  });

});