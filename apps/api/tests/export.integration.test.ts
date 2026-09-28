import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { buildCsvExport, buildExportPayload, createExportJob, hashToken } from '../src/services/export/export.service.js';
import { resolveEntitlements } from '../src/services/entitlements/entitlement.service.js';
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
  const email = `exp-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Exp Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({ name: 'Export Agency', slug: `exp-${Date.now()}-${fixtureId}` });
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

async function requestExport(
  agent: ReturnType<typeof request.agent>,
  organizationId: string,
  body: Record<string, unknown> = {},
) {
  return agent.post(`/api/workspaces/${organizationId}/exports`).send(body);
}

describe('client data export', () => {
  beforeAll(resetDatabase);

  it('is available on the free plan, with no upgrade prompt', async () => {
    const { agent, organizationId } = await setup();

    await prisma.subscription.deleteMany({ where: { organizationId } });
    await prisma.organization.update({ where: { id: organizationId }, data: { plan: 'MOORING' } });

    const entitlements = await resolveEntitlements(organizationId);
    expect(entitlements.plan).toBe('MOORING');
    expect(entitlements.features['data.export']).toBe(true);

    const response = await requestExport(agent, organizationId);
    expect(response.status).toBe(201);
    expect(response.body.id).toBeTruthy();
    expect(response.body.token).toBeTruthy();
  });

  it('never lets one workspace read or download another workspace export', async () => {
    const owner = await setup();
    const attacker = await setup();

    expect(
      (await request(app).post(`/api/workspaces/${owner.organizationId}/exports`).send({})).status,
    ).toBe(401);

    const job = await requestExport(owner.agent, owner.organizationId, { format: 'JSON' });
    expect(job.status).toBe(201);

    const crossRead = await attacker.agent.get(
      `/api/workspaces/${attacker.organizationId}/exports/${job.body.id}`,
    );
    expect(crossRead.status).toBe(404);

    const crossDownload = await attacker.agent.get(
      `/api/workspaces/${attacker.organizationId}/exports/${job.body.id}/download?token=${encodeURIComponent(job.body.token)}`,
    );
    expect(crossDownload.status).toBe(404);

    const crossRevoke = await attacker.agent.delete(
      `/api/workspaces/${attacker.organizationId}/exports/${job.body.id}`,
    );
    expect(crossRevoke.status).toBe(404);

    expect((await requestExport(owner.agent, owner.organizationId)).status).toBe(201);
  });

  it('rejects a client or domain export with no target', async () => {
    const { agent, organizationId } = await setup();

    expect((await requestExport(agent, organizationId, { scope: 'CLIENT' })).status).toBe(400);
    expect((await requestExport(agent, organizationId, { scope: 'DOMAIN' })).status).toBe(400);
  });

  it('rejects a target that belongs to another workspace', async () => {
    const { agent, organizationId } = await setup();
    const other = await setup();
    const target = await seedClientDomain(other.agent, other.organizationId, 'Victim');

    const response = await requestExport(agent, organizationId, { scope: 'CLIENT', targetId: target.clientId });
    expect(response.status).toBe(404);
  });

  it('never includes a password, session token or oauth token', async () => {
    const { agent, organizationId } = await setup();
    await seedClientDomain(agent, organizationId, 'Redact');

    const user = await prisma.user.findFirstOrThrow({ where: { email: { endsWith: '@example.com' } }, select: { id: true } });
    await prisma.account.create({
      data: {
        id: `account-${Date.now()}`,
        userId: user.id,
        accountId: 'oauth-1',
        providerId: 'credential',
        password: 'hashed-password-value',
        accessToken: 'access-token-value',
        refreshToken: 'refresh-token-value',
        idToken: 'id-token-value',
      },
    });

    const job = await requestExport(agent, organizationId, { format: 'JSON' });
    expect(job.status).toBe(201);

    const download = await agent.get(
      `/api/workspaces/${organizationId}/exports/${job.body.id}/download?token=${encodeURIComponent(job.body.token)}`,
    );
    expect(download.status).toBe(200);

    const body = download.text;
    expect(body).not.toContain('hashed-password-value');
    expect(body).not.toContain('access-token-value');
    expect(body).not.toContain('refresh-token-value');
    expect(body).not.toContain('id-token-value');

    const payload = JSON.parse(body);
    expect(payload.data.users[0].linkedAccounts[0].providerId).toBe('credential');
    expect(payload.data.users[0].linkedAccounts[0].password).toBeUndefined();
  });

  it('excludes the session token while keeping the device record', async () => {
    const { agent, organizationId } = await setup();
    await seedClientDomain(agent, organizationId, 'Session');

    const user = await prisma.user.findFirstOrThrow({ where: { members: { some: { organizationId } } } });

    // A second session is added rather than overwriting the live one, so the
    // agent keeps its own valid cookie while the fixture token is still findable.
    await prisma.session.create({
      data: {
        id: `session-extra-${Date.now()}`,
        token: 'super-secret-session-token',
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        ipAddress: '203.0.113.10',
        userAgent: 'Fixture Browser',
      },
    });

    const job = await requestExport(agent, organizationId, { format: 'JSON' });
    const download = await agent.get(
      `/api/workspaces/${organizationId}/exports/${job.body.id}/download?token=${encodeURIComponent(job.body.token)}`,
    );

    expect(download.status).toBe(200);
    expect(download.text).not.toContain('super-secret-session-token');
    const payload = JSON.parse(download.text);
    expect(payload.data.sessions.length).toBeGreaterThan(0);
    expect(payload.data.sessions[0].token).toBeUndefined();
    expect(payload.data.sessions[0]).toHaveProperty('ipAddress');
  });

  it('exports named forensic data when the customer stored it', async () => {
    const { agent, organizationId } = await setup();
    const { domainId } = await seedClientDomain(agent, organizationId, 'Named');

    await prisma.dmarcForensicReport.create({
      data: {
        domainId,
        fingerprint: `fp-named-${Date.now()}`,
        feedbackType: 'feedback-report',
        reportedDomain: 'named.test',
        sourceIp: '45.83.12.9',
        redactionVersion: 1,
        retentionExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        recipientAddresses: ['enc:v1:ciphertext'],
        subjectLine: 'enc:v1:subject',
      },
    });

    const job = await requestExport(agent, organizationId, { format: 'JSON' });
    const download = await agent.get(
      `/api/workspaces/${organizationId}/exports/${job.body.id}/download?token=${encodeURIComponent(job.body.token)}`,
    );
    const payload = JSON.parse(download.text);

    expect(payload.data.forensicReports).toHaveLength(1);
    expect(payload.data.forensicReports[0].recipientAddresses).toEqual(['enc:v1:ciphertext']);
  });

  it('scopes a client export to that client and nothing else', async () => {
    const { agent, organizationId } = await setup();
    const first = await seedClientDomain(agent, organizationId, 'Alpha');
    await seedClientDomain(agent, organizationId, 'Beta');

    const job = await requestExport(agent, organizationId, { scope: 'CLIENT', targetId: first.clientId, format: 'JSON' });
    expect(job.status).toBe(201);

    const download = await agent.get(
      `/api/workspaces/${organizationId}/exports/${job.body.id}/download?token=${encodeURIComponent(job.body.token)}`,
    );
    const payload = JSON.parse(download.text);

    expect(payload.data.clients).toHaveLength(1);
    expect(payload.data.domains).toHaveLength(1);
    expect(payload.data.domains[0].name).toBe('alpha.test');
    expect(payload.meta.scopeLabel).toBe('client:Alpha');
  });

  it('refuses a download without a valid token', async () => {
    const { agent, organizationId } = await setup();
    const job = await requestExport(agent, organizationId);

    expect(
      (await agent.get(`/api/workspaces/${organizationId}/exports/${job.body.id}/download`)).status,
    ).toBe(400);

    expect(
      (
        await agent.get(
          `/api/workspaces/${organizationId}/exports/${job.body.id}/download?token=${'x'.repeat(40)}`,
        )
      ).status,
    ).toBe(404);
  });

  it('refuses a download after the link is revoked', async () => {
    const { agent, organizationId } = await setup();
    const job = await requestExport(agent, organizationId);

    const revoked = await agent.delete(`/api/workspaces/${organizationId}/exports/${job.body.id}`);
    expect(revoked.status).toBe(204);

    expect(
      (
        await agent.get(
          `/api/workspaces/${organizationId}/exports/${job.body.id}/download?token=${encodeURIComponent(job.body.token)}`,
        )
      ).status,
    ).toBe(404);
  });

  it('stores only a hash of the download token', async () => {
    const { agent, organizationId } = await setup();
    const job = await requestExport(agent, organizationId);

    const stored = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.body.id } });
    expect(stored.downloadTokenHash).toBe(hashToken(job.body.token));
    expect(stored.downloadTokenHash).not.toBe(job.body.token);
  });

  it('refuses a download after the link expires', async () => {
    const { agent, organizationId } = await setup();
    const job = await requestExport(agent, organizationId);

    await prisma.exportJob.update({
      where: { id: job.body.id },
      data: { downloadExpiresAt: new Date(Date.now() - 1000) },
    });

    expect(
      (
        await agent.get(
          `/api/workspaces/${organizationId}/exports/${job.body.id}/download?token=${encodeURIComponent(job.body.token)}`,
        )
      ).status,
    ).toBe(404);
  });

  it('serves csv as a spreadsheet with report and forensic rows', async () => {
    const { agent, organizationId } = await setup();
    const { domainId } = await seedClientDomain(agent, organizationId, 'Csv');

    await prisma.dmarcReport.create({
      data: {
        domainId,
        reportType: 'AGGREGATE',
        fingerprint: `fp-csv-${Date.now()}`,
        policyP: 'none',
        policyFraction: 100,
        recordCount: 1,
        records: { create: { sourceIp: '10.0.0.1', messageCount: 7, dkimResult: 'pass', spfResult: 'fail' } },
      },
    });

    const job = await requestExport(agent, organizationId, { format: 'CSV' });
    const download = await agent.get(
      `/api/workspaces/${organizationId}/exports/${job.body.id}/download?token=${encodeURIComponent(job.body.token)}`,
    );

    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('text/csv');
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['cache-control']).toBe('no-store');
    expect(download.text).toContain('source_ip');
    expect(download.text).toContain('10.0.0.1');
    expect(download.text).toContain('report_records');
  });

  it('quotes a csv cell that contains a comma', async () => {
    const payload = await buildExportPayload({
      organizationId: 'none',
      scope: 'ORGANIZATION',
      format: 'CSV',
      scopeLabel: 'test',
    });
    const csv = buildCsvExport({
      ...payload,
      data: {
        ...payload.data,
        reports: [
          {
            id: 'r1',
            receivedAt: new Date('2026-01-01T00:00:00.000Z'),
            policyDomain: 'example.com',
            policyP: 'none',
            policyFraction: 100,
            records: [{ sourceIp: '10.0.0.1', messageCount: 1, disposition: 'none', dkimResult: 'pass', spfResult: 'pass', headerFrom: 'a,b.test', policyReason: null }],
          },
        ],
      },
    });

    expect(csv).toContain('"a,b.test"');
  });

  it('records the request, the download and the revocation in the audit trail', async () => {
    const { agent, organizationId } = await setup();
    const job = await requestExport(agent, organizationId);

    await agent.get(
      `/api/workspaces/${organizationId}/exports/${job.body.id}/download?token=${encodeURIComponent(job.body.token)}`,
    );
    await agent.delete(`/api/workspaces/${organizationId}/exports/${job.body.id}`);

    const actions = (
      await prisma.auditLog.findMany({ where: { organizationId, targetId: job.body.id } })
    ).map((entry) => entry.action);

    expect(actions).toEqual(expect.arrayContaining(['EXPORT_REQUESTED', 'EXPORT_DOWNLOADED', 'EXPORT_REVOKED']));
  });

  it('lists exports for the workspace without exposing tokens', async () => {
    const { agent, organizationId } = await setup();
    await requestExport(agent, organizationId);

    const list = await agent.get(`/api/workspaces/${organizationId}/exports`);
    expect(list.status).toBe(200);
    expect(list.body.exports).toHaveLength(1);
    expect(list.body.exports[0].downloadTokenHash).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain('downloadTokenHash');
  });

  it('states in the file that credentials are excluded', async () => {
    const { organizationId } = await setup();
    const { token, id, expiresAt } = await createExportJob({
      organizationId,
      requestedById: 'someone',
      scope: 'ORGANIZATION',
      format: 'JSON',
    });

    expect(token).toBeTruthy();
    expect(id).toBeTruthy();
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const payload = await buildExportPayload({
      organizationId,
      scope: 'ORGANIZATION',
      format: 'JSON',
      scopeLabel: 'workspace',
    });

    expect(payload.meta.notice).toContain('never included');
    expect(payload.data).toHaveProperty('forensicReports');
    expect(payload.data).toHaveProperty('auditLog');
  });
});
