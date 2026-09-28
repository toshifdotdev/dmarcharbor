import { createHmac } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { buildSenderBreakdown, classifySender, senderBreakdownThresholds } from '../src/services/sender-breakdown.service.js';
import { resolveSenderDomain, parseDmarcReport } from '../src/services/report-parser.service.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

interface SenderFixture {
  ip: string;
  count: number;
  dkim: string;
  spf: string;
  spfDomain: string;
  headerFrom: string;
}

function aggregateReport(
  domain: string,
  reportId: string,
  rows: SenderFixture[],
  range: { begin: number; end: number } = { begin: 1712188800, end: 1712275199 },
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>Google LLC</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>${reportId}</report_id>
    <date_range><begin>${range.begin}</begin><end>${range.end}</end></date_range>
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
      <header_from>${row.headerFrom}</header_from>
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

const daySeconds = 24 * 60 * 60;

async function postDailyReports(
  organizationId: string,
  domainId: string,
  domainName: string,
  rows: SenderFixture[],
  days: number,
): Promise<void> {
  const { ingestDmarcReport } = await import('../src/services/report.service.js');
  const offsets = [0, Math.max(1, days - 1)];

  for (const [index, offset] of offsets.entries()) {
    const begin = 1712188800 + offset * daySeconds;
    const outcome = await ingestDmarcReport({
      organizationId,
      domainId,
      xml: aggregateReport(domainName, `daily-${index}-${offset}`, rows, { begin, end: begin + daySeconds - 1 }),
    });
    expect(outcome.status).toBe('created');
  }
}

function forensicEmail(domain: string): string {
  const boundary = 'ruf-boundary';
  return [
    'From: noreply-dmarc-support@google.com',
    'To: dmarc-reports@reports.dmarcharbor.com',
    `Content-Type: multipart/report; report-type=feedback-report; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain',
    '',
    'DMARC failure report.',
    `--${boundary}`,
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.google.com',
    'Source-IP: 45.83.12.9',
    '',
    'Final-Recipient: rfc822; alice@example.com',
    'Action: fail',
    'Status: 5.7.1',
    `--${boundary}`,
    'Content-Type: application/feedback-report',
    '',
    'Feedback-Type: feedback-report',
    'Original-Rcpt-To: <alice@example.com>',
    'Source-IP: 45.83.12.9',
    `Reported-Domain: ${domain}`,
    'Authentication-Results: mx.google.com; spf=fail smtp.mailfrom=spammer.test; dkim=fail header.d=spammer.test',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup(policy: string | null = 'none') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `senders-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await agent.post('/api/auth/sign-up/email').send({ name: 'Sender Owner', email, password });
  expect(signUp.status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const signIn = await agent.post('/api/auth/sign-in/email').send({ email, password });
  expect(signIn.status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Sender Agency',
    slug: `sender-${Date.now()}-${fixtureId}`,
  });
  expect(workspace.status).toBe(201);

  const client = await agent.post(`/api/workspaces/${workspace.body.id}/clients`).send({
    name: 'Sender Client',
    slug: `sender-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);

  const domain = await agent.post(`/api/workspaces/${workspace.body.id}/clients/${client.body.id}/domains`).send({
    name: `senders-${fixtureId}.test`,
  });
  expect(domain.status).toBe(201);

  await prisma.domain.update({
    where: { id: domain.body.id },
    data: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      score: 70,
      collectForensicReports: true,
      dmarcPolicy: policy,
      dmarcRecord: `v=DMARC1; p=${policy ?? 'none'}; rua=mailto:dmarc-reports@reports.dmarcharbor.com; ruf=mailto:dmarc-forensics@reports.dmarcharbor.com`,
    },
  });

  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: workspace.body.id } });

  return {
    agent,
    organizationId: workspace.body.id as string,
    domainId: domain.body.id as string,
    domainName: `senders-${fixtureId}.test`,
    userId: member.userId as string,
  };
}

describe('sender identity resolution', () => {
  it('prefers the authentication domain aligned with the policy domain', () => {
    const resolved = resolveSenderDomain('example.com', {
      headerFrom: 'example.com',
      envelopeFrom: 'newsletter.spam.test',
      authResults: [
        { type: 'SPF', domain: 'newsletter.spam.test', scope: 'mfrom', result: 'fail' },
        { type: 'DKIM', domain: 'example.com', selector: 's1', result: 'pass' },
      ],
    });

    expect(resolved).toBe('example.com');
  });

  it('prefers the authentication domain over the claimed header_from when nothing aligns', () => {
    expect(
      resolveSenderDomain('example.com', {
        headerFrom: 'Example.COM',
        authResults: [{ type: 'SPF', domain: 'spammer.test', scope: 'mfrom', result: 'fail' }],
      }),
    ).toBe('spammer.test');

    expect(
      resolveSenderDomain('example.com', {
        authResults: [{ type: 'SPF', domain: 'portal.other.test', scope: 'mfrom', result: 'fail' }],
      }),
    ).toBe('portal.other.test');

    expect(
      resolveSenderDomain('example.com', {
        headerFrom: 'Example.COM',
        envelopeFrom: 'mail.example.com',
        authResults: [],
      }),
    ).toBe('example.com');
  });

  it('writes a sender key onto every parsed record', () => {
    const parsed = parseDmarcReport(
      aggregateReport('example.com', 'sender-key-1', [
        { ip: '192.0.2.10', count: 100, dkim: 'pass', spf: 'pass', spfDomain: 'example.com', headerFrom: 'example.com' },
      ]),
    );

    expect(parsed.records[0].senderDomain).toBe('example.com');
    expect(parsed.records[0].senderKey).toBe('example.com');
  });
});

describe('sender grading', () => {
  it('needs enough messages before it will judge a sender', () => {
    expect(classifySender(10, 10)).toBe('insufficient-data');
    expect(classifySender(senderBreakdownThresholds.minimumMessagesForSignal, 0)).toBe('clean');
    expect(classifySender(1_000, 10)).toBe('degraded');
    expect(classifySender(1_000, 400)).toBe('failing');
  });
});

describe('per sending service breakdown', () => {
  beforeAll(resetDatabase);

  it('exposes a rare broken sender that the blended rate hides', async () => {
    const { agent, organizationId, domainId, domainName } = await setup();

    const ingested = await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport(domainName, `blended-${Date.now()}`, [
        { ip: '192.0.2.1', count: 40_000, dkim: 'pass', spf: 'pass', spfDomain: domainName, headerFrom: domainName },
        { ip: '198.51.100.77', count: 150, dkim: 'fail', spf: 'fail', spfDomain: 'portal.other.test', headerFrom: domainName },
      ]),
    });
    expect(ingested.status).toBe(201);

    const records = await prisma.dmarcReportRecord.findMany({ where: { report: { domainId } } });
    expect(records).toHaveLength(2);
    const portal = records.find((record) => record.sourceIp === '198.51.100.77');
    expect(portal?.senderDomain).toBe('portal.other.test');
    expect(portal?.senderKey).toBe('portal.other.test');

    const insights = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/insights`);
    expect(insights.status).toBe(200);
    expect(insights.body.aggregate.failedMessages).toBe(150);
    expect(insights.body.aggregate.spfPassRate).toBeGreaterThan(99);

    const senders = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/senders`);
    expect(senders.status).toBe(200);
    expect(senders.body.senders).toHaveLength(2);

    const healthy = senders.body.senders.find((row: { sourceIps: string[] }) => row.sourceIps.includes('192.0.2.1'));
    expect(healthy.status).toBe('clean');
    expect(healthy.failureSharePercent).toBe(0);
    expect(healthy.totalMessages).toBe(40_000);

    const broken = senders.body.senders.find((row: { sourceIps: string[] }) => row.sourceIps.includes('198.51.100.77'));
    expect(broken.status).toBe('failing');
    expect(broken.failureSharePercent).toBe(100);
    expect(broken.senderDomain).toBe('portal.other.test');
    expect(broken.hasEnoughSignal).toBe(true);

    expect(senders.body.thresholds.minimumMessagesForSignal).toBe(50);
    expect(senders.body.thresholds.maximumFailureSharePercent).toBe(5);
  });

  it('groups the same service across several source IPs', async () => {
    const { organizationId, domainId, domainName } = await setup();

    await postDailyReports(
      organizationId,
      domainId,
      domainName,
      [{ ip: '192.0.2.1', count: 300, dkim: 'pass', spf: 'pass', spfDomain: domainName, headerFrom: domainName }, { ip: '192.0.2.2', count: 200, dkim: 'pass', spf: 'pass', spfDomain: domainName, headerFrom: domainName },],
      8,
    );

    const rows = await buildSenderBreakdown(organizationId, domainId);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceIps).toEqual(['192.0.2.1', '192.0.2.2']);
    expect(rows[0].totalMessages).toBe(1_000);
  });

  it('marks a tiny noisy sender as insufficient data rather than failing', async () => {
    const { organizationId, domainId, domainName } = await setup();

    await postDailyReports(
      organizationId,
      domainId,
      domainName,
      [{ ip: '192.0.2.1', count: 20_000, dkim: 'pass', spf: 'pass', spfDomain: domainName, headerFrom: domainName }, { ip: '203.0.113.9', count: 3, dkim: 'fail', spf: 'fail', spfDomain: 'spammer.test', headerFrom: domainName },],
      8,
    );

    const rows = await buildSenderBreakdown(organizationId, domainId);
    const noisy = rows.find((row) => row.sourceIps.includes('203.0.113.9'));
    expect(noisy?.status).toBe('insufficient-data');
    expect(noisy?.hasEnoughSignal).toBe(false);
  });

  it('scopes the breakdown to its own workspace', async () => {
    const first = await setup();
    const other = await setup();

    await first.agent.post(`/api/workspaces/${first.organizationId}/domains/${first.domainId}/reports`).send({
      xml: aggregateReport(first.domainName, `scope-${Date.now()}`, [
        { ip: '192.0.2.1', count: 100, dkim: 'pass', spf: 'pass', spfDomain: first.domainName, headerFrom: first.domainName },
      ]),
    });

    const own = await first.agent.get(`/api/workspaces/${first.organizationId}/domains/${first.domainId}/senders`);
    expect(own.body.senders).toHaveLength(1);

    const foreign = await other.agent.get(`/api/workspaces/${other.organizationId}/domains/${first.domainId}/senders`);
    expect(foreign.status).toBe(404);
  });
});

describe('readiness gates for the blind spots', () => {
  beforeAll(resetDatabase);

  it('blocks enforcement when a single sending service is broken', async () => {
    const { agent, organizationId, domainId, domainName } = await setup();

    await postDailyReports(
      organizationId,
      domainId,
      domainName,
      [{ ip: '192.0.2.1', count: 50_000, dkim: 'pass', spf: 'pass', spfDomain: domainName, headerFrom: domainName }, { ip: '198.51.100.77', count: 400, dkim: 'fail', spf: 'fail', spfDomain: 'portal.other.test', headerFrom: domainName },],
      8,
    );

    const readiness = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/policy-readiness`);

    expect(readiness.status).toBe(200);
    expect(readiness.body.failingSenders).toBe(1);
    expect(readiness.body.observedSenders).toBe(2);
    expect(readiness.body.ready).toBe(false);
    expect(readiness.body.level).toBe('none');
    expect(readiness.body.passRatePercent).toBeGreaterThan(99);
    expect(readiness.body.blockers.join(' ')).toContain('portal.other.test');
  });

  it('never jumps straight from p=none to reject', async () => {
    const { agent, organizationId, domainId, domainName } = await setup('none');

    await postDailyReports(
      organizationId,
      domainId,
      domainName,
      [{ ip: '192.0.2.1', count: 60_000, dkim: 'pass', spf: 'pass', spfDomain: domainName, headerFrom: domainName },],
      8,
    );

    const readiness = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/policy-readiness`);

    expect(readiness.body.currentPolicy).toBe('none');
    expect(readiness.body.level).toBe('quarantine');
    expect(readiness.body.ready).toBe(true);
    expect(readiness.body.blockers).toEqual([]);
  });

  it('allows reject only after the domain is already on quarantine', async () => {
    const { agent, organizationId, domainId, domainName } = await setup('quarantine');

    await postDailyReports(
      organizationId,
      domainId,
      domainName,
      [{ ip: '192.0.2.1', count: 60_000, dkim: 'pass', spf: 'pass', spfDomain: domainName, headerFrom: domainName },],
      8,
    );

    const readiness = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/policy-readiness`);

    expect(readiness.body.currentPolicy).toBe('quarantine');
    expect(readiness.body.level).toBe('reject');
    expect(readiness.body.ready).toBe(true);
  });

  it('stops recommending anything once the domain is already enforcing reject', async () => {
    const { agent, organizationId, domainId, domainName } = await setup('reject');

    await postDailyReports(
      organizationId,
      domainId,
      domainName,
      [{ ip: '192.0.2.1', count: 60_000, dkim: 'pass', spf: 'pass', spfDomain: domainName, headerFrom: domainName },],
      8,
    );

    const readiness = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/policy-readiness`);

    expect(readiness.body.currentPolicy).toBe('reject');
    expect(readiness.body.ready).toBe(false);
    expect(readiness.body.level).toBe('none');
    expect(readiness.body.blockers.join(' ')).toContain('already publishes p=reject');
  });

  it('surfaces the breakdown on the onboarding endpoint too', async () => {
    const { agent, organizationId, domainId, domainName } = await setup();

    await postDailyReports(
      organizationId,
      domainId,
      domainName,
      [{ ip: '192.0.2.1', count: 3_000, dkim: 'pass', spf: 'pass', spfDomain: domainName, headerFrom: domainName }, { ip: '198.51.100.77', count: 60, dkim: 'fail', spf: 'fail', spfDomain: 'portal.other.test', headerFrom: domainName }],
      8,
    );

    const onboarding = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/onboarding`);

    expect(onboarding.status).toBe(200);
    expect(onboarding.body.reporting.publishedPolicy).toBe('none');
    expect(onboarding.body.readiness.failingSenders).toBe(1);
    expect(onboarding.body.recommendedPolicy).toBe('none');

    const tightenStep = onboarding.body.steps.find((step: { id: string }) => step.id === 'policy_tightened');
    expect(tightenStep.status).toBe('pending');
    expect(tightenStep.detail).toContain('portal.other.test');
  });

  it('does not let a forensic failure alone block tightening, since it is counted separately', async () => {
    const { agent, organizationId, domainId, domainName, userId } = await setup();

    await postDailyReports(
      organizationId,
      domainId,
      domainName,
      [{ ip: '192.0.2.1', count: 60_000, dkim: 'pass', spf: 'pass', spfDomain: domainName, headerFrom: domainName },],
      8,
    );

    const rawEmail = forensicEmail(domainName);
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

    const insights = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/insights`);
    expect(insights.body.forensic.count).toBe(1);
    expect(insights.body.aggregate.failedMessages).toBe(0);

    const readiness = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/policy-readiness`);
    expect(readiness.body.failingSenders).toBe(0);
    expect(readiness.body.level).toBe('quarantine');
    expect(userId).toBeTruthy();
  });
});
