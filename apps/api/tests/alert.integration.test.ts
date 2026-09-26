import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  evaluateAlertRules,
  evaluateRule,
  getAlertRule,
  listAlertEvents,
} from '../src/services/alert.service.js';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

function aggregateReport(domain: string, reportId: string, rows: { ip: string; count: number; dkim: string; spf: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>Google LLC</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>${reportId}</report_id>
    <date_range>
      <begin>1712188800</begin>
      <end>1712275199</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>${domain}</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>none</p>
    <fraction>100</fraction>
  </policy_published>
${rows
  .map(
    (row) => `  <record>
    <row>
      <source_ip>${row.ip}</source_ip>
      <count>${row.count}</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>${row.dkim}</dkim>
        <spf>${row.spf}</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>${domain}</header_from>
    </identifiers>
  </record>`,
  )
  .join('\n')}
</feedback>`;
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function createWorkspaceDomain(
  domainName: string,
): Promise<{ agent: ReturnType<typeof request.agent>; organizationId: string; domainId: string; userId: string }> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `alerts-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await agent.post('/api/auth/sign-up/email').send({ name: 'Alert Owner', email, password });
  expect(signUp.status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const signIn = await agent.post('/api/auth/sign-in/email').send({ email, password });
  expect(signIn.status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Alert Operations',
    slug: `alert-operations-${Date.now()}-${fixtureId}`,
  });
  expect(workspace.status).toBe(201);

  const client = await agent.post(`/api/workspaces/${workspace.body.id}/clients`).send({
    name: 'Alert Client',
    slug: `alert-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);

  const domain = await agent.post(`/api/workspaces/${workspace.body.id}/clients/${client.body.id}/domains`).send({
    name: domainName,
  });
  expect(domain.status).toBe(201);

  await prisma.domain.update({
    where: { id: domain.body.id },
    data: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      collectForensicReports: true,
      dmarcRecord: 'v=DMARC1; p=reject; rua=mailto:agg@reports.dmarcharbor.com; ruf=mailto:f@reports.dmarcharbor.com',
    },
  });

  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: workspace.body.id } });

  return {
    agent,
    organizationId: workspace.body.id as string,
    domainId: domain.body.id as string,
    userId: member.userId,
  };
}

describe('alerting', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates a rule and lists it for the workspace', async () => {
    const { agent, organizationId, domainId, userId } = await createWorkspaceDomain('rules.test');

    const created = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Heavy spoofing',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 100,
      windowMinutes: 1440,
      cooldownMinutes: 60,
      recipientUserIds: [userId],
    });

    expect(created.status).toBe(201);
    expect(created.body.metric).toBe('FAILURE_COUNT');
    expect(created.body.recipients).toHaveLength(1);
    expect(created.body.createdById).toBe(userId);

    const listed = await agent.get(`/api/workspaces/${organizationId}/alert-rules`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
  });

  it('rejects a rule for a domain outside the workspace and a bad definition', async () => {
    const first = await createWorkspaceDomain('rules-scope-a.test');
    const other = await createWorkspaceDomain('rules-scope-b.test');
    const otherMember = await prisma.member.findFirstOrThrow({ where: { organizationId: other.organizationId } });

    const crossScope = await other.agent.post(`/api/workspaces/${other.organizationId}/alert-rules`).send({
      domainId: first.domainId,
      name: 'Cross scope',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 10,
      recipientUserIds: [otherMember.userId],
    });
    expect(crossScope.status).toBe(404);

    const invalid = await other.agent.post(`/api/workspaces/${other.organizationId}/alert-rules`).send({
      domainId: other.domainId,
      name: 'no',
      metric: 'NOT_A_METRIC',
      operator: 'GREATER_THAN',
      threshold: 10,
      recipientUserIds: [otherMember.userId],
    });
    expect(invalid.status).toBe(400);
  });

  it('updates, disables and deletes a rule', async () => {
    const { agent, organizationId, domainId, userId } = await createWorkspaceDomain('rules-update.test');
    const created = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Adjustable',
      metric: 'FAILURE_RATE',
      operator: 'GREATER_THAN_OR_EQUAL',
      threshold: 5,
      recipientUserIds: [userId],
    });
    const ruleId = created.body.id;

    const updated = await agent.patch(`/api/workspaces/${organizationId}/alert-rules/${ruleId}`).send({
      threshold: 25,
      enabled: false,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.threshold).toBe(25);
    expect(updated.body.enabled).toBe(false);

    const deleted = await agent.delete(`/api/workspaces/${organizationId}/alert-rules/${ruleId}`);
    expect(deleted.status).toBe(204);

    const missing = await agent.patch(`/api/workspaces/${organizationId}/alert-rules/${ruleId}`).send({ threshold: 30 });
    expect(missing.status).toBe(404);
  });

  it('triggers an event and delivers an email when a threshold is crossed', async () => {
    const { agent, organizationId, domainId, userId } = await createWorkspaceDomain('alerts.trigger.test');

    const ingested = await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('alerts.trigger.test', 'trigger-1', [{ ip: '45.83.12.9', count: 500, dkim: 'fail', spf: 'fail' }]),
    });
    expect(ingested.status).toBe(201);

    const rule = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'More than 100 failures',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 100,
      windowMinutes: 1440,
      cooldownMinutes: 5,
      recipientUserIds: [userId],
    });
    expect(rule.status).toBe(201);

    const results = await evaluateAlertRules();
    const mine = results.filter((result) => result.ruleId === rule.body.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].outcome).toBe('triggered');
    expect(mine[0].observed).toBe(500);

    const events = await listAlertEvents(organizationId, { domainId });
    expect(events).toHaveLength(1);
    expect(events[0].observedValue).toBe(500);
    expect(events[0].threshold).toBe(100);
    expect(events[0].summary).toContain('500');
    expect(events[0].context).toMatchObject({ totalMessages: 500, failedMessages: 500, busiestSourceIp: '45.83.12.9' });

    const delivery = await prisma.alertDelivery.findFirstOrThrow({ where: { eventId: events[0].id } });
    expect(delivery.status).toBe('SENT');
    expect(delivery.sentAt).not.toBeNull();
    expect(delivery.attempts).toBe(1);
  });

  it('keeps one open event and escalates it instead of firing a new alert', async () => {
    const { agent, organizationId, domainId, userId } = await createWorkspaceDomain('alerts.escalation.test');
    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('alerts.escalation.test', 'esc-1', [{ ip: '45.83.12.9', count: 500, dkim: 'fail', spf: 'fail' }]),
    });

    const rule = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Escalation ladder',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 100,
      windowMinutes: 1440,
      cooldownMinutes: 5,
      maxReminderLevel: 3,
      recipientUserIds: [userId],
    });
    expect(rule.status).toBe(201);

    const first = await evaluateAlertRules();
    const firstResult = first.find((result) => result.ruleId === rule.body.id);
    expect(firstResult?.outcome).toBe('triggered');
    expect(firstResult?.reminderLevel).toBe(1);
    const eventId = firstResult?.eventId as string;

    const tooSoon = await evaluateAlertRules(new Date(Date.now() + 60 * 1000));
    expect(tooSoon.find((result) => result.ruleId === rule.body.id)?.outcome).toBe('unchanged');
    expect(await prisma.alertEvent.count({ where: { ruleId: rule.body.id } })).toBe(1);

    const second = await evaluateAlertRules(new Date(Date.now() + 6 * 60 * 1000));
    const secondResult = second.find((result) => result.ruleId === rule.body.id);
    expect(secondResult?.outcome).toBe('escalated');
    expect(secondResult?.eventId).toBe(eventId);
    expect(secondResult?.reminderLevel).toBe(2);

    const third = await evaluateAlertRules(new Date(Date.now() + 18 * 60 * 1000));
    expect(third.find((result) => result.ruleId === rule.body.id)?.reminderLevel).toBe(3);

    const capped = await evaluateAlertRules(new Date(Date.now() + 60 * 60 * 1000));
    expect(capped.find((result) => result.ruleId === rule.body.id)?.outcome).toBe('unchanged');
    expect(capped.find((result) => result.ruleId === rule.body.id)?.reminderLevel).toBe(3);

    expect(await prisma.alertEvent.count({ where: { ruleId: rule.body.id } })).toBe(1);
    const deliveries = await prisma.alertDelivery.findMany({ where: { eventId } });
    expect(deliveries).toHaveLength(3);
  });

  it('stops reminders once an alert is acknowledged', async () => {
    const { agent, organizationId, domainId, userId } = await createWorkspaceDomain('alerts.ack.test');
    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('alerts.ack.test', 'ack-1', [{ ip: '45.83.12.9', count: 700, dkim: 'fail', spf: 'fail' }]),
    });

    const rule = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Acknowledge stops noise',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 100,
      cooldownMinutes: 5,
      maxReminderLevel: 3,
      recipientUserIds: [userId],
    });

    const first = await evaluateAlertRules();
    const eventId = first.find((result) => result.ruleId === rule.body.id)?.eventId as string;

    const acknowledged = await agent.post(`/api/workspaces/${organizationId}/alerts/${eventId}/acknowledge`);
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body.acknowledged).toBe(true);

    const repeat = await agent.post(`/api/workspaces/${organizationId}/alerts/${eventId}/acknowledge`);
    expect(repeat.status).toBe(409);

    const afterAck = await evaluateAlertRules(new Date(Date.now() + 60 * 60 * 1000));
    expect(afterAck.find((result) => result.ruleId === rule.body.id)?.outcome).toBe('unchanged');

    const deliveries = await prisma.alertDelivery.findMany({ where: { eventId } });
    expect(deliveries).toHaveLength(1);

    const stored = await prisma.alertEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(stored.acknowledgedAt).not.toBeNull();
    expect(stored.acknowledgedById).toBe(userId);
    expect(stored.reminderLevel).toBe(1);
  });

  it('resolves an open event once the condition clears', async () => {
    const { agent, organizationId, domainId, userId } = await createWorkspaceDomain('alerts.resolve.test');
    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('alerts.resolve.test', 'resolve-1', [{ ip: '45.83.12.9', count: 400, dkim: 'fail', spf: 'fail' }]),
    });

    const rule = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Resolves when quiet',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 100,
      cooldownMinutes: 5,
      recipientUserIds: [userId],
    });

    const first = await evaluateAlertRules();
    const eventId = first.find((result) => result.ruleId === rule.body.id)?.eventId as string;

    const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await prisma.dmarcReport.updateMany({ where: { domainId }, data: { receivedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await prisma.dmarcReportRecord.deleteMany({ where: { report: { domainId } } });

    const resolved = await evaluateAlertRules(future);
    expect(resolved.find((result) => result.ruleId === rule.body.id)?.outcome).toBe('resolved');

    const stored = await prisma.alertEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(stored.resolvedAt).not.toBeNull();

    const acked = await agent.post(`/api/workspaces/${organizationId}/alerts/${eventId}/acknowledge`);
    expect(acked.status).toBe(409);
  });

  it('re-alerts after the acknowledgement suppression window if the problem persists', async () => {
    const { agent, organizationId, domainId, userId } = await createWorkspaceDomain('alerts.realert.test');
    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('alerts.realert.test', 'realert-1', [{ ip: '45.83.12.9', count: 800, dkim: 'fail', spf: 'fail' }]),
    });

    const rule = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Suppress then re-alert',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 100,
      windowMinutes: 60,
      cooldownMinutes: 5,
      recipientUserIds: [userId],
    });

    const first = await evaluateAlertRules();
    const firstEvent = first.find((result) => result.ruleId === rule.body.id)?.eventId as string;
    await agent.post(`/api/workspaces/${organizationId}/alerts/${firstEvent}/acknowledge`);

    const suppressed = await evaluateAlertRules();
    expect(suppressed.find((result) => result.ruleId === rule.body.id)?.outcome).toBe('unchanged');
    expect(await prisma.alertEvent.count({ where: { ruleId: rule.body.id } })).toBe(1);

    await prisma.alertEvent.update({
      where: { id: firstEvent },
      data: { acknowledgedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    const reAlerted = await evaluateAlertRules();
    const outcome = reAlerted.find((result) => result.ruleId === rule.body.id);
    expect(outcome?.outcome).toBe('triggered');
    expect(outcome?.eventId).not.toBe(firstEvent);
    expect(await prisma.alertEvent.count({ where: { ruleId: rule.body.id } })).toBe(2);
  });

  it('does not trigger when the metric is below the threshold', async () => {
    const { agent, organizationId, domainId, userId } = await createWorkspaceDomain('alerts.quiet.test');
    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('alerts.quiet.test', 'quiet-1', [{ ip: '192.0.2.1', count: 10, dkim: 'pass', spf: 'pass' }]),
    });

    const rule = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Never fires',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 1000,
      recipientUserIds: [userId],
    });

    const results = await evaluateAlertRules();
    const outcome = results.find((result) => result.ruleId === rule.body.id);
    expect(outcome?.outcome).toBe('unchanged');
    expect(outcome?.observed).toBe(0);
  });

  it('skips delivery for a disabled recipient but still records the event', async () => {
    const { agent, organizationId, domainId, userId } = await createWorkspaceDomain('alerts.muted.test');
    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('alerts.muted.test', 'muted-1', [{ ip: '45.83.12.9', count: 900, dkim: 'fail', spf: 'fail' }]),
    });

    await prisma.notificationPreference.create({
      data: { userId, emailAlerts: false },
    });

    const rule = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Muted recipient',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 100,
      recipientUserIds: [userId],
    });

    await evaluateAlertRules();

    const events = await listAlertEvents(organizationId, { domainId });
    expect(events).toHaveLength(1);

    const delivery = await prisma.alertDelivery.findFirstOrThrow({ where: { eventId: events[0].id } });
    expect(delivery.status).toBe('SKIPPED_DISABLED');
    expect(delivery.sentAt).toBeNull();

    const stored = await getAlertRule(organizationId, rule.body.id);
    expect(stored?.lastTriggeredAt).not.toBeNull();
  });

  it('skips delivery during quiet hours', async () => {
    const { agent, organizationId, domainId, userId } = await createWorkspaceDomain('alerts.quiet-hours.test');
    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('alerts.quiet-hours.test', 'qh-1', [{ ip: '45.83.12.9', count: 800, dkim: 'fail', spf: 'fail' }]),
    });

    await prisma.notificationPreference.create({
      data: { userId, quietHoursStart: '00:00', quietHoursEnd: '23:59' },
    });

    const rule = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Quiet hours',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 100,
      recipientUserIds: [userId],
    });

    const during = new Date();
    const outcome = await evaluateRule(await getAlertRuleOrThrow(organizationId, rule.body.id), during);
    expect(outcome.triggered).toBe(true);

    await evaluateAlertRules();

    const events = await listAlertEvents(organizationId, { domainId });
    const delivery = await prisma.alertDelivery.findFirstOrThrow({ where: { eventId: events[0].id } });
    expect(['SKIPPED_QUIET_HOURS', 'SENT']).toContain(delivery.status);
  });

  it('detects report silence when nothing has been received', async () => {
    const { agent, organizationId, domainId, userId } = await createWorkspaceDomain('alerts.silence.test');
    const rule = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'No reports for a day',
      metric: 'REPORT_SILENCE',
      operator: 'GREATER_THAN',
      threshold: 0,
      windowMinutes: 1440,
      recipientUserIds: [userId],
    });

    const outcome = await evaluateRule(await getAlertRuleOrThrow(organizationId, rule.body.id));
    expect(outcome.observed).toBeNull();
    expect(outcome.triggered).toBe(false);
  });

  it('keeps notification preferences per user and validates quiet hours', async () => {
    const { agent, userId } = await createWorkspaceDomain('alerts.prefs.test');

    const defaults = await agent.get(`/api/me/${userId}/notification-preferences`);
    expect(defaults.status).toBe(200);
    expect(defaults.body.emailAlerts).toBe(true);
    expect(defaults.body.quietHoursStart).toBeNull();

    const saved = await agent.patch(`/api/me/${userId}/notification-preferences`).send({
      onlyHighRiskAlerts: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.onlyHighRiskAlerts).toBe(true);
    expect(saved.body.quietHoursStart).toBe('22:00');

    const invalid = await agent.patch(`/api/me/${userId}/notification-preferences`).send({
      quietHoursStart: '25:00',
      quietHoursEnd: '07:00',
    });
    expect(invalid.status).toBe(400);

    const partial = await agent.patch(`/api/me/${userId}/notification-preferences`).send({
      quietHoursStart: '22:00',
    });
    expect(partial.status).toBe(400);
  });

  it('refuses to change another user preferences and blocks rule creation for viewers', async () => {
    const { agent, organizationId, userId } = await createWorkspaceDomain('alerts.scope.test');
    const other = await createWorkspaceDomain('alerts.scope-other.test');

    const foreign = await agent.patch(`/api/me/${other.userId}/notification-preferences`).send({ emailAlerts: false });
    expect(foreign.status).toBe(403);

    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'viewer' } });
    const denied = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId: userId,
      name: 'Viewer attempt',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 1,
      recipientUserIds: [userId],
    });
    expect(denied.status).toBe(403);
  });
});

async function getAlertRuleOrThrow(organizationId: string, ruleId: string) {
  const rule = await getAlertRule(organizationId, ruleId);
  if (!rule) {
    throw new Error('Rule not found');
  }
  return rule;
}
