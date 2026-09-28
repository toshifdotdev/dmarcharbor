import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { grantPlan } from './helpers/plan.js';
import { setOverride } from '../src/services/entitlements/entitlement.service.js';
import { createApiKey } from '../src/services/api-key.service.js';
import type { PlanTier } from '@prisma/client';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup(plan: PlanTier = 'MOORING') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `gate-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Gate Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({ name: 'Gate Agency', slug: `gate-${Date.now()}-${fixtureId}` });
  const organizationId = workspace.body.id as string;
  if (plan !== 'MOORING') {
    await grantPlan(organizationId, plan);
  }

  const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({ name: 'Acme', slug: `acme-${fixtureId}` });
  const domain = await agent.post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`).send({ name: `acme-${fixtureId}.test` });
  await prisma.domain.update({ where: { id: domain.body.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } });

  const member = await prisma.user.findFirstOrThrow({ where: { members: { some: { organizationId } } }, select: { id: true } });

  return { agent, organizationId, clientId: client.body.id, domainId: domain.body.id, userId: member.id };
}

describe('paid feature enforcement', () => {
  beforeAll(resetDatabase);

  it('refuses to mint an API key on the free plan', async () => {
    const { agent, organizationId } = await setup('MOORING');

    const refused = await agent.post(`/api/workspaces/${organizationId}/api-keys`).send({ name: 'Integration', scopes: ['read'] });

    expect(refused.status).toBe(402);
    expect(refused.body.error.feature).toBe('api.access');
    expect(refused.body.error.requiredIn).toBe('HARBOR');
    expect(await prisma.apiKey.count({ where: { organizationId } })).toBe(0);
  });

  it('refuses alert rules on the free plan, for both kinds', async () => {
    const { agent, organizationId, domainId, userId } = await setup('MOORING');

    const email = await agent
      .post(`/api/workspaces/${organizationId}/alert-rules`)
      .send({ name: 'Failure rate', metric: 'FAILURE_RATE', operator: 'GREATER_THAN', threshold: 10, domainId, recipientUserIds: [userId] });
    expect(email.status).toBe(402);
    expect(email.body.error.feature).toBe('alerts.email');

    const spoofing = await agent
      .post(`/api/workspaces/${organizationId}/alert-rules`)
      .send({ name: 'New source', metric: 'NEW_UNAUTHENTICATED_SOURCE', operator: 'GREATER_THAN', threshold: 1, domainId, recipientUserIds: [userId] });
    expect(spoofing.status).toBe(402);
    expect(spoofing.body.error.feature).toBe('alerts.spoofing');

    expect(await prisma.alertRule.count({ where: { organizationId } })).toBe(0);
  });

  it('refuses share links on the free plan', async () => {
    const { agent, organizationId, domainId } = await setup('MOORING');

    const refused = await agent.post(`/api/workspaces/${organizationId}/report-shares`).send({ domainId });

    expect(refused.status).toBe(402);
    expect(refused.body.error.feature).toBe('sharing.links');
    expect(await prisma.reportShare.count({ where: { organizationId } })).toBe(0);
  });

  it('refuses client digests on the free plan', async () => {
    const { agent, organizationId, clientId } = await setup('MOORING');

    const refused = await agent.post(`/api/workspaces/${organizationId}/report-digests`).send({ clientId, cadence: 'WEEKLY' });

    expect(refused.status).toBe(402);
    expect(refused.body.error.feature).toBe('digests');
  });

  it('allows each feature on the plan that sells it', async () => {
    const { agent, organizationId, domainId, userId } = await setup('FAIRWAY');

    expect((await agent.post(`/api/workspaces/${organizationId}/api-keys`).send({ name: 'Key', scopes: ['read'] })).status).toBe(402);

    const share = await agent.post(`/api/workspaces/${organizationId}/report-shares`).send({ domainId });
    expect(share.status).toBe(201);

    const alert = await agent
      .post(`/api/workspaces/${organizationId}/alert-rules`)
      .send({ name: 'Spoofing', metric: 'NEW_UNAUTHENTICATED_SOURCE', operator: 'GREATER_THAN', threshold: 1, domainId, recipientUserIds: [userId] });
    expect(alert.status).toBe(201);
  });

  it('stops an already issued API key from working once the plan drops', async () => {
    const { organizationId, domainId } = await setup('HARBOR');

    const user = await prisma.user.findFirstOrThrow({ where: { members: { some: { organizationId } } }, select: { id: true } });
    const issued = await createApiKey({ organizationId, name: 'Integration', scopes: ['read', 'write'], createdById: user.id });
    const whilePaid = await request(app).get('/api/v1/domains').set('Authorization', `Bearer ${issued.key}`);
    expect(whilePaid.status).toBe(200);
    expect(whilePaid.body.domains.length).toBe(1);

    // The key itself is untouched. Only the plan changed, which is exactly the
    // case that a creation-only check would miss.
    await setOrganizationPlanDowngrade(organizationId);
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: issued.id } })).revokedAt).toBeNull();

    const afterDowngrade = await request(app).get('/api/v1/domains').set('Authorization', `Bearer ${issued.key}`);

    expect(afterDowngrade.status).toBe(402);
    expect(afterDowngrade.body.error.feature).toBe('api.access');

    // And the domain data is untouched, so upgrading restores access intact.
    await grantPlan(organizationId, 'HARBOR');
    const afterUpgrade = await request(app).get('/api/v1/domains').set('Authorization', `Bearer ${issued.key}`);
    expect(afterUpgrade.status).toBe(200);
    expect(afterUpgrade.body.domains.length).toBe(1);
    expect(afterUpgrade.body.domains[0].id).toBe(domainId);
  });

  it('lets a deliberate override through on a plan that excludes it', async () => {
    const { agent, organizationId } = await setup('MOORING');

    expect((await agent.post(`/api/workspaces/${organizationId}/api-keys`).send({ name: 'Key', scopes: ['read'] })).status).toBe(402);

    await setOverride(organizationId, { entitlement: 'api.access', enabled: true, reason: 'Pilot customer.' });

    const granted = await agent.post(`/api/workspaces/${organizationId}/api-keys`).send({ name: 'Key', scopes: ['read'] });
    expect(granted.status).toBe(201);
  });

  it('keeps export and erasure open on the free plan', async () => {
    const { agent, organizationId, clientId } = await setup('MOORING');

    expect((await agent.post(`/api/workspaces/${organizationId}/export-jobs`).send({ scope: 'ORGANIZATION' })).status).not.toBe(402);
    const erasure = await agent.post(`/api/workspaces/${organizationId}/erasure-requests`).send({ scope: 'CLIENT', clientId });
    expect(erasure.status).not.toBe(402);
  });
});

async function setOrganizationPlanDowngrade(organizationId: string): Promise<void> {
  await prisma.subscription.updateMany({
    where: { organizationId },
    data: {
      plan: 'MOORING',
      status: 'ACTIVE',
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
}
