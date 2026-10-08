import { AlertMetric, AlertOperator } from '@prisma/client';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { evaluateAlertRules } from '../src/services/alert.service.js';
import { runReportDigests } from '../src/services/report-digest.service.js';
import { grantPlan } from './helpers/plan.js';

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
    'TRUNCATE TABLE "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup(
  options: { dmarcRecord?: string | null; verified?: boolean; domainName?: string } = {},
) {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `notify-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await agent.post('/api/auth/sign-up/email').send({ name: 'Notify Owner', email, password });
  expect(signUp.status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const signIn = await agent.post('/api/auth/sign-in/email').send({ email, password });
  expect(signIn.status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Notify Agency',
    slug: `notify-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
  expect(workspace.status).toBe(201);

  const client = await agent.post(`/api/workspaces/${workspace.body.id}/clients`).send({
    name: 'Notify Client',
    slug: `notify-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);

  const domain = await agent.post(`/api/workspaces/${workspace.body.id}/clients/${client.body.id}/domains`).send({
    name: options.domainName ?? 'notify-client.test',
  });
  expect(domain.status).toBe(201);

  await prisma.domain.update({
    where: { id: domain.body.id },
    data: {
      status: options.verified === false ? 'PENDING' : 'VERIFIED',
      verifiedAt: options.verified === false ? null : new Date(),
      score: 77,
      dmarcPolicy: 'none',
      collectForensicReports: true,
      dmarcRecord:
        options.dmarcRecord === undefined
          ? 'v=DMARC1; p=none; rua=mailto:dmarc-reports@reports.dmarcharbor.com'
          : options.dmarcRecord,
    },
  });

  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: workspace.body.id } });

  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId);

  return {
    agent,
    organizationId: organizationId,
    clientId: client.body.id as string,
    domainId: domain.body.id as string,
    userId: member.userId as string,
  };
}

describe('in-app notifications', () => {
  beforeAll(resetDatabase);

  it('creates notifications for rule recipients when an alert fires', async () => {
    const { agent, organizationId, domainId, userId } = await setup();

    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('notify-client.test', 'n-1', [{ ip: '45.83.12.9', count: 800, dkim: 'fail', spf: 'fail' }]),
    });

    await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Notify rule',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 100,
      recipientUserIds: [userId],
    });

    await evaluateAlertRules();

    const listed = await agent.get('/api/me/notifications');
    expect(listed.status).toBe(200);
    expect(listed.body.notifications).toHaveLength(1);
    expect(listed.body.notifications[0].kind).toBe('ALERT');
    expect(listed.body.notifications[0].severity).toBe('WARNING');
    expect(listed.body.notifications[0].title).toContain('Notify rule');
    expect(listed.body.notifications[0].readAt).toBeNull();
    expect(listed.body.unread).toBe(1);
  });

  /**
   * Quiet hours are a pair or they are nothing.
   *
   * "Start at 22:00" with no end is not a window, it is an alert suppression
   * that never lifts, so a half-configured pair is refused. Turning both off
   * again has to work, though, and it did not: the guard tested the truthiness
   * of what arrived, so an explicit `null` read as absent and clearing quiet
   * hours was rejected with the same message as a half pair. Once set, they
   * could not be unset.
   */
  it('refuses half a quiet-hours window and allows both halves or neither', async () => {
    const { agent, userId } = await setup({ domainName: 'quiet-hours.test' });

    const half = await agent
      .patch(`/api/me/${userId}/notification-preferences`)
      .send({ quietHoursStart: '22:00' });
    expect(half.status).toBe(400);

    const both = await agent
      .patch(`/api/me/${userId}/notification-preferences`)
      .send({ quietHoursStart: '22:00', quietHoursEnd: '07:00' });
    expect(both.status).toBe(200);
    expect(both.body.quietHoursStart).toBe('22:00');
    expect(both.body.quietHoursEnd).toBe('07:00');

    // The case that was broken: switching them back off.
    const cleared = await agent
      .patch(`/api/me/${userId}/notification-preferences`)
      .send({ quietHoursStart: null, quietHoursEnd: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.quietHoursStart).toBeNull();
    expect(cleared.body.quietHoursEnd).toBeNull();

    const reread = await agent.get(`/api/me/${userId}/notification-preferences`);
    expect(reread.body.quietHoursStart).toBeNull();

    // With both cleared, supplying one end is a half pair again and is refused.
    // This is the same refusal as the very first call, which is the point: the
    // rule is about the resulting state, not about having cleared once before.
    const halfAgain = await agent
      .patch(`/api/me/${userId}/notification-preferences`)
      .send({ quietHoursStart: '22:00' });
    expect(halfAgain.status).toBe(400);

    // Nor may one end be cleared while the other is still set.
    await agent
      .patch(`/api/me/${userId}/notification-preferences`)
      .send({ quietHoursStart: '22:00', quietHoursEnd: '07:00' });
    const halfCleared = await agent
      .patch(`/api/me/${userId}/notification-preferences`)
      .send({ quietHoursEnd: null });
    expect(halfCleared.status).toBe(400);
    expect(
      (await agent.get(`/api/me/${userId}/notification-preferences`)).body.quietHoursEnd,
    ).toBe('07:00');
  });

  it('creates notifications even when email alerts are switched off', async () => {
    const { agent, organizationId, domainId, userId } = await setup({ domainName: 'muted-notify.test' });

    await agent.patch(`/api/me/${userId}/notification-preferences`).send({ emailAlerts: false });

    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('muted-notify.test', 'n-2', [{ ip: '45.83.12.9', count: 800, dkim: 'fail', spf: 'fail' }]),
    });

    await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Muted email rule',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 100,
      recipientUserIds: [userId],
    });

    await evaluateAlertRules();

    const deliveries = await prisma.alertDelivery.findMany({
      where: { kind: 'ALERT', event: { domainId } },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('SKIPPED_DISABLED');

    const listed = await agent.get('/api/me/notifications');
    expect(listed.body.notifications).toHaveLength(1);
    expect(listed.body.unread).toBe(1);
  });

  it('escalates notification severity on repeat reminders without duplicating rows', async () => {
    const { agent, organizationId, domainId, userId } = await setup({ domainName: 'escalate-notify.test' });

    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('escalate-notify.test', 'n-3', [{ ip: '45.83.12.9', count: 800, dkim: 'fail', spf: 'fail' }]),
    });

    await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Escalating rule',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 100,
      cooldownMinutes: 5,
      maxReminderLevel: 3,
      recipientUserIds: [userId],
    });

    await evaluateAlertRules();
    await evaluateAlertRules(new Date(Date.now() + 6 * 60 * 1000));

    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    expect(notifications).toHaveLength(2);
    expect(notifications[0].severity).toBe('WARNING');
    expect(notifications[1].severity).toBe('CRITICAL');
    expect(notifications[1].title).toContain('Unacknowledged');

    const uniqueEvents = new Set(notifications.map((notification) => notification.alertEventId));
    expect(uniqueEvents.size).toBe(1);
  });

  it('marks one notification read and rejects double reads', async () => {
    const { agent, organizationId, domainId, userId } = await setup({ domainName: 'read-notify.test' });

    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('read-notify.test', 'n-4', [{ ip: '45.83.12.9', count: 800, dkim: 'fail', spf: 'fail' }]),
    });
    await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Read rule',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 100,
      recipientUserIds: [userId],
    });
    await evaluateAlertRules();

    const listed = await agent.get('/api/me/notifications');
    const notificationId = listed.body.notifications[0].id;

    const read = await agent.post(`/api/me/notifications/${notificationId}/read`);
    expect(read.status).toBe(200);

    const again = await agent.post(`/api/me/notifications/${notificationId}/read`);
    expect(again.status).toBe(409);

    const missing = await agent.post('/api/me/notifications/does-not-exist/read');
    expect(missing.status).toBe(404);

    const unreadOnly = await agent.get('/api/me/notifications?unreadOnly=true');
    expect(unreadOnly.body.notifications).toHaveLength(0);
    expect(unreadOnly.body.unread).toBe(0);
  });

  it('marks everything read and keeps users isolated', async () => {
    const first = await setup({ domainName: 'bulk-notify.test' });
    await first.agent.post(`/api/workspaces/${first.organizationId}/domains/${first.domainId}/reports`).send({
      xml: aggregateReport('bulk-notify.test', 'n-5', [{ ip: '45.83.12.9', count: 800, dkim: 'fail', spf: 'fail' }]),
    });
    await first.agent.post(`/api/workspaces/${first.organizationId}/alert-rules`).send({
      domainId: first.domainId,
      name: 'Bulk rule',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 100,
      recipientUserIds: [first.userId],
    });
    await evaluateAlertRules();

    const other = await setup({ domainName: 'other-notify.test' });

    const otherList = await other.agent.get('/api/me/notifications');
    expect(otherList.body.notifications).toHaveLength(0);

    const firstNotification = await prisma.notification.findFirstOrThrow({ where: { userId: first.userId } });
    const crossRead = await other.agent.post(`/api/me/notifications/${firstNotification.id}/read`);
    expect(crossRead.status).toBe(404);

    const all = await first.agent.post('/api/me/notifications/read-all');
    expect(all.status).toBe(200);
    expect(all.body.marked).toBe(1);

    const after = await first.agent.get('/api/me/notifications/unread-count');
    expect(after.body.unread).toBe(0);
  });

  it('requires authentication', async () => {
    const response = await request(app).get('/api/me/notifications');
    expect(response.status).toBe(401);
  });
});

describe('portfolio onboarding', () => {
  beforeAll(resetDatabase);

  it('aggregates every domain in the workspace by client and state', async () => {
    const { agent, organizationId, domainId, userId } = await setup({ domainName: 'portfolio-a.test' });

    const second = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
      name: 'Second Client',
      slug: `second-${Date.now()}`,
    });
    expect(second.status).toBe(201);

    const pending = await agent.post(`/api/workspaces/${organizationId}/clients/${second.body.id}/domains`).send({
      name: 'portfolio-pending.test',
    });
    expect(pending.status).toBe(201);

    const noRua = await agent.post(`/api/workspaces/${organizationId}/clients/${second.body.id}/domains`).send({
      name: 'portfolio-norua.test',
    });
    expect(noRua.status).toBe(201);

    await prisma.domain.update({ where: { id: pending.body.id }, data: { status: 'PENDING', verifiedAt: null } });
    await prisma.domain.update({
      where: { id: noRua.body.id },
      data: { status: 'VERIFIED', verifiedAt: new Date(), dmarcRecord: 'v=DMARC1; p=none' },
    });

    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('portfolio-a.test', 'p-1', [{ ip: '192.0.2.1', count: 40_000, dkim: 'pass', spf: 'pass' }]),
    });

    const portfolio = await agent.get(`/api/workspaces/${organizationId}/onboarding`);

    expect(portfolio.status).toBe(200);
    expect(portfolio.body.totals.domains).toBe(3);
    expect(portfolio.body.totals.clients).toBe(2);
    expect(portfolio.body.totals.awaitingVerification).toBe(1);
    expect(portfolio.body.totals.awaitingDmarcRecord).toBe(1);
    expect(portfolio.body.totals.monitoring).toBe(1);

    const rows = portfolio.body.clients.flatMap((entry: { domains: { domainName: string; state: string }[] }) => entry.domains);
    const monitored = rows.find((row: { domainName: string }) => row.domainName === 'portfolio-a.test');
    expect(monitored.state).toBe('MONITORING');
    expect(monitored.passRatePercent).toBe(100);
    expect(monitored.messagesObserved).toBe(40_000);

    const pendingRow = rows.find((row: { domainName: string }) => row.domainName === 'portfolio-pending.test');
    expect(pendingRow.state).toBe('AWAITING_VERIFICATION');

    const noRuaRow = rows.find((row: { domainName: string }) => row.domainName === 'portfolio-norua.test');
    expect(noRuaRow.state).toBe('AWAITING_DMARC_RECORD');
    expect(noRuaRow.aggregateConfigured).toBe(false);

    const rule = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'Portfolio alert',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 1,
      recipientUserIds: [userId],
    });
    expect(rule.status).toBe(201);
  });

  it('scopes the portfolio to the requesting workspace', async () => {
    const first = await setup({ domainName: 'scope-portfolio.test' });
    const other = await setup({ domainName: 'scope-other.test' });

    const portfolio = await other.agent.get(`/api/workspaces/${other.organizationId}/onboarding`);
    expect(portfolio.body.totals.domains).toBe(1);
    expect(portfolio.body.clients[0].domains[0].domainName).toBe('scope-other.test');
    expect(JSON.stringify(portfolio.body)).not.toContain('scope-portfolio.test');
    expect(first.domainId).not.toBe(other.domainId);
  });
});

describe('scheduled client report digests', () => {
  beforeAll(resetDatabase);

  it('creates, updates, sends and deletes a digest', async () => {
    const { agent, organizationId, domainId } = await setup({ domainName: 'digest-client.test' });

    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('digest-client.test', 'd-1', [
        { ip: '45.83.12.9', count: 900, dkim: 'fail', spf: 'fail' },
        { ip: '192.0.2.1', count: 9000, dkim: 'pass', spf: 'pass' },
      ]),
    });

    const created = await agent.post(`/api/workspaces/${organizationId}/report-digests`).send({
      domainId,
      frequency: 'WEEKLY',
      sendHourUtc: 9,
      weekday: 1,
      recipientEmails: ['Client.Owner@Example.com', 'ciso@example.com', 'client.owner@example.com'],
      includeForensics: true,
    });

    expect(created.status).toBe(201);
    expect(created.body.recipientEmails).toEqual(['client.owner@example.com', 'ciso@example.com']);
    expect(created.body.dayOfMonth).toBe(1);

    const listed = await agent.get(`/api/workspaces/${organizationId}/report-digests`);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].domain.name).toBe('digest-client.test');
    expect(listed.body.items[0].domain.client.name).toBe('Notify Client');

    const sent = await agent.post(`/api/workspaces/${organizationId}/report-digests/${created.body.id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.sent).toBe(true);
    expect(sent.body.recipients).toBe(2);
    expect(sent.body.subject).toContain('digest-client.test');
    expect(sent.body.preview).toContain('SPF pass rate');
    expect(sent.body.preview).toContain('45.83.12.9');
    expect(sent.body.preview).toContain('Notify Client');

    const stored = await prisma.reportDigest.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.lastSentAt).not.toBeNull();

    const updated = await agent
      .patch(`/api/workspaces/${organizationId}/report-digests/${created.body.id}`)
      .send({ enabled: false, frequency: 'MONTHLY', dayOfMonth: 15 });
    expect(updated.status).toBe(200);
    expect(updated.body.enabled).toBe(false);
    expect(updated.body.frequency).toBe('MONTHLY');
    expect(updated.body.dayOfMonth).toBe(15);

    const deleted = await agent.delete(`/api/workspaces/${organizationId}/report-digests/${created.body.id}`);
    expect(deleted.status).toBe(204);
  });

  it('rejects invalid digests and cross-workspace access', async () => {
    const first = await setup({ domainName: 'digest-scope.test' });
    const other = await setup({ domainName: 'digest-other.test' });

    const noRecipients = await first.agent.post(`/api/workspaces/${first.organizationId}/report-digests`).send({
      domainId: first.domainId,
      recipientEmails: [],
    });
    expect(noRecipients.status).toBe(400);

    const badEmail = await first.agent.post(`/api/workspaces/${first.organizationId}/report-digests`).send({
      domainId: first.domainId,
      recipientEmails: ['not-an-email'],
    });
    expect(badEmail.status).toBe(400);

    const badHour = await first.agent.post(`/api/workspaces/${first.organizationId}/report-digests`).send({
      domainId: first.domainId,
      sendHourUtc: 44,
      recipientEmails: ['client@example.com'],
    });
    expect(badHour.status).toBe(400);

    const crossScope = await other.agent.post(`/api/workspaces/${other.organizationId}/report-digests`).send({
      domainId: first.domainId,
      recipientEmails: ['client@example.com'],
    });
    expect(crossScope.status).toBe(404);
  });

  it('only sends on the configured day and never twice in a day', async () => {
    const { agent, organizationId, domainId } = await setup({ domainName: 'digest-schedule.test' });

    const wednesday = new Date();
    wednesday.setUTCHours(10, 0, 0, 0);

    await agent.post(`/api/workspaces/${organizationId}/report-digests`).send({
      domainId,
      frequency: 'WEEKLY',
      sendHourUtc: 9,
      weekday: wednesday.getUTCDay(),
      recipientEmails: ['client@example.com'],
    });

    const tooEarly = new Date(wednesday);
    tooEarly.setUTCHours(8, 0, 0, 0);
    const early = await runReportDigests(tooEarly);
    expect(early.filter((result) => result.sent)).toHaveLength(0);

    const onTime = await runReportDigests(wednesday);
    expect(onTime.filter((result) => result.sent)).toHaveLength(1);

    const again = await runReportDigests(new Date(wednesday.getTime() + 60 * 60 * 1000));
    expect(again.filter((result) => result.sent)).toHaveLength(0);
  });

  it('never includes personal data in digest content', async () => {
    const { agent, organizationId, domainId } = await setup({
      domainName: 'digest-privacy.test',
      dmarcRecord:
        'v=DMARC1; p=none; rua=mailto:dmarc-reports@reports.dmarcharbor.com; ruf=mailto:dmarc-forensics@reports.dmarcharbor.com',
    });

    await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domainId}/forensics/identities`)
      .send({ retainForensicPii: true, confirmLegalBasis: true });

    const boundary = 'ruf-boundary';
    const rawEmail = [
      'From: noreply-dmarc-support@google.com',
      'To: dmarc-reports@reports.dmarcharbor.com',
      'Content-Type: multipart/report; report-type=feedback-report; boundary="' + boundary + '"',
      '',
      '--' + boundary,
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.google.com',
      'Source-IP: 45.83.12.9',
      '',
      'Final-Recipient: rfc822; alice@example.com',
      'Action: fail',
      'Status: 5.7.1',
      '--' + boundary,
      'Content-Type: application/feedback-report',
      '',
      'Feedback-Type: feedback-report',
      'Original-Mail-From: <attacker@spammer.test>',
      'Original-Rcpt-To: <alice@example.com>',
      'Source-IP: 45.83.12.9',
      'Reported-Domain: digest-privacy.test',
      'Authentication-Results: mx.google.com; spf=fail smtp.mailfrom=spammer.test; dkim=fail header.d=spammer.test',
      '--' + boundary,
      'Content-Type: text/rfc822-headers',
      '',
      'From: attacker@spammer.test',
      'To: alice@example.com',
      'Subject: Wire transfer details',
      'Message-ID: <digest-1@spammer.test>',
      '--' + boundary + '--',
      '',
    ].join('\r\n');

    const { createHmac } = await import('node:crypto');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = `sha256=${createHmac('sha256', 'test-report-ingest-secret-please-change')
      .update(`${timestamp}.${rawEmail}`)
      .digest('hex')}`;

    const inbound = await request(app)
      .post('/api/internal/reports/inbound')
      .set('Content-Type', 'message/rfc822')
      .set('X-DMARC-Timestamp', timestamp)
      .set('X-DMARC-Signature', signature)
      .send(rawEmail);
    expect(inbound.body.results[0].status).toBe('created');

    const digest = await agent.post(`/api/workspaces/${organizationId}/report-digests`).send({
      domainId,
      recipientEmails: ['client@example.com'],
      includeForensics: true,
    });

    const sent = await agent.post(`/api/workspaces/${organizationId}/report-digests/${digest.body.id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.preview).toContain('Forensic failures');

    const serialized = JSON.stringify(sent.body);
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('Wire transfer details');
    expect(serialized).not.toContain('attacker@spammer.test');
    expect(serialized).not.toContain('Pseudonym');
  });

  it('stops viewers managing digests', async () => {
    const { agent, organizationId, domainId, userId } = await setup({ domainName: 'digest-perm.test' });
    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'viewer' } });

    const response = await agent.post(`/api/workspaces/${organizationId}/report-digests`).send({
      domainId,
      recipientEmails: ['client@example.com'],
    });

    expect(response.status).toBe(403);
    expect(userId).toBeTruthy();
  });

  it('creates a direct alert event for the notification link test path', async () => {
    const { organizationId, domainId, userId } = await setup({ domainName: 'manual-notify.test' });

    const rule = await prisma.alertRule.create({
      data: {
        organizationId,
        domainId,
        name: 'Manual rule',
        metric: AlertMetric.FAILURE_COUNT,
        operator: AlertOperator.GREATER_THAN,
        threshold: 5,
        windowMinutes: 1440,
        cooldownMinutes: 1440,
        createdById: userId,
        recipients: { create: [{ userId }] },
      },
    });

    const event = await prisma.alertEvent.create({
      data: {
        ruleId: rule.id,
        organizationId,
        domainId,
        metric: AlertMetric.FAILURE_COUNT,
        operator: AlertOperator.GREATER_THAN,
        observedValue: 50,
        threshold: 5,
        windowMinutes: 1440,
        summary: 'Observed 50 messages',
      },
    });

    expect(event.id).toBeTruthy();
  });
});
