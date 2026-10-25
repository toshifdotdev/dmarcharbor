import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { emitEvent } from '../src/services/webhook.service.js';
import { grantPlan } from './helpers/plan.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspace() {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `webhook-plan-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Webhook Plan Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const created = await agent.post('/api/workspaces').send({
    name: 'Webhook Plan Agency',
    slug: `webhook-plan-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status).toBe(201);
  const organizationId = created.body.id as string;
  await grantPlan(organizationId, 'HARBOR');
  return { agent, organizationId };
}

async function endpoint(agent: ReturnType<typeof request.agent>, organizationId: string) {
  const created = await agent.post(`/api/workspaces/${organizationId}/webhooks`).send({
    name: 'Plan Gate Receiver',
    url: 'https://hooks.example.com/dmarc',
    events: ['domain.verified'],
  });
  expect(created.status).toBe(201);
  return created.body as { id: string };
}

function featureError(body: { error?: { code?: string; feature?: string } }): void {
  expect(body.error?.code).toBe('FEATURE_NOT_IN_PLAN');
  expect(body.error?.feature).toBe('integrations.webhooks');
}

describe('webhooks are a Fairway feature', () => {
  beforeAll(resetDatabase);

  it('refuses the operations that create or re-enable webhooks on Mooring, and keeps the ones that clean up', async () => {
    const { agent, organizationId } = await workspace();
    const ep = await endpoint(agent, organizationId);
    await emitEvent(organizationId, 'domain.verified', { domainId: 'd1', domainName: 'example.test' });
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { endpointId: ep.id },
    });

    await grantPlan(organizationId, 'MOORING');

    const create = await agent.post(`/api/workspaces/${organizationId}/webhooks`).send({
      name: 'Refused',
      url: 'https://hooks.example.com/refused',
    });
    expect(create.status).toBe(402);
    featureError(create.body);

    const test = await agent.post(`/api/workspaces/${organizationId}/webhooks/test`);
    expect(test.status).toBe(402);
    featureError(test.body);

    const replay = await agent.post(
      `/api/workspaces/${organizationId}/webhook-deliveries/${delivery.id}/replay`,
    );
    expect(replay.status).toBe(402);
    featureError(replay.body);

    const changeEvents = await agent
      .patch(`/api/workspaces/${organizationId}/webhooks/${ep.id}`)
      .send({ events: ['domain.verified', 'alert.triggered'] });
    expect(changeEvents.status).toBe(402);
    featureError(changeEvents.body);

    const reEnable = await agent
      .patch(`/api/workspaces/${organizationId}/webhooks/${ep.id}`)
      .send({ active: true });
    expect(reEnable.status).toBe(402);
    featureError(reEnable.body);

    const rename = await agent
      .patch(`/api/workspaces/${organizationId}/webhooks/${ep.id}`)
      .send({ name: 'Renamed' });
    expect(rename.status).toBe(402);
    featureError(rename.body);

    const deactivate = await agent
      .patch(`/api/workspaces/${organizationId}/webhooks/${ep.id}`)
      .send({ active: false });
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.active).toBe(false);

    // Deactivation plus another change is not the cleanup exception.
    const mixed = await agent
      .patch(`/api/workspaces/${organizationId}/webhooks/${ep.id}`)
      .send({ active: false, name: 'Sneaky rename' });
    expect(mixed.status).toBe(402);
    featureError(mixed.body);

    const list = await agent.get(`/api/workspaces/${organizationId}/webhooks`);
    expect(list.status).toBe(200);
    expect(list.body.endpoints).toHaveLength(1);

    const deliveries = await agent.get(`/api/workspaces/${organizationId}/webhook-deliveries`);
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.deliveries).toHaveLength(1);

    const del = await agent.delete(`/api/workspaces/${organizationId}/webhooks/${ep.id}`);
    expect(del.status).toBe(204);
    expect(await prisma.webhookEndpoint.count()).toBe(0);
  });

  it('does not queue new deliveries on Mooring, keeps the endpoint, and resumes on upgrade', async () => {
    const { agent, organizationId } = await workspace();
    const ep = await endpoint(agent, organizationId);
    expect(await emitEvent(organizationId, 'domain.verified', { domainId: 'd1', domainName: 'example.test' })).toBe(1);
    const before = await prisma.webhookDelivery.count();

    await grantPlan(organizationId, 'MOORING');
    expect(await emitEvent(organizationId, 'domain.verified', { domainId: 'd2', domainName: 'two.example' })).toBe(0);
    expect(await prisma.webhookDelivery.count()).toBe(before);

    const stored = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
    expect(stored.active).toBe(true);

    await grantPlan(organizationId, 'FAIRWAY');
    expect(await emitEvent(organizationId, 'domain.verified', { domainId: 'd3', domainName: 'three.example' })).toBe(1);
    expect(await prisma.webhookDelivery.count()).toBe(before + 1);
  });

  it('lets Fairway do everything, including test, replay and changes', async () => {
    const { agent, organizationId } = await workspace();
    await grantPlan(organizationId, 'FAIRWAY');
    const ep = await endpoint(agent, organizationId);

    const test = await agent.post(`/api/workspaces/${organizationId}/webhooks/test`);
    expect(test.status).toBe(202);
    expect(test.body.queued).toBe(1);

    expect(await emitEvent(organizationId, 'domain.verified', { domainId: 'd1', domainName: 'example.test' })).toBe(1);
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: ep.id } });

    const replay = await agent.post(
      `/api/workspaces/${organizationId}/webhook-deliveries/${delivery.id}/replay`,
    );
    expect(replay.status).toBe(202);

    const patch = await agent
      .patch(`/api/workspaces/${organizationId}/webhooks/${ep.id}`)
      .send({ name: 'Updated', events: ['domain.verified', 'alert.triggered'], active: false });
    expect(patch.status).toBe(200);

    const resume = await agent
      .patch(`/api/workspaces/${organizationId}/webhooks/${ep.id}`)
      .send({ active: true });
    expect(resume.status).toBe(200);
    expect(resume.body.active).toBe(true);

    const del = await agent.delete(`/api/workspaces/${organizationId}/webhooks/${ep.id}`);
    expect(del.status).toBe(204);
  });
});
