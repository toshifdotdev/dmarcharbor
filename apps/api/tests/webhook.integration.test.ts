import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { grantPlan } from './helpers/plan.js';
import {
  deliverDueWebhooks,
  emitEvent,
  signPayload,
  validateEndpointUrl,
  webhookEvents,
} from '../src/services/webhook.service.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

interface Received {
  path: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  at: number;
}

let receiver: Server;
let receiverUrl: string;
let received: Received[] = [];
let nextStatus = 200;

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

function startReceiver(): Promise<void> {
  return new Promise((resolve) => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        received.push({
          path: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          headers: req.headers as Record<string, string | string[] | undefined>,
          at: Date.now(),
        });
        res.statusCode = nextStatus;
        res.end('ok');
      });
    });
    receiver.listen(0, '127.0.0.1', () => {
      receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
      resolve();
    });
  });
}

async function setup() {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `hook-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Hook Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({ name: 'Hook Agency', slug: `hook-${Date.now()}-${fixtureId}` });
  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId, 'HARBOR');

  return { agent, organizationId };
}

async function registerEndpoint(
  agent: ReturnType<typeof request.agent>,
  organizationId: string,
  events: string[] = ['domain.verified', 'alert.triggered'],
) {
  // The receiver runs on loopback, which the public endpoint rule refuses, so
  // the row is written directly to exercise real delivery and signing.
  const created = await agent.post(`/api/workspaces/${organizationId}/webhooks`).send({
    name: 'HaloPSA',
    url: 'https://hooks.example.com/dmarc',
    events,
  });
  expect(created.status).toBe(201);

  await prisma.webhookEndpoint.update({ where: { id: created.body.id }, data: { url: receiverUrl } });
  return { ...created.body, secret: created.body.secret as string };
}

describe('webhook endpoints', () => {
  beforeAll(async () => {
    await resetDatabase();
    await startReceiver();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  });

  it('publishes the event list and the opt in default', async () => {
    const { agent, organizationId } = await setup();
    const response = await agent.get(`/api/workspaces/${organizationId}/webhooks`);

    expect(response.status).toBe(200);
    expect(response.body.events).toEqual([...webhookEvents]);
    expect(response.body.defaultEvents).toEqual(['domain.verified', 'alert.triggered']);
    expect(response.body.defaultEvents).not.toContain('report.received');
  });

  it('registers an endpoint and shows the signing secret once', async () => {
    const { agent, organizationId } = await setup();

    const created = await agent.post(`/api/workspaces/${organizationId}/webhooks`).send({
      name: 'HaloPSA',
      url: 'https://hooks.example.com/dmarc',
    });

    expect(created.status).toBe(201);
    expect(created.body.secret).toBeTruthy();
    expect(created.body.events).toEqual(['domain.verified', 'alert.triggered']);

    const stored = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.secret).not.toBe(created.body.secret);

    const list = await agent.get(`/api/workspaces/${organizationId}/webhooks`);
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);
  });

  it('refuses an endpoint that is not public https', async () => {
    const reason = (raw: string): string => {
      const result = validateEndpointUrl(raw);
      return 'error' in result ? result.error : '';
    };

    expect(reason('http://hooks.example.com/x')).toContain('https');
    expect(reason('https://localhost/x')).toContain('public');
    expect(reason('https://127.0.0.1/x')).toContain('public');
    expect(reason('https://10.0.0.5/x')).toContain('public');
    expect(reason('https://192.168.1.4/x')).toContain('public');
    expect(reason('https://[::1]/x')).toContain('public');
    expect(reason('not a url')).toContain('valid');

    const allowed = validateEndpointUrl('https://hooks.example.com/x');
    expect('url' in allowed && allowed.url).toContain('hooks.example.com');
  });

  it('only lets the owner or admin manage endpoints', async () => {
    const { organizationId } = await setup();
    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'viewer' } });
    const member = await prisma.member.findFirstOrThrow({ where: { organizationId } });
    await prisma.session.deleteMany({ where: { userId: member.userId } });

    const email = (await prisma.user.findUniqueOrThrow({ where: { id: member.userId } })).email;
    const viewer = request.agent(app);
    expect((await viewer.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

    expect(
      (await viewer.post(`/api/workspaces/${organizationId}/webhooks`).send({ name: 'Sneaky', url: 'https://a.example.com/x' })).status,
    ).toBe(403);
  });

  it('delivers a signed event that the receiver can verify', async () => {
    const { agent, organizationId } = await setup();
    const endpoint = await registerEndpoint(agent, organizationId, ['domain.verified']);

    received = [];
    nextStatus = 200;

    const queued = await emitEvent(organizationId, 'domain.verified', { domainId: 'd1', domainName: 'acme.com' });
    expect(queued).toBe(1);

    const outcomes = await deliverDueWebhooks();
    expect(outcomes[0]?.status).toBe('DELIVERED');

    expect(received).toHaveLength(1);
    const delivery = received[0]!;
    expect(delivery.headers['x-dmarcharbor-event']).toBe('domain.verified');
    expect(delivery.headers['x-dmarcharbor-delivery']).toBeTruthy();
    expect(delivery.headers['x-dmarcharbor-attempt']).toBe('1');

    const signature = delivery.headers['x-dmarcharbor-signature'] as string;
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);

    // The receiver holds the same secret and can prove the event came from us.
    // The timestamp comes from the header the sender signed with, not from the
    // receiver's own clock, which is both correct and not second dependent.
    const sentAt = Number(delivery.headers['x-dmarcharbor-timestamp']);
    expect(Number.isInteger(sentAt)).toBe(true);
    expect(sentAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    const expected = signPayload(endpoint.secret, delivery.body, sentAt);
    expect(signature).toBe(expected);

    // A different second must not verify, which is what stops a captured
    // delivery being replayed indefinitely.
    expect(signPayload(endpoint.secret, delivery.body, sentAt + 1)).not.toBe(signature);

    const payload = JSON.parse(delivery.body);
    expect(payload.type).toBe('domain.verified');
    expect(payload.data.domainName).toBe('acme.com');
    expect(payload.id).toMatch(/^evt_/);
  });

  it('sends a pointer for a report rather than the report itself', async () => {
    const { agent, organizationId } = await setup();
    await registerEndpoint(agent, organizationId, ['report.received']);

    received = [];
    await emitEvent(organizationId, 'report.received', {
      reportId: 'rep_1',
      domainId: 'dom_1',
      domainName: 'acme.com',
      recordCount: 4,
      receivedAt: new Date().toISOString(),
    });
    await deliverDueWebhooks();

    const payload = JSON.parse(received[0]!.body);
    expect(Object.keys(payload.data).sort()).toEqual(['domainId', 'domainName', 'receivedAt', 'recordCount', 'reportId']);
    expect(payload.data.records).toBeUndefined();
    expect(payload.data.report).toBeUndefined();
  });

  it('does not deliver an event the endpoint did not subscribe to', async () => {
    const { agent, organizationId } = await setup();
    await registerEndpoint(agent, organizationId, ['domain.verified']);

    received = [];
    const queued = await emitEvent(organizationId, 'alert.triggered', { alertEventId: 'a1' });
    expect(queued).toBe(0);

    await deliverDueWebhooks();
    expect(received).toHaveLength(0);
  });

  it('queues nothing when no endpoint exists', async () => {
    const { organizationId } = await setup();
    expect(await emitEvent(organizationId, 'domain.verified', { domainId: 'x' })).toBe(0);
  });

  it('retries a failing endpoint with backoff instead of dropping the event', async () => {
    const { agent, organizationId } = await setup();
    await registerEndpoint(agent, organizationId, ['domain.verified']);

    received = [];
    nextStatus = 500;

    await emitEvent(organizationId, 'domain.verified', { domainId: 'd1' });

    const first = await deliverDueWebhooks();
    expect(first[0]?.status).toBe('RETRY');
    expect(first[0]?.responseCode).toBe(500);

    const pending = await prisma.webhookDelivery.findFirstOrThrow({ where: { organizationId } });
    expect(pending.status).toBe('PENDING');
    expect(pending.attempts).toBe(1);
    expect(pending.nextAttemptAt).not.toBeNull();

    // Not due yet, so it is left alone rather than hammered.
    received = [];
    expect(await deliverDueWebhooks()).toHaveLength(0);
    expect(received).toHaveLength(0);

    nextStatus = 200;
    await prisma.webhookDelivery.update({ where: { id: pending.id }, data: { nextAttemptAt: new Date() } });
    const second = await deliverDueWebhooks();
    expect(second[0]?.status).toBe('DELIVERED');
    expect(received).toHaveLength(1);
  });

  it('gives up after the attempt limit and records why', async () => {
    const { agent, organizationId } = await setup();
    await registerEndpoint(agent, organizationId, ['domain.verified']);

    nextStatus = 404;
    await emitEvent(organizationId, 'domain.verified', { domainId: 'd1' });

    await prisma.webhookDelivery.updateMany({
      where: { organizationId },
      data: { attempts: 4, nextAttemptAt: new Date() },
    });

    const outcomes = await deliverDueWebhooks();
    expect(outcomes[0]?.status).toBe('FAILED');

    const failed = await prisma.webhookDelivery.findFirstOrThrow({ where: { organizationId } });
    expect(failed.status).toBe('FAILED');
    expect(failed.lastError).toContain('404');
    expect(failed.nextAttemptAt).toBeNull();
  });

  it('suspends an endpoint that keeps failing, and the pause is auditable', async () => {
    const { agent, organizationId } = await setup();
    const endpoint = await registerEndpoint(agent, organizationId, ['domain.verified']);

    await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { failureCount: 19 } });

    nextStatus = 500;
    await emitEvent(organizationId, 'domain.verified', { domainId: 'd1' });
    await deliverDueWebhooks();

    const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(row.failureCount).toBeGreaterThanOrEqual(20);
    expect(row.suspendedAt).not.toBeNull();

    const events = await prisma.auditLog.findMany({ where: { organizationId, action: 'WEBHOOK_ENDPOINT_SUSPENDED' } });
    expect(events).toHaveLength(1);

    // While suspended nothing more is queued for it.
    received = [];
    expect(await emitEvent(organizationId, 'domain.verified', { domainId: 'd2' })).toBe(0);
    nextStatus = 200;
  });

  it('resets the failure count after a successful delivery', async () => {
    const { agent, organizationId } = await setup();
    const endpoint = await registerEndpoint(agent, organizationId, ['domain.verified']);

    await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { failureCount: 3 } });
    await emitEvent(organizationId, 'domain.verified', { domainId: 'd1' });

    nextStatus = 200;
    await deliverDueWebhooks();

    const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(row.failureCount).toBe(0);
    expect(row.lastDeliveryAt).not.toBeNull();
  });

  it('queues a test delivery and says so when nothing subscribes', async () => {
    const { agent, organizationId } = await setup();

    const none = await agent.post(`/api/workspaces/${organizationId}/webhooks/test`);
    expect(none.status).toBe(202);
    expect(none.body.queued).toBe(0);
    expect(none.body.notice).toContain('No endpoint');

    await registerEndpoint(agent, organizationId, ['domain.verified']);
    received = [];
    const queued = await agent.post(`/api/workspaces/${organizationId}/webhooks/test`);
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(1);

    await deliverDueWebhooks();
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.body).data.test).toBe(true);
  });

  it('exposes a delivery log and can replay a failed delivery', async () => {
    const { agent, organizationId } = await setup();
    await registerEndpoint(agent, organizationId, ['domain.verified']);

    nextStatus = 500;
    await emitEvent(organizationId, 'domain.verified', { domainId: 'd1' });
    await prisma.webhookDelivery.updateMany({
      where: { organizationId },
      data: { status: 'FAILED', attempts: 5, nextAttemptAt: null, lastError: 'Endpoint responded 500.' },
    });

    const log = await agent.get(`/api/workspaces/${organizationId}/webhook-deliveries`);
    expect(log.status).toBe(200);
    expect(log.body.deliveries[0].status).toBe('FAILED');
    expect(log.body.deliveries[0].lastError).toContain('500');

    const replayed = await agent.post(
      `/api/workspaces/${organizationId}/webhook-deliveries/${log.body.deliveries[0].id}/replay`,
    );
    expect(replayed.status).toBe(202);

    const after = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: log.body.deliveries[0].id } });
    expect(after.status).toBe('PENDING');
    expect(after.attempts).toBe(0);
    nextStatus = 200;
  });

  it('pauses and resumes an endpoint', async () => {
    const { agent, organizationId } = await setup();
    const created = await agent.post(`/api/workspaces/${organizationId}/webhooks`).send({
      name: 'Pausable',
      url: 'https://hooks.example.com/pausable',
    });

    const paused = await agent.patch(`/api/workspaces/${organizationId}/webhooks/${created.body.id}`).send({ active: false });
    expect(paused.status).toBe(200);
    expect(paused.body.active).toBe(false);

    const resumed = await agent.patch(`/api/workspaces/${organizationId}/webhooks/${created.body.id}`).send({ active: true });
    expect(resumed.body.active).toBe(true);
  });

  it('deletes an endpoint and its history', async () => {
    const { agent, organizationId } = await setup();
    const created = await agent.post(`/api/workspaces/${organizationId}/webhooks`).send({
      name: 'Temporary',
      url: 'https://hooks.example.com/temp',
    });

    expect((await agent.delete(`/api/workspaces/${organizationId}/webhooks/${created.body.id}`)).status).toBe(204);
    expect((await agent.delete(`/api/workspaces/${organizationId}/webhooks/${created.body.id}`)).status).toBe(404);
    expect(await prisma.webhookEndpoint.count({ where: { id: created.body.id } })).toBe(0);
  });

  it('never delivers one workspace events to another workspace endpoint', async () => {
    const first = await setup();
    const second = await setup();
    await registerEndpoint(second.agent, second.organizationId, ['domain.verified']);

    // The delivery scheduler is global, so anything already queued from an
    // earlier test is drained too. The assertion is therefore that the first
    // workspace event never arrives, not that the queue was empty.
    received = [];
    const queued = await emitEvent(first.organizationId, 'domain.verified', { domainId: 'first-workspace-only' });
    expect(queued).toBe(0);

    await deliverDueWebhooks();
    expect(received.some((entry) => entry.body.includes('first-workspace-only'))).toBe(false);
  });

  it('records endpoint creation in the audit trail', async () => {
    const { agent, organizationId } = await setup();
    await agent.post(`/api/workspaces/${organizationId}/webhooks`).send({
      name: 'Audited',
      url: 'https://hooks.example.com/audited',
    });

    const events = await prisma.auditLog.findMany({ where: { organizationId, action: 'WEBHOOK_ENDPOINT_CREATED' } });
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ name: 'Audited' });
  });
});
