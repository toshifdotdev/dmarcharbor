import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateAlertRules, evaluateRule, getAlertRule } from '../src/services/alert.service.js';
import { prisma } from '../src/database/prisma.js';
import { grantPlan } from './helpers/plan.js';
import { app } from '../src/index.js';
import { ingestDmarcReport } from '../src/services/report.service.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

function report(domain: string, reportId: string, rows: { ip: string; count: number; dkim: string; spf: string; spfDomain: string }[]) {
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
${rows
  .map(
    (row) => `  <record>
    <row>
      <source_ip>${row.ip}</source_ip>
      <count>${row.count}</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>${row.dkim}</dkim><spf>${row.spf}</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>${row.spfDomain}</header_from>
      <envelope_from>${row.spfDomain}</envelope_from>
    </identifiers>
    <auth_results>
      <spf><domain>${row.spfDomain}</domain><scope>mfrom</scope><result>${row.spf}</result></spf>
    </auth_results>
  </record>`,
  )
  .join('\n')}
</feedback>`;
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "notification", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function createWorkspaceDomain() {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `spoofalert-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Spoof Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Spoof Agency',
    slug: `spoof-${Date.now()}-${fixtureId}`,
  });
  await grantPlan(workspace.body.id);

  const client = await agent.post(`/api/workspaces/${workspace.body.id}/clients`).send({
    name: 'Spoof Client',
    slug: `spoof-client-${Date.now()}-${fixtureId}`,
  });
  const domainName = `spoofalert-${fixtureId}.test`;
  const domain = await agent.post(`/api/workspaces/${workspace.body.id}/clients/${client.body.id}/domains`).send({
    name: domainName,
  });

  await prisma.domain.update({
    where: { id: domain.body.id },
    data: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      dmarcPolicy: 'none',
      dmarcRecord: 'v=DMARC1; p=none; rua=mailto:agg@reports.dmarcharbor.com',
    },
  });

  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: workspace.body.id } });

  return {
    agent,
    organizationId: workspace.body.id as string,
    domainId: domain.body.id as string,
    domainName,
    userId: member.userId,
  };
}

async function createSpoofRule(
  agent: ReturnType<typeof request.agent>,
  organizationId: string,
  domainId: string,
  userId: string,
) {
  const created = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
    domainId,
    name: 'New unauthenticated source',
    metric: 'NEW_UNAUTHENTICATED_SOURCE',
    operator: 'GREATER_THAN_OR_EQUAL',
    threshold: 1,
    windowMinutes: 1440,
    cooldownMinutes: 1440,
    maxReminderLevel: 3,
    recipientUserIds: [userId],
  });

  expect(created.status).toBe(201);
  return created.body.id as string;
}

describe('new unauthenticated source alerting', () => {
  beforeAll(resetDatabase);

  it('fires when a new source fails both SPF and DKIM', async () => {
    const { agent, organizationId, domainId, domainName, userId } = await createWorkspaceDomain();
    const ruleId = await createSpoofRule(agent, organizationId, domainId, userId);

    expect(
      (
        await ingestDmarcReport({
          organizationId,
          domainId,
          xml: report(domainName, 'spoof-alert-1', [
            { ip: '45.83.12.9', count: 400, dkim: 'fail', spf: 'fail', spfDomain: 'evil-lookalike.test' },
            { ip: '10.20.30.40', count: 500, dkim: 'pass', spf: 'pass', spfDomain: 'legit-esp.test' },
          ]),
        })
      ).status,
    ).toBe('created');

    const results = await evaluateAlertRules();
    const result = results.find((entry) => entry.ruleId === ruleId);

    expect(result?.outcome).toBe('triggered');
    expect(result?.observed).toBe(1);

    const event = await prisma.alertEvent.findFirstOrThrow({ where: { ruleId } });
    expect(event.metric).toBe('NEW_UNAUTHENTICATED_SOURCE');
    expect(event.observedValue).toBe(1);
    expect(event.summary).toContain('failed both SPF and DKIM');
    expect(event.summary).toContain('evil-lookalike.test');
    expect(event.summary).toContain('passes at least one');

    const context = event.context as { newUnauthenticatedSources: { senderDomain: string; sourceIps: string[] }[] };
    expect(context.newUnauthenticatedSources).toHaveLength(1);
    expect(context.newUnauthenticatedSources[0].senderDomain).toBe('evil-lookalike.test');
    expect(context.newUnauthenticatedSources[0].sourceIps).toContain('45.83.12.9');
  });

  it('stays quiet when every sender authenticates', async () => {
    const { agent, organizationId, domainId, domainName, userId } = await createWorkspaceDomain();
    const ruleId = await createSpoofRule(agent, organizationId, domainId, userId);

    await ingestDmarcReport({
      organizationId,
      domainId,
      xml: report(domainName, 'spoof-alert-2', [
        { ip: '10.20.30.41', count: 600, dkim: 'pass', spf: 'pass', spfDomain: 'clean-esp.test' },
        { ip: '10.20.30.42', count: 300, dkim: 'pass', spf: 'fail', spfDomain: 'half-configured.test' },
      ]),
    });

    const result = (await evaluateAlertRules()).find((entry) => entry.ruleId === ruleId);
    expect(result?.outcome).toBe('unchanged');
    expect(result?.observed).toBe(0);
  });

  it('ignores a source that has been known for longer than the new sender window', async () => {
    const { agent, organizationId, domainId, domainName, userId } = await createWorkspaceDomain();
    const ruleId = await createSpoofRule(agent, organizationId, domainId, userId);

    await ingestDmarcReport({
      organizationId,
      domainId,
      xml: report(domainName, 'spoof-alert-3', [
        { ip: '45.83.12.12', count: 400, dkim: 'fail', spf: 'fail', spfDomain: 'long-known-bad.test' },
      ]),
    });

    await prisma.dmarcReport.updateMany({
      where: { domainId },
      data: { receivedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });

    const result = (await evaluateAlertRules()).find((entry) => entry.ruleId === ruleId);
    expect(result?.observed).toBe(0);
  });

  it('treats a spoofing alert as high risk so it is never filtered as low priority', async () => {
    const { agent, organizationId, domainId, userId } = await createWorkspaceDomain();
    const ruleId = await createSpoofRule(agent, organizationId, domainId, userId);

    const rule = await getAlertRule(organizationId, ruleId);
    expect(rule).toBeTruthy();

    await prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, onlyHighRiskAlerts: true },
      update: { onlyHighRiskAlerts: true },
    });

    const snapshot = await evaluateRule(rule!).then((outcome) => outcome.snapshot);
    expect(snapshot.newUnauthenticatedSources).toEqual([]);
  });

  it('rejects an unknown metric', async () => {
    const { agent, organizationId, domainId, userId } = await createWorkspaceDomain();

    const invalid = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Not a metric',
      metric: 'SOMETHING_ELSE',
      operator: 'GREATER_THAN',
      threshold: 1,
      recipientUserIds: [userId],
    });

    expect(invalid.status).toBe(400);
  });

  it('delivers an in app notification to recipients', async () => {
    const { agent, organizationId, domainId, domainName, userId } = await createWorkspaceDomain();
    const ruleId = await createSpoofRule(agent, organizationId, domainId, userId);

    await ingestDmarcReport({
      organizationId,
      domainId,
      xml: report(domainName, 'spoof-alert-4', [
        { ip: '45.83.12.13', count: 300, dkim: 'fail', spf: 'fail', spfDomain: 'notify-spoof.test' },
      ]),
    });

    await evaluateAlertRules();

    const notifications = await prisma.notification.findMany({ where: { userId } });
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.some((entry) => entry.alertEventId)).toBe(true);

    const event = await prisma.alertEvent.findFirstOrThrow({ where: { ruleId } });
    const deliveries = await prisma.alertDelivery.findMany({ where: { eventId: event.id } });
    expect(deliveries.length).toBeGreaterThan(0);
  });
});
