import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/database/prisma.js';
import { grantPlan } from './helpers/plan.js';
import {
  setGuardedTransportForTests,
  type GuardedRequestSpec,
  type GuardedResult,
} from '../src/services/net/guarded-request.js';
import {
  enqueueAlertClosed,
  enqueueAlertNote,
  enqueueAlertOpened,
  runPsaDelivery,
} from '../src/services/psa/psa-queue.service.js';
import { acknowledgeAlertEvent } from '../src/services/alert.service.js';
import { acknowledgeDnsChange } from '../src/services/monitoring/dns-change.service.js';
import { deliverDnsChangeNotifications } from '../src/services/monitoring/dns-change-notify.service.js';
import { buildExportPayload } from '../src/services/export/export.service.js';
import { deleteClient, deleteDomain, deleteWorkspace } from '../src/services/lifecycle-deletion.service.js';

/**
 * PSA ticketing end to end.
 *
 * The PSA is a fake behind the guarded-request transport seam, so nothing here
 * reaches the network and the assertions are on the exact calls a provider
 * would receive. Everything else — the outbox, the worker, the routes, the
 * entitlement gate, the export — is the real code.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const secretStrings = ['test-secret-not-real', 'halo-client-secret-value', 'test-public-key'];

interface FakeTicket {
  id: string;
  summary: string;
  companyId: string;
  closed: boolean;
  notes: string[];
}

class FakePsa {
  tickets: FakeTicket[] = [];
  calls: GuardedRequestSpec[] = [];
  /** When set, every call after the token exchange answers this. */
  failWith: { status: number; body: string } | null = null;
  /** Create the ticket, then fail the transport: the lost-response case. */
  loseCreateResponseOnce = false;
  private next = 100;

  handle(spec: GuardedRequestSpec): GuardedResult {
    this.calls.push(spec);
    const url = new URL(spec.url);

    if (url.pathname.endsWith('/token')) {
      return this.ok({ access_token: 'fake-token', expires_in: 3600 });
    }
    if (this.failWith) {
      return {
        status: 'ok',
        statusCode: this.failWith.status,
        headers: {},
        body: Buffer.from(this.failWith.body, 'utf8'),
      };
    }

    if (url.pathname === '/api/Client') {
      return this.ok([{ id: 1, name: 'Acme Ltd' }]);
    }
    if (url.pathname === '/api/TicketType') return this.ok([{ id: 7, name: 'Incident' }]);
    if (url.pathname === '/api/Status') {
      return this.ok([
        { id: 11, name: 'New', closed: false },
        { id: 22, name: 'Closed', closed: true },
      ]);
    }
    if (url.pathname === '/api/Team') return this.ok([{ id: 3, name: 'Service desk' }]);

    if (url.pathname === '/api/Tickets' && spec.method === 'GET') {
      const marker = url.searchParams.get('search') ?? '';
      return this.ok(
        this.tickets
          .filter((ticket) => !ticket.closed && ticket.summary.includes(marker))
          .map((ticket) => ({ id: Number(ticket.id), summary: ticket.summary })),
      );
    }

    if (url.pathname === '/api/Tickets' && spec.method === 'POST') {
      const body = JSON.parse(spec.body ?? '[]') as Array<Record<string, unknown>>;
      const entry = body[0] ?? {};
      if (entry.summary === undefined && entry.id !== undefined) {
        const ticket = this.tickets.find((candidate) => candidate.id === String(entry.id));
        if (ticket) ticket.closed = true;
        return this.ok([{ id: Number(entry.id) }]);
      }
      const created: FakeTicket = {
        id: String(this.next++),
        summary: String(entry.summary),
        companyId: String(entry.client_id),
        closed: false,
        notes: [],
      };
      this.tickets.push(created);
      if (this.loseCreateResponseOnce) {
        this.loseCreateResponseOnce = false;
        return { status: 'error', failure: 'timeout', detail: 'The PSA did not answer in time.' };
      }
      return this.ok([{ id: Number(created.id) }]);
    }

    if (url.pathname === '/api/Actions') {
      const body = JSON.parse(spec.body ?? '[]') as Array<Record<string, unknown>>;
      const ticket = this.tickets.find((candidate) => candidate.id === String(body[0]?.ticket_id));
      if (ticket) ticket.notes.push(String(body[0]?.note));
      return this.ok({});
    }

    return { status: 'ok', statusCode: 404, headers: {}, body: Buffer.from('{}', 'utf8') };
  }

  private ok(body: unknown): GuardedResult {
    return {
      status: 'ok',
      statusCode: 200,
      headers: {},
      body: Buffer.from(JSON.stringify(body), 'utf8'),
    };
  }
}

let psa: FakePsa;

function resetDatabase(): Promise<void> {
  return prisma
    .$executeRawUnsafe(
      'TRUNCATE TABLE "psa_ticket_job", "psa_ticket_link", "psa_company_mapping", "psa_connection", "dns_change", "alert_delivery", "alert_event", "alert_rule", "notification", "rate_limit_bucket", "audit_log", "email_delivery", "session", "account", "verification", "two_factor", member, invitation, "user", "organization" CASCADE',
    )
    .then(() => undefined);
}

beforeEach(async () => {
  await resetDatabase();
  psa = new FakePsa();
  setGuardedTransportForTests(async (spec) => psa.handle(spec));
});

afterEach(() => {
  setGuardedTransportForTests(null);
  env.PSA_CONNECTWISE_CLIENT_ID = undefined;
});

async function setup(plan: 'HARBOR' | 'MOORING' | 'FAIRWAY' = 'HARBOR') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `psa-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'PSA Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'PSA Agency',
    slug: `psa-agency-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId, plan);

  const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name: 'Acme Ltd',
    slug: `psa-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);
  const clientId = client.body.id as string;

  const domainName = `psa-${Date.now()}-${fixtureId}.example`;
  const domain = await agent
    .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
    .send({ name: domainName });
  expect(domain.status).toBe(201);
  await prisma.domain.update({ where: { id: domain.body.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } });

  return {
    agent,
    organizationId,
    clientId,
    clientName: 'Acme Ltd',
    domainId: domain.body.id as string,
    domainName,
    domainSlug: domain.body.slug as string,
    userId: (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

const base = (organizationId: string) => `/api/workspaces/${organizationId}/psa`;

async function connect(fixture: Fixture) {
  const response = await fixture.agent.put(base(fixture.organizationId)).send({
    provider: 'HALOPSA',
    credentials: {
      resourceServer: 'https://acme.halopsa.com',
      clientId: 'halo-client',
      clientSecret: 'halo-client-secret-value',
    },
    settings: { closedStatusId: '22', openStatusId: '11', ticketQueueId: '3', ticketTypeId: '7' },
  });
  expect(response.status).toBe(200);
  return response;
}

async function mapClient(fixture: Fixture) {
  const response = await fixture.agent
    .put(`${base(fixture.organizationId)}/mappings/${fixture.clientId}`)
    .send({ externalCompanyId: '1', externalCompanyName: 'Acme Ltd' });
  expect(response.status).toBe(200);
}

/** An alert rule and an open event, without waiting for a scan to cross a threshold. */
async function openAlert(fixture: Fixture, summary = '12 messages failed DMARC') {
  const rule = await prisma.alertRule.create({
    data: {
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      name: 'Any DMARC failure',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 10,
      windowMinutes: 1440,
      cooldownMinutes: 60,
      maxReminderLevel: 3,
      enabled: true,
    },
  });
  const event = await prisma.alertEvent.create({
    data: {
      ruleId: rule.id,
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      observedValue: 12,
      threshold: 10,
      windowMinutes: 1440,
      summary,
    },
  });
  return { rule, event };
}

function alertContext(fixture: Fixture, ruleName = 'Any DMARC failure') {
  return {
    organizationId: fixture.organizationId,
    eventId: '',
    ruleName,
    metric: 'FAILURE_COUNT' as const,
    observed: 12,
    threshold: 10,
    summary: '12 messages failed DMARC',
    domain: {
      id: fixture.domainId,
      name: fixture.domainName,
      slug: fixture.domainSlug,
      clientId: fixture.clientId,
      client: { name: fixture.clientName },
    },
  };
}

describe('PSA ticketing', () => {
  it('queues one job for an alert and opens one ticket under the mapped company', async () => {
    const fixture = await setup();
    await connect(fixture);
    await mapClient(fixture);
    const { event } = await openAlert(fixture);

    await enqueueAlertOpened({ ...alertContext(fixture), eventId: event.id });
    // A second, concurrent enqueue must not produce a second job.
    await enqueueAlertOpened({ ...alertContext(fixture), eventId: event.id });

    expect(await prisma.psaTicketJob.count({ where: { kind: 'OPEN' } })).toBe(1);

    const outcome = await runPsaDelivery();
    expect(outcome.opened).toBe(1);

    expect(psa.tickets).toHaveLength(1);
    expect(psa.tickets[0]!.companyId).toBe('1');
    expect(psa.tickets[0]!.summary).toContain('[DH-');

    const link = await prisma.psaTicketLink.findFirstOrThrow();
    expect(link.externalTicketId).toBe(psa.tickets[0]!.id);
    expect(link.alertEventId).toBe(event.id);
    expect(link.state).toBe('OPEN');
    expect((await prisma.psaTicketJob.findFirstOrThrow()).status).toBe('DONE');
  });

  it('notes a reminder and an acknowledgement, and closes on resolve', async () => {
    const fixture = await setup();
    await connect(fixture);
    await mapClient(fixture);
    const { event } = await openAlert(fixture);
    await enqueueAlertOpened({ ...alertContext(fixture), eventId: event.id });
    await runPsaDelivery();

    // A reminder note, then an acknowledgement note.
    await enqueueAlertNote({
      organizationId: fixture.organizationId,
      eventId: event.id,
      text: 'Reminder 2 in DMARC Harbor',
      suffix: 'reminder:2',
    });
    expect(await acknowledgeAlertEvent(fixture.organizationId, event.id, fixture.userId)).toBe('acknowledged');

    await runPsaDelivery();
    const notes = psa.tickets[0]!.notes;
    expect(notes.some((note) => note.includes('Reminder 2'))).toBe(true);
    expect(notes.some((note) => note.includes('Acknowledged in DMARC Harbor by'))).toBe(true);
    expect(psa.tickets[0]!.closed).toBe(false);

    // Resolve: a note, then a close, because closeOnResolve is on by default.
    await enqueueAlertClosed({
      organizationId: fixture.organizationId,
      eventId: event.id,
      text: 'Resolved in DMARC Harbor',
    });
    await runPsaDelivery();

    expect(psa.tickets[0]!.notes.some((note) => note.includes('Resolved'))).toBe(true);
    expect(psa.tickets[0]!.closed).toBe(true);
    expect((await prisma.psaTicketLink.findFirstOrThrow()).state).toBe('CLOSED');
  });

  it('only notes when closeOnResolve is off', async () => {
    const fixture = await setup();
    await connect(fixture);
    await mapClient(fixture);
    const { event } = await openAlert(fixture);
    await enqueueAlertOpened({ ...alertContext(fixture), eventId: event.id });
    await runPsaDelivery();

    await fixture.agent.patch(base(fixture.organizationId)).send({ settings: { closeOnResolve: false } });

    await enqueueAlertClosed({
      organizationId: fixture.organizationId,
      eventId: event.id,
      text: 'Resolved in DMARC Harbor',
    });
    await runPsaDelivery();

    expect(psa.tickets[0]!.notes.some((note) => note.includes('Resolved'))).toBe(true);
    expect(psa.tickets[0]!.closed).toBe(false);
    expect(await prisma.psaTicketJob.count({ where: { kind: 'CLOSE' } })).toBe(0);
  });

  it('opens one DNS ticket per pass and closes it when every change is acknowledged', async () => {
    const fixture = await setup();
    await connect(fixture);
    await mapClient(fixture);

    const scan = await prisma.scan.create({
      data: { domainId: fixture.domainId, status: 'COMPLETED', trigger: 'MANUAL', completedAt: new Date() },
    });
    const first = await prisma.dnsChange.create({
      data: {
        organizationId: fixture.organizationId,
        domainId: fixture.domainId,
        scanId: scan.id,
        kind: 'DMARC_POLICY',
        severity: 'CRITICAL',
        code: 'dmarc_policy_weakened',
        summary: 'DMARC policy weakened from reject to none.',
      },
    });
    const second = await prisma.dnsChange.create({
      data: {
        organizationId: fixture.organizationId,
        domainId: fixture.domainId,
        scanId: scan.id,
        kind: 'SPF_RECORD',
        severity: 'CRITICAL',
        code: 'spf_removed',
        summary: 'The SPF record was removed.',
      },
    });

    await deliverDnsChangeNotifications();
    await runPsaDelivery();

    expect(psa.tickets).toHaveLength(1);
    expect(psa.tickets[0]!.summary).toContain('(+1 more)');
    const link = await prisma.psaTicketLink.findFirstOrThrow();
    expect(link.source).toBe('DNS_CHANGES');
    expect(link.dnsChangeIds.sort()).toEqual([first.id, second.id].sort());

    // One acknowledged change is not enough to close.
    await acknowledgeDnsChange({
      organizationId: fixture.organizationId,
      domainIdOrSlug: fixture.domainId,
      changeId: first.id,
      actorUserId: fixture.userId,
    });
    await runPsaDelivery();
    expect(psa.tickets[0]!.closed).toBe(false);
    expect(psa.tickets[0]!.notes.some((note) => note.includes('Acknowledged'))).toBe(true);

    await acknowledgeDnsChange({
      organizationId: fixture.organizationId,
      domainIdOrSlug: fixture.domainId,
      changeId: second.id,
      actorUserId: fixture.userId,
    });
    await runPsaDelivery();
    expect(psa.tickets[0]!.closed).toBe(true);
  });

  it('skips an unmapped client, shows the job, and opens nothing', async () => {
    const fixture = await setup();
    await connect(fixture);
    const { event } = await openAlert(fixture);

    await enqueueAlertOpened({ ...alertContext(fixture), eventId: event.id });
    const job = await prisma.psaTicketJob.findFirstOrThrow();
    expect(job.status).toBe('SKIPPED');
    expect(job.skipReason).toBe('unmapped_client');

    const outcome = await runPsaDelivery();
    expect(outcome.opened).toBe(0);
    expect(psa.tickets).toHaveLength(0);

    const listed = await fixture.agent.get(`${base(fixture.organizationId)}/jobs`);
    expect(listed.status).toBe(200);
    expect(listed.body.jobs[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'unmapped_client' });

    const view = await fixture.agent.get(base(fixture.organizationId));
    expect(view.body.skippedUnmapped).toEqual([
      { clientId: fixture.clientId, clientName: 'Acme Ltd', count: 1 },
    ]);
  });

  it('finds the ticket after a lost response instead of creating a duplicate', async () => {
    const fixture = await setup();
    await connect(fixture);
    await mapClient(fixture);
    const { event } = await openAlert(fixture);
    await enqueueAlertOpened({ ...alertContext(fixture), eventId: event.id });

    psa.loseCreateResponseOnce = true;
    const first = await runPsaDelivery();
    expect(first.retry).toBe(1);
    expect(psa.tickets).toHaveLength(1);
    expect(await prisma.psaTicketLink.count()).toBe(0);

    // The retry is due a minute later.
    const second = await runPsaDelivery(new Date(Date.now() + 2 * 60 * 1000));
    expect(second.opened).toBe(1);
    expect(psa.tickets).toHaveLength(1);
    expect(await prisma.psaTicketLink.count()).toBe(1);
  });

  it('backs off, fails after five attempts, and retries on demand', async () => {
    const fixture = await setup();
    await connect(fixture);
    await mapClient(fixture);
    const { event } = await openAlert(fixture);
    await enqueueAlertOpened({ ...alertContext(fixture), eventId: event.id });

    psa.failWith = { status: 503, body: JSON.stringify({ message: 'Service unavailable' }) };

    let now = Date.now();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await runPsaDelivery(new Date(now));
      now += 24 * 60 * 60 * 1000;
    }

    const job = await prisma.psaTicketJob.findFirstOrThrow();
    expect(job.status).toBe('FAILED');
    expect(job.attempts).toBe(5);
    expect(job.lastError).toContain('Service unavailable');

    psa.failWith = null;
    const retried = await fixture.agent.post(`${base(fixture.organizationId)}/jobs/${job.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.jobs[0]).toMatchObject({ status: 'PENDING', attempts: 0 });

    await runPsaDelivery(new Date(now));
    expect(psa.tickets).toHaveLength(1);
  });

  it('pauses the connection after twenty consecutive failures, with an audit row and a notification', async () => {
    const fixture = await setup();
    await connect(fixture);
    await mapClient(fixture);
    const { event } = await openAlert(fixture);
    await enqueueAlertOpened({ ...alertContext(fixture), eventId: event.id });

    await prisma.psaConnection.update({
      where: { organizationId: fixture.organizationId },
      data: { consecutiveFailures: 19 },
    });
    psa.failWith = { status: 500, body: '{}' };

    await runPsaDelivery();

    const connection = await prisma.psaConnection.findFirstOrThrow();
    expect(connection.status).toBe('PAUSED');
    expect(connection.pausedReason).toContain('20 times');
    expect(await prisma.auditLog.count({ where: { action: 'PSA_CONNECTION_PAUSED' } })).toBe(1);
    expect(await prisma.notification.count({ where: { kind: 'PSA', userId: fixture.userId } })).toBe(1);
  });

  it('pauses at once on bad credentials, because retrying cannot fix them', async () => {
    const fixture = await setup();
    await connect(fixture);
    await mapClient(fixture);
    const { event } = await openAlert(fixture);
    await enqueueAlertOpened({ ...alertContext(fixture), eventId: event.id });

    psa.failWith = { status: 401, body: JSON.stringify({ message: 'Unauthorized' }) };
    await runPsaDelivery();

    const connection = await prisma.psaConnection.findFirstOrThrow();
    expect(connection.status).toBe('PAUSED');
    expect(connection.pausedReason).toContain('credentials');
    expect((await prisma.psaTicketJob.findFirstOrThrow()).status).toBe('FAILED');
  });

  it('runs one job at a time per connection, in order', async () => {
    const fixture = await setup();
    await connect(fixture);
    await mapClient(fixture);
    const { event } = await openAlert(fixture);
    await enqueueAlertOpened({ ...alertContext(fixture), eventId: event.id });

    await enqueueAlertNote({
      organizationId: fixture.organizationId,
      eventId: event.id,
      text: 'A note that must land after the ticket exists',
      suffix: 'reminder:2',
    });

    await runPsaDelivery();

    // The note is only possible because the ticket was created first.
    expect(psa.tickets).toHaveLength(1);
    expect(psa.tickets[0]!.notes).toContain('A note that must land after the ticket exists');

    const order = psa.calls
      .filter((spec) => spec.url.endsWith('/api/Tickets') || spec.url.endsWith('/api/Actions'))
      .map((spec) => spec.method + ' ' + new URL(spec.url).pathname);
    expect(order[0]).toBe('POST /api/Tickets');
    expect(order[1]).toBe('POST /api/Actions');
  });

  it('refuses Mooring and Fairway on the gated routes, and keeps notes flowing after a downgrade', async () => {
    for (const plan of ['MOORING', 'FAIRWAY'] as const) {
      const fixture = await setup(plan);
      const refused = await fixture.agent.put(base(fixture.organizationId)).send({
        provider: 'HALOPSA',
        credentials: { resourceServer: 'https://acme.halopsa.com', clientId: 'a', clientSecret: 'b' },
      });
      expect(refused.status, plan).toBe(402);
      expect(refused.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    }

    const fixture = await setup();
    await connect(fixture);
    await mapClient(fixture);
    const { event } = await openAlert(fixture);
    await enqueueAlertOpened({ ...alertContext(fixture), eventId: event.id });
    await runPsaDelivery();
    expect(psa.tickets).toHaveLength(1);

    await grantPlan(fixture.organizationId, 'FAIRWAY');

    // Reading, the job log and disconnecting still work.
    expect((await fixture.agent.get(base(fixture.organizationId))).status).toBe(200);
    expect((await fixture.agent.get(`${base(fixture.organizationId)}/jobs`)).status).toBe(200);

    // A second alert opens nothing new, because the entitlement is off...
    const second = await openAlert(fixture, '20 messages failed DMARC');
    await enqueueAlertOpened({ ...alertContext(fixture), eventId: second.event.id });
    expect(await prisma.psaTicketJob.count({ where: { kind: 'OPEN' } })).toBe(1);

    // ...but the first ticket still gets its close.
    await enqueueAlertClosed({
      organizationId: fixture.organizationId,
      eventId: event.id,
      text: 'Resolved in DMARC Harbor',
    });
    await runPsaDelivery();
    expect(psa.tickets[0]!.closed).toBe(true);

    expect((await fixture.agent.delete(base(fixture.organizationId))).status).toBe(204);
  });

  it('is invisible to another workspace on every route', async () => {
    const owner = await setup();
    await connect(owner);
    const stranger = await setup();

    const responses = await Promise.all([
      stranger.agent.get(base(owner.organizationId)),
      stranger.agent.put(base(owner.organizationId)).send({ provider: 'HALOPSA', credentials: {} }),
      stranger.agent.patch(base(owner.organizationId)).send({ enabled: false }),
      stranger.agent.delete(base(owner.organizationId)),
      stranger.agent.get(`${base(owner.organizationId)}/mappings`),
      stranger.agent.put(`${base(owner.organizationId)}/mappings/${owner.clientId}`).send({
        externalCompanyId: '1',
        externalCompanyName: 'Acme Ltd',
      }),
      stranger.agent.get(`${base(owner.organizationId)}/jobs`),
    ]);
    for (const response of responses) {
      expect([403, 404]).toContain(response.status);
    }
    expect(await prisma.psaCompanyMapping.count()).toBe(0);
  });

  it('never returns, exports or audits a credential', async () => {
    const fixture = await setup();
    await connect(fixture);
    await mapClient(fixture);
    const { event } = await openAlert(fixture);
    await enqueueAlertOpened({ ...alertContext(fixture), eventId: event.id });
    await runPsaDelivery();

    const view = await fixture.agent.get(base(fixture.organizationId));
    const jobs = await fixture.agent.get(`${base(fixture.organizationId)}/jobs`);
    const mappings = await fixture.agent.get(`${base(fixture.organizationId)}/mappings`);
    const exported = await buildExportPayload({
      organizationId: fixture.organizationId,
      scope: 'ORGANIZATION',
      format: 'JSON',
      scopeLabel: 'workspace',
    });
    const audit = await prisma.auditLog.findMany({ select: { detail: true } });

    const haystack = JSON.stringify([view.body, jobs.body, mappings.body, exported, audit]);
    for (const secret of secretStrings) {
      expect(haystack).not.toContain(secret);
    }
    expect(haystack).toContain('acme.halopsa.com');
  });

  it('removes its rows on client, domain and workspace deletion without calling the PSA', async () => {
    const fixture = await setup();
    await connect(fixture);
    await mapClient(fixture);
    const { event } = await openAlert(fixture);
    await enqueueAlertOpened({ ...alertContext(fixture), eventId: event.id });
    await runPsaDelivery();
    const callsBeforeDeletion = psa.calls.length;

    expect((await deleteClient(fixture.organizationId, fixture.clientId)).ok).toBe(true);
    expect(await prisma.psaCompanyMapping.count()).toBe(0);

    // A second fixture for the domain and workspace paths.
    const other = await setup();
    await connect(other);
    await mapClient(other);
    const second = await openAlert(other);
    await enqueueAlertOpened({ ...alertContext(other), eventId: second.event.id });
    await runPsaDelivery();
    const callsBeforeOtherDeletion = psa.calls.length;

    expect((await deleteDomain(other.organizationId, other.domainId)).ok).toBe(true);
    expect(await prisma.psaTicketLink.count()).toBe(0);

    expect((await deleteWorkspace(other.organizationId, other.userId)).ok).toBe(true);
    expect(await prisma.psaConnection.count()).toBe(0);
    expect(await prisma.psaTicketJob.count()).toBe(0);

    // The deletion path never calls the PSA: it removes our rows only.
    expect(psa.calls.length).toBe(callsBeforeOtherDeletion);
    expect(callsBeforeDeletion).toBeGreaterThan(0);
  });

  it('offers ConnectWise only when the deployment has a clientId', async () => {
    const fixture = await setup();
    env.PSA_CONNECTWISE_CLIENT_ID = undefined;

    const view = await fixture.agent.get(base(fixture.organizationId));
    expect(view.body.providers.find((entry: { provider: string }) => entry.provider === 'CONNECTWISE')).toMatchObject({
      available: false,
    });

    const refused = await fixture.agent.put(base(fixture.organizationId)).send({
      provider: 'CONNECTWISE',
      credentials: { site: 'api-na.myconnectwise.net', companyId: 'acme', publicKey: 'k', privateKey: 'p' },
    });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('PSA_PROVIDER_UNAVAILABLE');
  });

  it('refuses an Autotask zone that is not under autotask.net, storing nothing', async () => {
    const fixture = await setup();
    setGuardedTransportForTests(async (spec) => {
      if (spec.url.includes('zoneInformation')) {
        return {
          status: 'ok',
          statusCode: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({ url: 'https://evil.example/ATServicesRest/' }), 'utf8'),
        };
      }
      return psa.handle(spec);
    });

    const refused = await fixture.agent.put(base(fixture.organizationId)).send({
      provider: 'AUTOTASK',
      credentials: { username: 'api@example.com', secret: 'test-secret-not-real', integrationCode: 'CODE' },
    });

    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('autotask.net');
    expect(await prisma.psaConnection.count()).toBe(0);
  });

  it('validates a provider URL before storing it', async () => {
    const fixture = await setup();
    const refused = await fixture.agent.put(base(fixture.organizationId)).send({
      provider: 'HALOPSA',
      credentials: { resourceServer: 'http://localhost', clientId: 'a', clientSecret: 'b' },
    });

    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(refused.body.error.message).toContain('https://');
    expect(await prisma.psaConnection.count()).toBe(0);
  });
});
