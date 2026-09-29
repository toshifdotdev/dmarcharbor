import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { grantPlan } from './helpers/plan.js';
import {
  deadDeliveryRequeueHours,
  deliverDueWebhooks,
  emitEvent,
  repairWebhookEndpoints,
  signPayload,
  suspensionProbeHours,
  validateEndpointUrl,
} from '../src/services/webhook.service.js';
import { acquireDueLease, lastRunAt } from '../src/scheduler/job-lease.service.js';
import { encryptSensitive } from '../src/services/privacy.service.js';

/**
 * Repairing integrations that died.
 *
 * Both cases here are about something that stops forever and never announces it.
 * A webhook endpoint that accumulated twenty failures was suspended for good,
 * so a customer whose server was down overnight received nothing again and was
 * never told, because there was nothing to tell them. A delivery that used up
 * its five retries was marked failed and never looked at, so the events that
 * failed inside a customer outage were simply lost, which is the worst possible
 * moment for a monitoring product to lose data.
 *
 * Both are repaired as half open transitions. One trial delivery decides, so a
 * genuinely broken endpoint climbs back to suspended rather than being retried
 * for ever.
 */

const staffKey = 'test-staff-key-not-a-real-secret';
const password = 'correct-horse-battery-staple';

let server: Server;
let port = 0;
let fixtureId = 0;
let received: { body: string; headers: Record<string, unknown> }[] = [];
let nextStatus = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: req.headers as Record<string, unknown>,
      });
      res.writeHead(nextStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: nextStatus < 300 }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "job_lease", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
  received = [];
  nextStatus = 200;
}

async function setup() {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `repair-${Date.now()}-${fixtureId}@example.com`;
  await agent.post('/api/auth/sign-up/email').send({ name: 'Repair Owner', email, password });
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  await agent.post('/api/auth/sign-in/email').send({ email, password });

  const workspace = await agent.post('/api/workspaces').send({ name: 'Repair Agency', slug: `rp-${Date.now()}-${fixtureId}` });
  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId);

  return { agent, organizationId };
}

/** Written directly, because the public endpoint rule refuses a loopback url. */
async function registerEndpoint(organizationId: string, events: string[] = ['domain.verified']) {
  const url = `http://127.0.0.1:${port}/hook`;

  // Confirms why the row is written directly rather than through the API: a
  // loopback receiver is refused, which is the rule that stops a workspace
  // pointing its webhooks at internal infrastructure.
  expect(validateEndpointUrl(url)).toHaveProperty('error');

  return prisma.webhookEndpoint.create({
    data: {
      organizationId,
      name: 'Receiver',
      url,
      secret: encryptSensitive('whsec_test'),
      events,
    },
  });
}

describe('suspended endpoints recover on a probe', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('reopens an endpoint whose suspension window has elapsed', async () => {
    const { organizationId } = await setup();
    const endpoint = await registerEndpoint(organizationId);

    await emitEvent(organizationId, 'domain.verified', { domainId: 'd1' });

    // As if the endpoint had been suspended after its failure threshold.
    await prisma.webhookDelivery.updateMany({ where: { endpointId: endpoint.id }, data: { status: 'SUSPENDED' } });
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { suspendedAt: new Date(Date.now() - (suspensionProbeHours + 1) * 60 * 60 * 1000), failureCount: 21 },
    });

    const outcome = await repairWebhookEndpoints();

    expect(outcome.endpointsProbed).toBe(1);
    expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } }).then((e) => e.suspendedAt)).toBeNull();

    const queued = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: endpoint.id } });
    expect(queued.status).toBe('PENDING');

    // The trial delivery is the whole point: a customer whose server was fixed
    // overnight is reconnected without a human involved.
    received = [];
    nextStatus = 200;
    await deliverDueWebhooks();
    expect(received).toHaveLength(1);
  });

  it('leaves a recently suspended endpoint alone', async () => {
    const { organizationId } = await setup();
    const endpoint = await registerEndpoint(organizationId);

    await emitEvent(organizationId, 'domain.verified', { domainId: 'd1' });
    await prisma.webhookDelivery.updateMany({ where: { endpointId: endpoint.id }, data: { status: 'SUSPENDED' } });
    await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { suspendedAt: new Date() } });

    const outcome = await repairWebhookEndpoints();

    // Probing immediately would hammer a server that is still down, which is how
    // a permanently broken integration gets an address blocked.
    expect(outcome.endpointsProbed).toBe(0);
    expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } }).then((e) => e.suspendedAt)).not.toBeNull();
  });

  it('leaves a suspended endpoint with nothing queued alone', async () => {
    const { organizationId } = await setup();
    const endpoint = await registerEndpoint(organizationId);

    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { suspendedAt: new Date(Date.now() - (suspensionProbeHours + 1) * 60 * 60 * 1000), failureCount: 30 },
    });

    const outcome = await repairWebhookEndpoints();

    // There is no trial to run, so reopening it would leave the endpoint half
    // open with nothing able to close it.
    expect(outcome.endpointsProbed).toBe(0);
    expect(outcome.endpointsStillFailing).toBe(1);
  });

  it('records the probe in the audit trail', async () => {
    const { organizationId } = await setup();
    const endpoint = await registerEndpoint(organizationId);

    await emitEvent(organizationId, 'domain.verified', { domainId: 'd1' });
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { suspendedAt: new Date(Date.now() - (suspensionProbeHours + 1) * 60 * 60 * 1000), failureCount: 25 },
    });

    await repairWebhookEndpoints();

    // So the reconnection is visible rather than looking like the endpoint was
    // never suspended in the first place.
    const event = await prisma.auditLog.findFirst({ where: { organizationId, action: 'WEBHOOK_ENDPOINT_PROBED' } });
    expect(event).not.toBeNull();
  });
});

describe('dead deliveries are requeued rather than lost', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('requeues a delivery that failed more than a day ago', async () => {
    const { organizationId } = await setup();
    const endpoint = await registerEndpoint(organizationId);

    await emitEvent(organizationId, 'domain.verified', { domainId: 'd1' });
    await prisma.webhookDelivery.updateMany({
      where: { endpointId: endpoint.id },
      data: {
        status: 'FAILED',
        attempts: 5,
        nextAttemptAt: null,
        createdAt: new Date(Date.now() - (deadDeliveryRequeueHours + 1) * 60 * 60 * 1000),
      },
    });

    const outcome = await repairWebhookEndpoints();
    expect(outcome.deliveriesRequeued).toBe(1);

    // A monitoring product that drops its customer's events during the customer's
    // own outage is the worst possible time to do it.
    received = [];
    nextStatus = 200;
    await deliverDueWebhooks();
    expect(received).toHaveLength(1);
  });

  it('leaves a freshly failed delivery to the normal retry schedule', async () => {
    const { organizationId } = await setup();
    const endpoint = await registerEndpoint(organizationId);

    await emitEvent(organizationId, 'domain.verified', { domainId: 'd1' });
    await prisma.webhookDelivery.updateMany({ where: { endpointId: endpoint.id }, data: { status: 'FAILED', attempts: 5 } });

    const outcome = await repairWebhookEndpoints();

    // The five in cycle retries already cover a blip. This is for a whole
    // outage, not for the next tick.
    expect(outcome.deliveriesRequeued).toBe(0);
  });

  it('does not requeue for an endpoint that is still suspended', async () => {
    const { organizationId } = await setup();
    const endpoint = await registerEndpoint(organizationId);

    await emitEvent(organizationId, 'domain.verified', { domainId: 'd1' });
    await prisma.webhookDelivery.updateMany({
      where: { endpointId: endpoint.id },
      data: { status: 'FAILED', attempts: 5, createdAt: new Date(Date.now() - (deadDeliveryRequeueHours + 1) * 60 * 60 * 1000) },
    });
    await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { suspendedAt: new Date() } });

    const outcome = await repairWebhookEndpoints();

    // The failure count is the real backstop. A dead endpoint has to reach the
    // suspension threshold and stop, rather than being retried for ever.
    expect(outcome.deliveriesRequeued).toBe(0);
  });

  it('does not requeue a delivery that actually succeeded', async () => {
    const { organizationId } = await setup();
    const endpoint = await registerEndpoint(organizationId);

    await emitEvent(organizationId, 'domain.verified', { domainId: 'd1' });
    await prisma.webhookDelivery.updateMany({
      where: { endpointId: endpoint.id },
      data: { status: 'FAILED', attempts: 5, deliveredAt: new Date(), createdAt: new Date(Date.now() - (deadDeliveryRequeueHours + 1) * 60 * 60 * 1000) },
    });

    // A row that was delivered once and then marked failed is an accounting
    // artefact, and resending it would duplicate a customer visible event.
    const outcome = await repairWebhookEndpoints();
    expect(outcome.deliveriesRequeued).toBe(0);
  });
});

describe('the reconciliation schedule survives a restart', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('does not run a job again inside its own interval', async () => {
    const first = await acquireDueLease('slow-job', 60 * 60 * 1000);
    expect(first.acquired).toBe(true);
    if (first.acquired) {
      await first.release();
    }

    // Simulates the next process starting up. The old in-memory lastRunAt began
    // at zero, so every restart considered the job due immediately, and
    // deploying three times a day meant reconciling three times a day whatever
    // the six hour interval said. That is a good way to be rate limited.
    const second = await acquireDueLease('slow-job', 60 * 60 * 1000);
    expect(second.acquired).toBe(false);
  });

  it('runs again once the interval has genuinely elapsed', async () => {
    const first = await acquireDueLease('slow-job', 40);
    expect(first.acquired).toBe(true);
    if (first.acquired) {
      await first.release();
    }

    await new Promise((resolve) => setTimeout(resolve, 80));

    const second = await acquireDueLease('slow-job', 40);
    expect(second.acquired).toBe(true);
    if (second.acquired) {
      await second.release();
    }
  });

  it('records when the job last started', async () => {
    const before = Date.now();
    const lease = await acquireDueLease('slow-job', 1000);
    if (lease.acquired) {
      await lease.release();
    }

    const ran = await lastRunAt('slow-job');
    expect(ran).not.toBeNull();
    expect(ran!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe('on demand reconciliation', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('refuses to a workspace session', async () => {
    const { agent } = await setup();

    // Sweeping billing state makes outbound provider calls, so it is not
    // something a workspace role can reach.
    const response = await agent.post('/api/billing/reconcile');
    expect([401, 403]).toContain(response.status);
  });

  it('refuses without the staff credential', async () => {
    const response = await request(app).post('/api/billing/reconcile');
    expect([401, 403]).toContain(response.status);
  });

  it('accepts the staff credential and reports what it examined', async () => {
    const response = await request(app)
      .post('/api/billing/reconcile')
      .set('Authorization', `Bearer ${staffKey}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('examined');
  });

  it('reports clearly when a named workspace has nothing to reconcile', async () => {
    const { organizationId } = await setup();

    const response = await request(app)
      .post('/api/billing/reconcile')
      .set('Authorization', `Bearer ${staffKey}`)
      .query({ organizationId });

    // Support asking about a customer with no provider subscription gets a real
    // answer rather than an empty result they have to interpret.
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NO_SUBSCRIPTION');
  });
});

describe('signing still holds after repair', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('requeues without weakening the signature', async () => {
    const { organizationId } = await setup();
    const endpoint = await registerEndpoint(organizationId);

    await emitEvent(organizationId, 'domain.verified', { domainId: 'd1' });
    await prisma.webhookDelivery.updateMany({
      where: { endpointId: endpoint.id },
      data: { status: 'FAILED', attempts: 5, createdAt: new Date(Date.now() - (deadDeliveryRequeueHours + 1) * 60 * 60 * 1000) },
    });

    await repairWebhookEndpoints();
    received = [];
    await deliverDueWebhooks();

    const sent = received[0];
    expect(sent).toBeDefined();

    const secret = 'whsec_test';
    const timestamp = Number(sent!.headers['x-dmarcharbor-timestamp']);
    expect(signPayload(secret, sent!.body, timestamp)).toBe(sent!.headers['x-dmarcharbor-signature']);
  });
});
