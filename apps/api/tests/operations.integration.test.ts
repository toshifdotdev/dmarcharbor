import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { purgeExpiredReports } from '../src/services/report.service.js';
import { reportRetentionDays, reportRetentionExpiry } from '../src/services/privacy.service.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

function aggregateReport(domain: string, reportId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>Google LLC</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>${reportId}</report_id>
    <date_range><begin>1712188800</begin><end>1712275199</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><fraction>100</fraction>
  </policy_published>
  <record>
    <row>
      <source_ip>192.0.2.1</source_ip>
      <count>1250</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>${domain}</header_from></identifiers>
  </record>
</feedback>`;
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup(options: { ruf?: boolean } = {}) {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `ops-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await agent.post('/api/auth/sign-up/email').send({ name: 'Ops Owner', email, password });
  expect(signUp.status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const signIn = await agent.post('/api/auth/sign-in/email').send({ email, password });
  expect(signIn.status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Ops Agency',
    slug: `ops-${Date.now()}-${fixtureId}`,
  });
  expect(workspace.status).toBe(201);

  const client = await agent.post(`/api/workspaces/${workspace.body.id}/clients`).send({
    name: 'Ops Client',
    slug: `ops-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);

  const domain = await agent.post(`/api/workspaces/${workspace.body.id}/clients/${client.body.id}/domains`).send({
    name: `ops-${fixtureId}.test`,
  });
  expect(domain.status).toBe(201);

  await prisma.domain.update({
    where: { id: domain.body.id },
    data: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      collectForensicReports: true,
      dmarcRecord: `v=DMARC1; p=none; rua=mailto:dmarc-reports@reports.dmarcharbor.com${
        options.ruf === false ? '' : '; ruf=mailto:dmarc-forensics@reports.dmarcharbor.com'
      }`,
    },
  });

  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: workspace.body.id } });

  return {
    agent,
    organizationId: workspace.body.id as string,
    domainId: domain.body.id as string,
    userId: member.userId as string,
  };
}

describe('system probes', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('answers the liveness probe without touching dependencies', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', service: 'dmarcharbor-api' });
  });

  it('reports readiness with a real database check and a latency figure', async () => {
    const response = await request(app).get('/api/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks.database.status).toBe('ok');
    expect(typeof response.body.checks.database.latencyMs).toBe('number');
  });

  it('exposes the effective retention and alerting configuration', async () => {
    const response = await request(app).get('/api/meta');

    expect(response.status).toBe(200);
    expect(response.body.retention.reportDays).toBeGreaterThan(0);
    expect(response.body.retention.forensicDays).toBeGreaterThan(0);
    expect(response.body.retention.forensicPiiDays).toBeLessThanOrEqual(response.body.retention.forensicDays);
    expect(response.body.alerting.evaluationIntervalMinutes).toBeGreaterThan(0);
  });

  it('serves the OpenAPI document at a stable url', async () => {
    const response = await request(app).get('/api/docs/openapi.json');

    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.1.0');
    expect(Object.keys(response.body.paths).length).toBeGreaterThan(20);
  });
});

describe('aggregate report retention', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('stamps every stored report with a retention expiry', async () => {
    const { agent, organizationId, domainId } = await setup();

    const created = await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport(`ops-${fixtureId}.test`, `retention-${Date.now()}`),
    });
    expect(created.status).toBe(201);

    const stored = await prisma.dmarcReport.findFirstOrThrow({ where: { domainId } });
    expect(stored.retentionExpiresAt).not.toBeNull();
    expect(stored.retentionExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(reportRetentionDays()).toBeGreaterThanOrEqual(7);
    expect(reportRetentionExpiry(new Date('2026-01-01T00:00:00.000Z')).getTime()).toBeGreaterThan(
      new Date('2026-01-01T00:00:00.000Z').getTime(),
    );
  });

  it('deletes reports once the retention window has passed', async () => {
    const { agent, organizationId, domainId } = await setup();
    const domainName = `ops-${fixtureId}.test`;

    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport(domainName, `purge-${Date.now()}`),
    });

    const stored = await prisma.dmarcReport.findFirstOrThrow({ where: { domainId } });
    expect(stored.retentionExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    await prisma.dmarcReport.update({
      where: { id: stored.id },
      data: { retentionExpiresAt: new Date(Date.now() - 1000) },
    });

    const purged = await purgeExpiredReports(true);
    expect(purged).toBe(1);
    expect(await prisma.dmarcReport.count({ where: { domainId } })).toBe(0);
    expect(await prisma.dmarcReportRecord.count({ where: { reportId: stored.id } })).toBe(0);
  });
});

describe('audit trail', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('records the identity toggle in both directions with the actor and request id', async () => {
    const { agent, organizationId, domainId, userId } = await setup();

    const enabled = await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domainId}/forensics/identities`)
      .set('X-Request-Id', 'audit-trace-1')
      .send({ retainForensicPii: true, confirmLegalBasis: true });
    expect(enabled.status).toBe(200);

    const events = await prisma.auditLog.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('FORENSIC_IDENTITY_ENABLED');
    expect(events[0].actorUserId).toBe(userId);
    expect(events[0].domainId).toBe(domainId);
    expect(events[0].requestId).toBe('audit-trace-1');
    expect(events[0].outcome).toBe('SUCCESS');
    expect(events[0].detail).toMatchObject({ retainForensicPii: true, identitiesDestroyed: 0 });

    const disabled = await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domainId}/forensics/identities`)
      .send({ retainForensicPii: false, confirmNamePurge: true });
    expect(disabled.status).toBe(200);

    const after = await prisma.auditLog.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } });
    expect(after).toHaveLength(2);
    expect(after[1].action).toBe('FORENSIC_IDENTITY_DISABLED');
  });

  it('records share link creation and revocation', async () => {
    const { agent, organizationId, domainId } = await setup();

    const share = await agent.post(`/api/workspaces/${organizationId}/report-shares`).send({ domainId });
    expect(share.status).toBe(201);

    const created = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId, action: 'REPORT_SHARE_CREATED' },
    });
    expect(created.targetType).toBe('report_share');
    expect(created.targetId).toBe(share.body.id);
    expect(created.detail).toMatchObject({ includeForensics: false, includeSources: true });

    await agent.delete(`/api/workspaces/${organizationId}/report-shares/${share.body.id}`);
    const revoked = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId, action: 'REPORT_SHARE_REVOKED' },
    });
    expect(revoked.targetId).toBe(share.body.id);
  });

  it('records alert rule lifecycle and acknowledgement', async () => {
    const { agent, organizationId, domainId, userId } = await setup();

    const failingReport = aggregateReport(`ops-${fixtureId}.test`, `audit-alert-${Date.now()}`).replace(
      '<dkim>pass</dkim>',
      '<dkim>fail</dkim>',
    );

    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: failingReport,
    });

    const rule = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Audited rule',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 1,
      recipientUserIds: [userId],
    });
    expect(rule.status).toBe(201);

    const { evaluateAlertRules } = await import('../src/services/alert.service.js');
    await evaluateAlertRules();
    const event = await prisma.alertEvent.findFirstOrThrow({ where: { ruleId: rule.body.id } });

    await agent.post(`/api/workspaces/${organizationId}/alerts/${event.id}/acknowledge`);

    const actions = (await prisma.auditLog.findMany({ where: { organizationId } })).map((entry) => entry.action);
    expect(actions).toContain('ALERT_RULE_CREATED');
    expect(actions).toContain('ALERT_ACKNOWLEDGED');
  });

  it('records digest creation and deletion', async () => {
    const { agent, organizationId, domainId } = await setup();

    const digest = await agent.post(`/api/workspaces/${organizationId}/report-digests`).send({
      domainId,
      recipientEmails: ['client@example.com'],
    });
    expect(digest.status).toBe(201);

    await agent.delete(`/api/workspaces/${organizationId}/report-digests/${digest.body.id}`);

    const actions = (await prisma.auditLog.findMany({ where: { organizationId } })).map((entry) => entry.action);
    expect(actions).toContain('REPORT_DIGEST_CREATED');
    expect(actions).toContain('REPORT_DIGEST_DELETED');
  });

  it('exposes the trail to the workspace and never to another workspace', async () => {
    const first = await setup();
    const other = await setup();

    await first.agent
      .patch(`/api/workspaces/${first.organizationId}/domains/${first.domainId}/forensics/identities`)
      .send({ retainForensicPii: true, confirmLegalBasis: true });

    const own = await first.agent.get(`/api/workspaces/${first.organizationId}/audit-events`);
    expect(own.status).toBe(200);
    expect(own.body.items).toHaveLength(1);
    expect(own.body.items[0].action).toBe('FORENSIC_IDENTITY_ENABLED');
    expect(own.body.items[0].actorUser.email).toBeTruthy();

    const foreign = await other.agent.get(`/api/workspaces/${other.organizationId}/audit-events`);
    expect(foreign.status).toBe(200);
    expect(foreign.body.items).toHaveLength(0);
  });

  it('keeps audit rows append only by never exposing an update or delete route', async () => {
    const { agent, organizationId } = await setup();

    const patched = await agent.patch(`/api/workspaces/${organizationId}/audit-events`);
    expect(patched.status).toBe(404);

    const deleted = await agent.delete(`/api/workspaces/${organizationId}/audit-events`);
    expect(deleted.status).toBe(404);
  });
});
