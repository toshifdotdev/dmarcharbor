import { AlertMetric, AlertOperator } from '@prisma/client';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { grantPlan } from './helpers/plan.js';
import { app } from '../src/index.js';
import { buildDmarcRecord, readinessThresholds } from '../src/services/onboarding.service.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const boundary = 'ruf-boundary';

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

function forensicEmail(domain: string, messageId: string, recipient = 'alice@example.com'): string {
  return [
    'From: noreply-dmarc-support@google.com',
    'To: dmarc-reports@reports.dmarcharbor.com',
    `Subject: DMARC failure report for ${domain}`,
    `Content-Type: multipart/report; report-type=feedback-report; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'This is a DMARC failure report.',
    `--${boundary}`,
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.google.com',
    'Source-IP: 45.83.12.9',
    'Arrival-Date: Sat, 06 Apr 2024 12:00:01 +0000',
    '',
    `Final-Recipient: rfc822; ${recipient}`,
    `Original-Recipient: rfc822; ${recipient}`,
    'Action: fail',
    'Status: 5.7.1',
    'Remote-MTA: dns; mx1.spammer.test',
    `--${boundary}`,
    'Content-Type: application/feedback-report',
    '',
    'Feedback-Type: feedback-report',
    'Original-Mail-From: <attacker@spammer.test>',
    `Original-Rcpt-To: <${recipient}>`,
    'Source-IP: 45.83.12.9',
    `Reported-Domain: ${domain}`,
    'Authentication-Results: mx.google.com; spf=fail smtp.mailfrom=spammer.test; dkim=fail header.d=spammer.test',
    `--${boundary}`,
    'Content-Type: text/rfc822-headers',
    '',
    'From: attacker@spammer.test',
    `To: ${recipient}`,
    'Subject: Wire transfer details',
    `Message-ID: <${messageId}>`,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function createWorkspace(
  options: { verify?: boolean; dmarcRecord?: string | null; domainName?: string } = {},
) {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `onboarding-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await agent.post('/api/auth/sign-up/email').send({ name: 'Onboarding Owner', email, password });
  expect(signUp.status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const signIn = await agent.post('/api/auth/sign-in/email').send({ email, password });
  expect(signIn.status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Onboarding Agency',
    slug: `onboarding-${Date.now()}-${fixtureId}`,
  });
  expect(workspace.status).toBe(201);
  await grantPlan(workspace.body.id);

  const client = await agent.post(`/api/workspaces/${workspace.body.id}/clients`).send({
    name: 'Acme Corp',
    slug: `acme-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);

  const domain = await agent.post(`/api/workspaces/${workspace.body.id}/clients/${client.body.id}/domains`).send({
    name: options.domainName ?? 'onboard-client.test',
  });
  expect(domain.status).toBe(201);

  await prisma.domain.update({
    where: { id: domain.body.id },
    data: {
      status: options.verify === false ? 'PENDING' : 'VERIFIED',
      verifiedAt: options.verify === false ? null : new Date(),
      score: 82,
      dmarcPolicy: 'none',
      dmarcRecord: options.dmarcRecord === undefined
        ? 'v=DMARC1; p=none; rua=mailto:dmarc-reports@reports.dmarcharbor.com'
        : options.dmarcRecord,
      collectForensicReports: true,
    },
  });

  return {
    agent,
    organizationId: workspace.body.id as string,
    clientId: client.body.id as string,
    domainId: domain.body.id as string,
  };
}

describe('DMARC record generation', () => {
  beforeAll(resetDatabase);

  it('builds a monitoring-only record for p=none without pct', () => {
    const record = buildDmarcRecord('example.com', 'none', false);

    expect(record.host).toBe('_dmarc.example.com');
    expect(record.type).toBe('TXT');
    expect(record.value).toBe('v=DMARC1; p=none; rua=mailto:dmarc-reports@reports.dmarcharbor.com');
    expect(record.forensicAddress).toBeNull();
    expect(record.notes.join(' ')).toContain('p=none');
  });

  it('adds ruf= for enforcing policies and leaves out pct at the 100 default', () => {
    const quarantine = buildDmarcRecord('example.com', 'quarantine', true);
    expect(quarantine.value).toContain('p=quarantine');
    expect(quarantine.value).not.toContain('pct');
    expect(quarantine.pct).toBe(100);
    expect(quarantine.value).toContain('ruf=mailto:dmarc-forensics@reports.dmarcharbor.com');
    expect(quarantine.notes.join(' ')).toContain('personal data');

    const reject = buildDmarcRecord('example.com', 'reject', false);
    expect(reject.value).toBe('v=DMARC1; p=reject; rua=mailto:dmarc-reports@reports.dmarcharbor.com');
  });

  it('adds pct only when the canary is below 100', () => {
    const canary = buildDmarcRecord('example.com', 'quarantine', false, 5);
    expect(canary.value).toBe(
      'v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@reports.dmarcharbor.com; pct=5',
    );
  });

  it('serves the record over the API', async () => {
    const { agent, organizationId, domainId } = await createWorkspace();

    const response = await agent.get(
      `/api/workspaces/${organizationId}/domains/${domainId}/dmarc-record?policy=quarantine&forensics=true`,
    );

    expect(response.status).toBe(200);
    expect(response.body.value).toContain('p=quarantine');
    expect(response.body.aggregateAddress).toBe('dmarc-reports@reports.dmarcharbor.com');

    const badPolicy = await agent.get(
      `/api/workspaces/${organizationId}/domains/${domainId}/dmarc-record?policy=delete-everything`,
    );
    expect(badPolicy.status).toBe(400);
  });
});

describe('onboarding state', () => {
  beforeAll(resetDatabase);

  it('reports an unverified domain as awaiting verification with blocked steps', async () => {
    const { agent, organizationId, domainId } = await createWorkspace({ verify: false, dmarcRecord: null });

    const response = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/onboarding`);

    expect(response.status).toBe(200);
    expect(response.body.state).toBe('AWAITING_VERIFICATION');
    const verified = response.body.steps.find((step: { id: string }) => step.id === 'domain_verified');
    expect(verified.status).toBe('pending');
    const dmarcStep = response.body.steps.find((step: { id: string }) => step.id === 'dmarc_published');
    expect(dmarcStep.status).toBe('blocked');
    expect(response.body.suggestedRecord.value).toContain('v=DMARC1');
  });

  it('moves through awaiting reports to monitoring', async () => {
    const { agent, organizationId, domainId } = await createWorkspace();

    const before = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/onboarding`);
    expect(before.body.state).toBe('AWAITING_REPORTS');
    const flowing = before.body.steps.find((step: { id: string }) => step.id === 'reports_flowing');
    expect(flowing.status).toBe('pending');

    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('onboard-client.test', 'ob-1', [{ ip: '192.0.2.1', count: 5000, dkim: 'pass', spf: 'pass' }]),
    });

    const after = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/onboarding`);
    expect(after.body.state).toBe('MONITORING');
    expect(after.body.steps.find((step: { id: string }) => step.id === 'reports_flowing').status).toBe('done');
  });

  it('marks a domain needing attention when alerts are open', async () => {
    const { agent, organizationId, domainId, } = await createWorkspace({
      dmarcRecord: 'v=DMARC1; p=none; rua=mailto:dmarc-reports@reports.dmarcharbor.com',
    });

    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('onboard-client.test', 'ob-2', [{ ip: '45.83.12.9', count: 900, dkim: 'fail', spf: 'fail' }]),
    });

    const member = await prisma.member.findFirstOrThrow({ where: { organizationId } });
    const rule = await prisma.alertRule.create({
      data: {
        organizationId,
        domainId,
        name: 'Open alert',
        metric: AlertMetric.FAILURE_COUNT,
        operator: AlertOperator.GREATER_THAN,
        threshold: 100,
        windowMinutes: 1440,
        cooldownMinutes: 1440,
        createdById: member.userId,
      },
    });
    await prisma.alertEvent.create({
      data: {
        ruleId: rule.id,
        organizationId,
        domainId,
        metric: AlertMetric.FAILURE_COUNT,
        operator: AlertOperator.GREATER_THAN,
        observedValue: 900,
        threshold: 100,
        windowMinutes: 1440,
        summary: 'Observed 900 messages',
      },
    });

    const response = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/onboarding`);
    expect(response.body.state).toBe('NEEDS_ATTENTION');
    expect(response.body.readiness.openAlerts).toBe(1);
  });

  it('refuses onboarding data for another workspace domain', async () => {
    const first = await createWorkspace();
    const other = await createWorkspace();

    const response = await other.agent.get(
      `/api/workspaces/${other.organizationId}/domains/${first.domainId}/onboarding`,
    );
    expect(response.status).toBe(404);
  });
});

describe('policy readiness', () => {
  beforeAll(resetDatabase);

  it('blocks tightening when there is too little data', async () => {
    const { agent, organizationId, domainId } = await createWorkspace();

    const response = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/policy-readiness`);

    expect(response.status).toBe(200);
    expect(response.body.ready).toBe(false);
    expect(response.body.level).toBe('none');
    expect(response.body.messagesObserved).toBe(0);
    expect(response.body.blockers.join(' ')).toContain(String(readinessThresholds.minimumMessages));
  });

  it('blocks tightening when open alerts exist even with good volume', async () => {
    const { agent, organizationId, domainId } = await createWorkspace();

    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('onboard-client.test', 'ready-1', [
        { ip: '192.0.2.1', count: 20_000, dkim: 'pass', spf: 'pass' },
      ]),
    });

    const member = await prisma.member.findFirstOrThrow({ where: { organizationId } });
    const rule = await prisma.alertRule.create({
      data: {
        organizationId,
        domainId,
        name: 'Blocking alert',
        metric: AlertMetric.FAILURE_COUNT,
        operator: AlertOperator.GREATER_THAN,
        threshold: 10,
        windowMinutes: 1440,
        cooldownMinutes: 1440,
        createdById: member.userId,
      },
    });
    await prisma.alertEvent.create({
      data: {
        ruleId: rule.id,
        organizationId,
        domainId,
        metric: AlertMetric.FAILURE_COUNT,
        operator: AlertOperator.GREATER_THAN,
        observedValue: 50,
        threshold: 10,
        windowMinutes: 1440,
        summary: 'Observed 50 messages',
      },
    });

    const response = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/policy-readiness`);
    expect(response.body.ready).toBe(false);
    expect(response.body.blockers.join(' ')).toContain('still open');
  });
});

describe('client-facing report share', () => {
  beforeAll(resetDatabase);

  it('serves a public report with no authentication and no personal data', async () => {
    const { agent, organizationId, domainId } = await createWorkspace();

    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('onboard-client.test', 'share-1', [
        { ip: '45.83.12.9', count: 900, dkim: 'fail', spf: 'fail' },
        { ip: '192.0.2.1', count: 9000, dkim: 'pass', spf: 'pass' },
      ]),
    });

    const share = await agent.post(`/api/workspaces/${organizationId}/report-shares`).send({
      domainId,
      includeForensics: true,
      includeSources: true,
      expiresInDays: 7,
    });

    expect(share.status).toBe(201);
    expect(share.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(share.body.url).toBe(`/api/reports/share/${share.body.token}`);

    const publicView = await request(app).get(share.body.url);

    expect(publicView.status).toBe(200);
    expect(publicView.headers['cache-control']).toBe('no-store');
    expect(publicView.body.sharedFor).toEqual({
      organization: 'Onboarding Agency',
      client: 'Acme Corp',
      domain: 'onboard-client.test',
    });
    expect(publicView.body.health.score).toBe(82);
    expect(publicView.body.reporting.reportsReceived).toBe(1);
    expect(publicView.body.sources.length).toBeGreaterThan(0);
    expect(publicView.body.forensic.included).toBe(true);

    const serialized = JSON.stringify(publicView.body);
    expect(serialized).not.toContain('pseudonym');
    expect(serialized).not.toContain('Pseudonym');
    expect(serialized).not.toContain('subjectLine');
    expect(serialized).not.toContain('recipientAddresses');
    expect(serialized).not.toContain('@example.com');
    expect(serialized).not.toContain('Wire transfer details');
    expect(serialized).not.toContain('attacker@spammer.test');

    const stored = await prisma.reportShare.findUniqueOrThrow({ where: { id: share.body.id } });
    expect(stored.viewCount).toBe(1);
    expect(stored.lastViewedAt).not.toBeNull();
  });

  it('omits forensic and source data when the share excludes it', async () => {
    const { agent, organizationId, domainId } = await createWorkspace();

    await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('onboard-client.test', 'share-2', [{ ip: '45.83.12.9', count: 900, dkim: 'fail', spf: 'fail' }]),
    });

    const share = await agent.post(`/api/workspaces/${organizationId}/report-shares`).send({
      domainId,
      includeForensics: false,
      includeSources: false,
    });

    const publicView = await request(app).get(share.body.url);
    expect(publicView.status).toBe(200);
    expect(publicView.body.forensic).toBeNull();
    expect(publicView.body.sources).toEqual([]);
  });

  it('never exposes forensic identity detail even when forensics are included', async () => {
    const domainName = `forensic-share-${Date.now()}.test`;
    const { agent, organizationId, domainId } = await createWorkspace({
      domainName,
      dmarcRecord: `v=DMARC1; p=none; rua=mailto:dmarc-reports@reports.dmarcharbor.com; ruf=mailto:dmarc-forensics@reports.dmarcharbor.com`,
    });

    await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domainId}/forensics/identities`)
      .send({ retainForensicPii: true, confirmLegalBasis: true });

    const { createHmac } = await import('node:crypto');
    const rawEmail = forensicEmail(domainName, 'share-ruf-1@spammer.test');
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

    const share = await agent.post(`/api/workspaces/${organizationId}/report-shares`).send({
      domainId,
      includeForensics: true,
    });

    const publicView = await request(app).get(share.body.url);
    expect(publicView.status).toBe(200);
    expect(publicView.body.forensic.reportCount).toBe(1);
    expect(publicView.body.forensic.affectedRecipients).toBe(1);

    const serialized = JSON.stringify(publicView.body);
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('Wire transfer details');
    expect(serialized).not.toContain('spammer.test"');
  });

  it('revokes, expires and rejects unknown tokens', async () => {
    const { agent, organizationId, domainId } = await createWorkspace();

    const share = await agent.post(`/api/workspaces/${organizationId}/report-shares`).send({ domainId });
    expect((await request(app).get(share.body.url)).status).toBe(200);

    const revoked = await agent.delete(`/api/workspaces/${organizationId}/report-shares/${share.body.id}`);
    expect(revoked.status).toBe(204);
    expect((await request(app).get(share.body.url)).status).toBe(404);

    const unknown = await request(app).get(`/api/reports/share/${'a'.repeat(43)}`);
    expect(unknown.status).toBe(404);

    const malformed = await request(app).get('/api/reports/share/not-a-token');
    expect(malformed.status).toBe(404);

    const expiredShare = await prisma.reportShare.create({
      data: {
        token: 'b'.repeat(43),
        organizationId,
        clientId: (await prisma.domain.findUniqueOrThrow({ where: { id: domainId } })).clientId,
        domainId,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    expect((await request(app).get(`/api/reports/share/${expiredShare.token}`)).status).toBe(404);
  });

  it('lists shares and stops viewers creating them', async () => {
    const { agent, organizationId, domainId, } = await createWorkspace();
    const member = await prisma.member.findFirstOrThrow({ where: { organizationId } });

    await agent.post(`/api/workspaces/${organizationId}/report-shares`).send({ domainId });
    const listed = await agent.get(`/api/workspaces/${organizationId}/report-shares`);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].domain.name).toBe('onboard-client.test');
    expect(listed.body.items[0].client.name).toBe('Acme Corp');

    await prisma.member.updateMany({ where: { userId: member.userId }, data: { role: 'viewer' } });
    const denied = await agent.post(`/api/workspaces/${organizationId}/report-shares`).send({ domainId });
    expect(denied.status).toBe(403);
  });

  it('will not share a domain from another workspace', async () => {
    const first = await createWorkspace();
    const other = await createWorkspace();

    const response = await other.agent.post(`/api/workspaces/${other.organizationId}/report-shares`).send({
      domainId: first.domainId,
    });

    expect(response.status).toBe(404);
  });
});
