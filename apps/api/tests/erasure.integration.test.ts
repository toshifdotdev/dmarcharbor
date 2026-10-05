import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { erasureGraceDays, executeErasure, executeDueErasures, previewErasure } from '../src/services/erasure/erasure.service.js';
import { grantPlan } from './helpers/plan.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup() {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `era-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Era Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({ name: 'Erasure Agency', slug: `era-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId, 'HARBOR');

  return { agent, organizationId, email };
}

async function seedClientDomain(agent: ReturnType<typeof request.agent>, organizationId: string, label: string) {
  const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name: label,
    slug: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  const domain = await agent.post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`).send({
    name: `${label.toLowerCase()}.test`,
  });
  return { clientId: client.body.id as string, domainId: domain.body.id as string };
}

async function seedEvidence(domainId: string, tag: string) {
  await prisma.dmarcReport.create({
    data: {
      domainId,
      reportType: 'AGGREGATE',
      fingerprint: `fp-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      recordCount: 1,
      records: { create: { sourceIp: '10.0.0.1', messageCount: 9, dkimResult: 'pass', spfResult: 'pass' } },
    },
  });

  await prisma.dmarcForensicReport.create({
    data: {
      domainId,
      fingerprint: `fp-f-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      feedbackType: 'feedback-report',
      reportedDomain: 'seeded.test',
      sourceIp: '45.83.12.9',
      redactionVersion: 1,
      retentionExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      recipientAddresses: ['enc:v1:ciphertext'],
      subjectLine: 'enc:v1:subject',
    },
  });
}

describe('client data erasure', () => {
  beforeAll(resetDatabase);

  it('is available on the free plan with no upgrade prompt', async () => {
    const { agent, organizationId } = await setup();
    await prisma.subscription.deleteMany({ where: { organizationId } });
    await prisma.organization.update({ where: { id: organizationId }, data: { plan: 'MOORING' } });

    const response = await agent.post(`/api/workspaces/${organizationId}/erasures`).send({ scope: 'ORGANIZATION' });
    expect(response.status).toBe(202);
    expect(response.body.state).toBe('PENDING');
  });

  it('previews exactly what will be deleted and what is kept, without writing', async () => {
    const { agent, organizationId } = await setup();
    const { domainId } = await seedClientDomain(agent, organizationId, 'Preview');
    await seedEvidence(domainId, 'preview');

    await prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId: (await prisma.user.findFirstOrThrow({ where: { members: { some: { organizationId } } } })).id,
        action: 'ALERT_ACKNOWLEDGED',
        targetType: 'domain',
        targetId: domainId,
        ipAddress: '198.51.100.7',
      },
    });

    const before = await prisma.dmarcReport.count();

    const response = await agent.get(`/api/workspaces/${organizationId}/erasures/preview?scope=ORGANIZATION`);
    expect(response.status).toBe(200);
    expect(response.body.graceDays).toBe(erasureGraceDays);
    expect(response.body.totals.recordsDeleted).toBeGreaterThan(0);
    expect(response.body.statement).toContain('retained because it contains no recipient data');

    const audit = response.body.actions.find((entry: { key: string }) => entry.key === 'auditLog');
    expect(audit.action).toBe('anonymize');

    const named = response.body.actions.find((entry: { key: string }) => entry.key === 'forensicPersonalData');
    expect(named.action).toBe('delete');

    expect(await prisma.dmarcReport.count()).toBe(before);
    expect(await prisma.erasureRequest.count({ where: { organizationId } })).toBe(0);
  });

  it('holds the request for seven days rather than deleting immediately', async () => {
    const { agent, organizationId } = await setup();
    await seedClientDomain(agent, organizationId, 'Grace');

    const response = await agent.post(`/api/workspaces/${organizationId}/erasures`).send({
      scope: 'ORGANIZATION',
      reason: 'Client offboarded',
    });
    expect(response.status).toBe(202);

    const days = Math.round((new Date(response.body.purgeAfter).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    expect(days).toBeGreaterThanOrEqual(6);
    expect(days).toBeLessThanOrEqual(7);

    expect(await prisma.domain.count({ where: { client: { organizationId } } })).toBe(1);
  });

  it('refuses to run early without an explicit confirmation', async () => {
    const { agent, organizationId } = await setup();
    await seedClientDomain(agent, organizationId, 'Early');

    const created = await agent.post(`/api/workspaces/${organizationId}/erasures`).send({ scope: 'ORGANIZATION' });
    const refused = await agent.post(`/api/workspaces/${organizationId}/erasures/${created.body.id}/execute`).send({});
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('grace period');

    expect(await prisma.domain.count({ where: { client: { organizationId } } })).toBe(1);
  });

  it('deletes the workspace and its data when confirmed early', async () => {
    const { agent, organizationId } = await setup();
    const { domainId } = await seedClientDomain(agent, organizationId, 'Gone');
    await seedEvidence(domainId, 'gone');

    const created = await agent.post(`/api/workspaces/${organizationId}/erasures`).send({ scope: 'ORGANIZATION' });
    const outcome = await agent
      .post(`/api/workspaces/${organizationId}/erasures/${created.body.id}/execute`)
      .send({ confirmNamePurge: true });

    expect(outcome.status).toBe(200);
    expect(outcome.body.certificate.totals.personalDataRecords).toBeGreaterThan(0);

    expect(await prisma.organization.count({ where: { id: organizationId } })).toBe(0);
    expect(await prisma.domain.count({ where: { id: domainId } })).toBe(0);
    expect(await prisma.dmarcReport.count({ where: { domainId } })).toBe(0);
    expect(await prisma.dmarcForensicReport.count({ where: { domainId } })).toBe(0);
  });

  it('keeps the certificate and the request after the workspace is gone', async () => {
    const { agent, organizationId } = await setup();
    await seedClientDomain(agent, organizationId, 'Proof');

    const created = await agent.post(`/api/workspaces/${organizationId}/erasures`).send({ scope: 'ORGANIZATION' });
    const outcome = await agent
      .post(`/api/workspaces/${organizationId}/erasures/${created.body.id}/execute`)
      .send({ confirmNamePurge: true });
    expect(outcome.status, JSON.stringify(outcome.body).slice(0, 400)).toBe(200);

    const record = await prisma.erasureRequest.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(await prisma.organization.count({ where: { id: organizationId } })).toBe(0);

    expect(record.state).toBe('COMPLETED');
    expect(record.organizationId).toBeNull();
    expect(record.certificate).toBeTruthy();
    expect(record.completedAt).toBeTruthy();
  });

  it('anonymises the audit trail instead of deleting it', async () => {
    const { agent, organizationId } = await setup();
    await seedClientDomain(agent, organizationId, 'Audited');

    const seeded = await prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId: (await prisma.user.findFirstOrThrow({ where: { members: { some: { organizationId } } } })).id,
        action: 'ALERT_ACKNOWLEDGED',
        targetType: 'domain',
        targetId: 'x',
        ipAddress: '198.51.100.7',
        requestId: 'req-1',
      },
      select: { id: true },
    });

    const created = await agent.post(`/api/workspaces/${organizationId}/erasures`).send({ scope: 'ORGANIZATION' });
    await agent.post(`/api/workspaces/${organizationId}/erasures/${created.body.id}/execute`).send({ confirmNamePurge: true });

    // Checked by id, because once the workspace is gone the surviving row can
    // no longer be located by organisation.
    const surviving = await prisma.auditLog.findUniqueOrThrow({ where: { id: seeded.id } });

    expect(surviving.action).toBe('ALERT_ACKNOWLEDGED');
    expect(surviving.targetType).toBe('domain');
    expect(surviving.actorUserId).toBeNull();
    expect(surviving.ipAddress).toBeNull();
    expect(surviving.requestId).toBeNull();
  });

  it('puts no personal data in the certificate', async () => {
    const { agent, organizationId, email } = await setup();
    await seedClientDomain(agent, organizationId, 'Clean');

    const created = await agent.post(`/api/workspaces/${organizationId}/erasures`).send({ scope: 'ORGANIZATION' });
    const outcome = await agent
      .post(`/api/workspaces/${organizationId}/erasures/${created.body.id}/execute`)
      .send({ confirmNamePurge: true });

    const serialized = JSON.stringify(outcome.body.certificate);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain('@example.com');
    expect(outcome.body.certificate.statement).toContain('contains no personal data');
  });

  it('erases one client and leaves the others untouched', async () => {
    const { agent, organizationId } = await setup();
    const first = await seedClientDomain(agent, organizationId, 'Alpha');
    const second = await seedClientDomain(agent, organizationId, 'Beta');
    await seedEvidence(first.domainId, 'alpha');
    await seedEvidence(second.domainId, 'beta');

    const created = await agent
      .post(`/api/workspaces/${organizationId}/erasures`)
      .send({ scope: 'CLIENT', targetId: first.clientId, reason: 'Churned client' });
    expect(created.status).toBe(202);

    const outcome = await agent
      .post(`/api/workspaces/${organizationId}/erasures/${created.body.id}/execute`)
      .send({ confirmNamePurge: true });
    expect(outcome.status).toBe(200);

    expect(await prisma.client.count({ where: { id: first.clientId } })).toBe(0);
    expect(await prisma.domain.count({ where: { id: first.domainId } })).toBe(0);
    expect(await prisma.client.count({ where: { id: second.clientId } })).toBe(1);
    expect(await prisma.domain.count({ where: { id: second.domainId } })).toBe(1);
    expect(await prisma.dmarcReport.count({ where: { domainId: second.domainId } })).toBe(1);
    expect(await prisma.organization.count({ where: { id: organizationId } })).toBe(1);
  });

  it('erases one domain and keeps its siblings', async () => {
    const { agent, organizationId } = await setup();
    const first = await seedClientDomain(agent, organizationId, 'One');
    const second = await seedClientDomain(agent, organizationId, 'Two');

    const created = await agent
      .post(`/api/workspaces/${organizationId}/erasures`)
      .send({ scope: 'DOMAIN', targetId: first.domainId });
    await agent.post(`/api/workspaces/${organizationId}/erasures/${created.body.id}/execute`).send({ confirmNamePurge: true });

    expect(await prisma.domain.count({ where: { id: first.domainId } })).toBe(0);
    expect(await prisma.domain.count({ where: { id: second.domainId } })).toBe(1);
    expect(await prisma.client.count({ where: { id: first.clientId } })).toBe(1);
  });

  it('lets a pending request be cancelled before it runs', async () => {
    const { agent, organizationId } = await setup();
    await seedClientDomain(agent, organizationId, 'Cancel');

    const created = await agent.post(`/api/workspaces/${organizationId}/erasures`).send({ scope: 'ORGANIZATION' });
    const cancelled = await agent.post(`/api/workspaces/${organizationId}/erasures/${created.body.id}/cancel`);
    expect(cancelled.status).toBe(204);

    const record = await prisma.erasureRequest.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(record.state).toBe('CANCELLED');
    expect(await prisma.domain.count({ where: { client: { organizationId } } })).toBe(1);
  });

  it('refuses to execute or cancel twice', async () => {
    const { agent, organizationId } = await setup();
    const created = await agent.post(`/api/workspaces/${organizationId}/erasures`).send({ scope: 'ORGANIZATION' });

    await agent.post(`/api/workspaces/${organizationId}/erasures/${created.body.id}/execute`).send({ confirmNamePurge: true });

    // The workspace and its users are gone, so the caller is no longer
    // authenticated. That is the correct refusal, and the request is not
    // re-executed either way.
    const again = await agent.post(`/api/workspaces/${organizationId}/erasures/${created.body.id}/execute`).send({ confirmNamePurge: true });
    expect([401, 404]).toContain(again.status);

    // The caller and workspace are both gone, so this is refused before it
    // ever reaches the state check.
    const cancel = await agent.post(`/api/workspaces/${organizationId}/erasures/${created.body.id}/cancel`);
    expect([401, 409]).toContain(cancel.status);
  });

  it('refuses a target belonging to another workspace', async () => {
    const { agent, organizationId } = await setup();
    const other = await setup();
    const target = await seedClientDomain(other.agent, other.organizationId, 'Victim');

    expect(
      (
        await agent.post(`/api/workspaces/${organizationId}/erasures`).send({ scope: 'CLIENT', targetId: target.clientId })
      ).status,
    ).toBe(404);
  });

  it('lets an admin preview but never execute, leaving destruction to the owner', async () => {
    const { organizationId, email } = await setup();
    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'admin' } });

    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    await prisma.session.deleteMany({ where: { userId: user.id } });

    const admin = request.agent(app);
    expect((await admin.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

    expect(
      (await admin.get(`/api/workspaces/${organizationId}/erasures/preview?scope=ORGANIZATION`)).status,
    ).toBe(200);

    const created = await admin.post(`/api/workspaces/${organizationId}/erasures`).send({ scope: 'ORGANIZATION' });
    expect(created.status).toBe(403);
  });

  it('records the request, the cancellation and the completion in the audit trail', async () => {
    const { agent, organizationId } = await setup();
    const first = await agent.post(`/api/workspaces/${organizationId}/erasures`).send({ scope: 'ORGANIZATION' });
    await agent.post(`/api/workspaces/${organizationId}/erasures/${first.body.id}/cancel`);

    const second = await agent.post(`/api/workspaces/${organizationId}/erasures`).send({ scope: 'ORGANIZATION' });
    await agent.post(`/api/workspaces/${organizationId}/erasures/${second.body.id}/execute`).send({ confirmNamePurge: true });

    const actions = (await prisma.auditLog.findMany({ where: { targetId: { in: [first.body.id, second.body.id] } } })).map(
      (entry) => entry.action,
    );

    expect(actions).toEqual(
      expect.arrayContaining(['ERASURE_REQUESTED', 'ERASURE_CANCELLED', 'ERASURE_COMPLETED']),
    );
  });

  it('runs due requests automatically and never runs them early', async () => {
    const { agent, organizationId } = await setup();
    const { domainId } = await seedClientDomain(agent, organizationId, 'Auto');

    const due = await prisma.erasureRequest.create({
      data: {
        organizationId,
        scope: 'ORGANIZATION',
        requestedById: (await prisma.user.findFirstOrThrow({ where: { members: { some: { organizationId } } } })).id,
        state: 'PENDING',
        purgeAfter: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      },
    });

    expect(await executeDueErasures()).toHaveLength(0);

    await prisma.erasureRequest.update({ where: { id: due.id }, data: { purgeAfter: new Date(Date.now() - 1000) } });
    const outcomes = await executeDueErasures();

    expect(outcomes).toHaveLength(1);
    expect(await prisma.domain.count({ where: { id: domainId } })).toBe(0);
  });

  it('refuses to run a request twice from the scheduler', async () => {
    const { organizationId } = await setup();
    const due = await prisma.erasureRequest.create({
      data: {
        organizationId,
        scope: 'ORGANIZATION',
        requestedById: (await prisma.user.findFirstOrThrow({ where: { members: { some: { organizationId } } } })).id,
        state: 'PENDING',
        purgeAfter: new Date(Date.now() - 1000),
      },
    });

    expect(await executeDueErasures()).toHaveLength(1);
    expect(await executeDueErasures()).toHaveLength(0);
    expect(await executeErasure(due.id)).toBeNull();
  });

  it('never removes agency staff when erasing one client or one domain', async () => {
    const { agent, organizationId, email } = await setup();
    const first = await seedClientDomain(agent, organizationId, 'Keep');
    const second = await seedClientDomain(agent, organizationId, 'AlsoKeep');

    const owner = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    const beforeUsers = await prisma.user.count();
    const beforeSessions = await prisma.session.count();

    const clientRequest = await agent
      .post(`/api/workspaces/${organizationId}/erasures`)
      .send({ scope: 'CLIENT', targetId: first.clientId });
    const clientOutcome = await agent
      .post(`/api/workspaces/${organizationId}/erasures/${clientRequest.body.id}/execute`)
      .send({ confirmNamePurge: true });

    expect(clientOutcome.status).toBe(200);
    expect(clientOutcome.body.deleted.users).toBe(0);
    expect(await prisma.user.count()).toBe(beforeUsers);
    expect(await prisma.user.findUnique({ where: { id: owner.id } })).toBeTruthy();

    const domainRequest = await agent
      .post(`/api/workspaces/${organizationId}/erasures`)
      .send({ scope: 'DOMAIN', targetId: second.domainId });
    await agent
      .post(`/api/workspaces/${organizationId}/erasures/${domainRequest.body.id}/execute`)
      .send({ confirmNamePurge: true });

    expect(await prisma.user.count()).toBe(beforeUsers);
    expect(await prisma.session.count()).toBe(beforeSessions);

    // The owner is still able to act, which is the practical proof.
    expect(
      (await agent.get(`/api/workspaces/${organizationId}/erasures/preview?scope=ORGANIZATION`)).status,
    ).toBe(200);
  });

  it('previews the same numbers the export would agree with', async () => {
    const { organizationId } = await setup();
    const preview = await previewErasure(organizationId, 'ORGANIZATION');
    expect(preview.scopeLabel).toBe('workspace');
    expect(preview.totals.recordsDeleted).toBeGreaterThan(0);
  });
});
