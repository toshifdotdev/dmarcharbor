import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const boundary = 'ruf-boundary';

function forensicEmail(options: { domain: string; sourceIp?: string; messageId?: string; recipient?: string }): string {
  const recipient = options.recipient ?? 'alice@example.com';
  const sourceIp = options.sourceIp ?? '192.0.2.10';
  const messageId = options.messageId ?? 'abc123@spammer.test';

  return [
    'From: noreply-dmarc-support@google.com',
    'To: dmarc-reports@reports.dmarcharbor.com',
    `Subject: DMARC failure report for ${options.domain}`,
    'MIME-Version: 1.0',
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
    `Source-IP: ${sourceIp}`,
    'Arrival-Date: Sat, 06 Apr 2024 12:00:01 +0000',
    '',
    `Final-Recipient: rfc822; ${recipient}`,
    `Original-Recipient: rfc822; ${recipient}`,
    'Action: fail',
    'Status: 5.7.1',
    `Diagnostic-Code: smtp; 550 5.7.1 Rejected due to DMARC policy for ${recipient}`,
    'Remote-MTA: dns; mx1.spammer.test',
    `--${boundary}`,
    'Content-Type: application/feedback-report',
    '',
    'Feedback-Type: feedback-report',
    'Version: 1',
    'User-Agent: Google SMTP',
    'Original-Mail-From: <attacker@spammer.test>',
    `Original-Rcpt-To: <${recipient}>`,
    'Reporting-MTA: dns; mx.google.com',
    `Source-IP: ${sourceIp}`,
    `Reported-Domain: ${options.domain}`,
    'Authentication-Results: mx.google.com; spf=fail smtp.mailfrom=spammer.test; dkim=fail header.i=@spammer.test header.s=key1 header.d=spammer.test',
    `--${boundary}`,
    'Content-Type: text/rfc822-headers',
    '',
    'From: attacker@spammer.test',
    `To: ${recipient}`,
    'Subject: Wire transfer details',
    'Date: Sat, 06 Apr 2024 11:59:00 +0000',
    `Message-ID: <${messageId}>`,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function aggregateReport(
  domain: string,
  reportId: string,
  rows: { ip: string; count: number; dkim: string; spf: string; sendingDomain?: string }[],
): string {
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
    <auth_results>
      <spf>
        <domain>${row.sendingDomain ?? domain}</domain>
        <scope>mfrom</scope>
        <result>${row.spf}</result>
      </spf>
    </auth_results>
  </record>`,
  )
  .join('\n')}
</feedback>`;
}

function sign(rawEmail: string): { timestamp: string; signature: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    timestamp,
    signature: `sha256=${createHmac('sha256', 'test-report-ingest-secret-please-change')
      .update(`${timestamp}.${rawEmail}`)
      .digest('hex')}`,
  };
}

async function postSignedInbound(rawEmail: string): Promise<request.Response> {
  const signed = sign(rawEmail);
  return request(app)
    .post('/api/internal/reports/inbound')
    .set('Content-Type', 'message/rfc822')
    .set('X-DMARC-Timestamp', signed.timestamp)
    .set('X-DMARC-Signature', signed.signature)
    .send(rawEmail);
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function createWorkspaceDomain(
  domainName: string,
  options: { collectForensicReports?: boolean } = {},
): Promise<{ agent: ReturnType<typeof request.agent>; organizationId: string; domainId: string; userId: string }> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `insights-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await agent.post('/api/auth/sign-up/email').send({ name: 'Insights Owner', email, password });
  expect(signUp.status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const signIn = await agent.post('/api/auth/sign-in/email').send({ email, password });
  expect(signIn.status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Insights Operations',
    slug: `insights-operations-${Date.now()}-${fixtureId}`,
  });
  expect(workspace.status).toBe(201);

  const client = await agent.post(`/api/workspaces/${workspace.body.id}/clients`).send({
    name: 'Insights Client',
    slug: `insights-client-${Date.now()}-${fixtureId}`,
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
      score: 78,
      collectForensicReports: options.collectForensicReports ?? true,
      dmarcRecord: 'v=DMARC1; p=reject; rua=mailto:agg@reports.dmarcharbor.com; ruf=mailto:forensics@reports.dmarcharbor.com',
    },
  });

  const owner = await prisma.member.findFirstOrThrow({ where: { organizationId: workspace.body.id } });

  return {
    agent,
    organizationId: workspace.body.id as string,
    domainId: domain.body.id as string,
    userId: owner.userId,
  };
}

describe('plan-gated forensic identity retention', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('stores no plaintext identities by default even when a report is received', async () => {
    const { domainId } = await createWorkspaceDomain('hashed.test');

    const response = await postSignedInbound(forensicEmail({ domain: 'hashed.test', messageId: 'hashed-1@spammer.test' }));
    expect(response.body.results[0].status).toBe('created');

    const stored = await prisma.dmarcForensicReport.findFirstOrThrow({ where: { domainId } });
    expect(stored.piiRetained).toBe(false);
    expect(stored.recipientAddresses).toBeNull();
    expect(stored.subjectLine).toBeNull();
    expect(stored.envelopeFrom).toBeNull();
    expect(JSON.stringify(stored)).not.toContain('alice@example.com');
    expect(JSON.stringify(stored)).not.toContain('Wire transfer details');
  });

  it('requires an explicit legal basis confirmation before enabling named retention', async () => {
    const { agent, organizationId, domainId } = await createWorkspaceDomain('consent.test');

    const refused = await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domainId}/forensics/identities`)
      .send({ retainForensicPii: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('lawful basis');

    const accepted = await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domainId}/forensics/identities`)
      .send({ retainForensicPii: true, confirmLegalBasis: true });
    expect(accepted.status).toBe(200);
    expect(accepted.body.domain.retainForensicPii).toBe(true);
    expect(accepted.body.domain.forensicPiiEnabledAt).not.toBeNull();
    expect(accepted.body.piiRetentionDays).toBeLessThan(accepted.body.retentionDays);

    const audit = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    expect(audit.forensicPiiEnabledById).not.toBeNull();
  });

  it('encrypts named identities at rest and only decrypts for identify holders', async () => {
    const { agent, organizationId, domainId, userId } = await createWorkspaceDomain('named.test');
    await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domainId}/forensics/identities`)
      .send({ retainForensicPii: true, confirmLegalBasis: true });

    await postSignedInbound(forensicEmail({ domain: 'named.test', messageId: 'named-1@spammer.test' }));

    const stored = await prisma.dmarcForensicReport.findFirstOrThrow({ where: { domainId } });
    expect(stored.piiRetained).toBe(true);
    expect(stored.subjectLine).toBeTruthy();
    expect(stored.subjectLine).not.toContain('Wire transfer details');
    expect(stored.recipientAddresses).not.toBeNull();
    expect(JSON.stringify(stored.recipientAddresses)).not.toContain('alice@example.com');
    expect(stored.retentionExpiresAt.getTime()).toBeLessThan(
      new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).getTime(),
    );

    const ownerView = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/forensics`);
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.forensics[0].subjectLine).toBe('Wire transfer details');
    expect(ownerView.body.forensics[0].recipientAddresses).toEqual(['alice@example.com']);
    expect(ownerView.body.forensics[0].piiAvailable).toBe(true);

    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'analyst' } });
    const analystView = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/forensics`);
    expect(analystView.status).toBe(200);
    expect(analystView.body.forensics[0].subjectLine).toBeUndefined();
    expect(analystView.body.forensics[0].recipientAddresses).toBeUndefined();
    expect(analystView.body.forensics[0].piiWithheld).toBe(true);

    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'owner', userId } });
  });

  it('stops retaining new named identities once the toggle is switched off', async () => {
    const { agent, organizationId, domainId } = await createWorkspaceDomain('revoke.test');
    await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domainId}/forensics/identities`)
      .send({ retainForensicPii: true, confirmLegalBasis: true });
    await postSignedInbound(forensicEmail({ domain: 'revoke.test', messageId: 'revoke-1@spammer.test' }));

    const disabled = await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domainId}/forensics/identities`)
      .send({ retainForensicPii: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.domain.retainForensicPii).toBe(false);
    expect(disabled.body.domain.forensicPiiEnabledAt).toBeNull();

    await postSignedInbound(forensicEmail({ domain: 'revoke.test', messageId: 'revoke-2@spammer.test' }));

    const rows = await prisma.dmarcForensicReport.findMany({ where: { domainId } });
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.piiRetained)).toHaveLength(1);
  });

  it('denies the identity toggle to roles without the identify permission', async () => {
    const { agent, organizationId, domainId } = await createWorkspaceDomain('identify-permission.test');
    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'analyst' } });

    const response = await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domainId}/forensics/identities`)
      .send({ retainForensicPii: true, confirmLegalBasis: true });

    expect(response.status).toBe(403);
  });
});

describe('domain insights', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('summarises reports, attributes sources, and detects spikes', async () => {
    const { agent, organizationId, domainId } = await createWorkspaceDomain('insights.test');

    const clean = await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('insights.test', 'clean-1', [{ ip: '192.0.2.1', count: 1000, dkim: 'pass', spf: 'pass' }]),
    });
    expect(clean.status).toBe(201);

    const dirty = await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
      xml: aggregateReport('insights.test', 'dirty-1', [
        { ip: '45.83.12.9', count: 40, dkim: 'fail', spf: 'fail', sendingDomain: 'spammer.test' },
        { ip: '45.83.12.9', count: 10, dkim: 'fail', spf: 'pass', sendingDomain: 'spammer.test' },
        { ip: '192.0.2.1', count: 5, dkim: 'pass', spf: 'pass' },
      ]),
    });
    expect(dirty.status).toBe(201);

    await postSignedInbound(
      forensicEmail({ domain: 'insights.test', sourceIp: '45.83.12.9', messageId: 'insights-f1@spammer.test' }),
    );
    await postSignedInbound(
      forensicEmail({ domain: 'insights.test', sourceIp: '45.83.12.9', messageId: 'insights-f2@spammer.test' }),
    );

    const insights = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/insights?days=30`);

    expect(insights.status).toBe(200);
    expect(insights.body.domain.name).toBe('insights.test');
    expect(insights.body.domain.score).toBe(78);
    expect(insights.body.reporting.aggregateConfigured).toBe(true);
    expect(insights.body.reporting.forensicConfigured).toBe(true);
    expect(insights.body.reporting.collectionEnabled).toBe(true);
    expect(insights.body.reporting.identityRetentionEnabled).toBe(false);

    expect(insights.body.aggregate.reportCount).toBe(2);
    expect(insights.body.aggregate.messageCount).toBe(1055);
    expect(insights.body.aggregate.failedMessages).toBe(50);
    expect(insights.body.aggregate.dkimPassRate).toBeGreaterThan(90);
    expect(insights.body.aggregate.messageWindow.begin).not.toBeNull();

    expect(insights.body.forensic.count).toBe(2);
    expect(insights.body.forensic.rejectedMessages).toBe(2);
    expect(insights.body.forensic.affectedRecipients).toBe(1);
    expect(insights.body.forensic.retainedIdentities).toBe(0);

    const attacker = insights.body.sources.find((source: { sourceIp: string }) => source.sourceIp === '45.83.12.9');
    expect(attacker).toBeDefined();
    expect(attacker.totalMessages).toBe(50);
    expect(attacker.failedMessages).toBe(50);
    expect(attacker.forensicMessages).toBe(2);
    expect(attacker.risk).toBe('high');
    expect(attacker.topSendingDomain).toContain('spammer.test');
    expect(insights.body.sources[0].sourceIp).toBe('45.83.12.9');

    expect(insights.body.trends.points.length).toBeGreaterThan(0);
    expect(insights.body.trends.days).toBe(30);
    expect(insights.body.retention.redactionVersion).toBe(1);
  });

  it('requires report read permission', async () => {
    const { agent, organizationId, domainId } = await createWorkspaceDomain('insights-permission.test');
    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'analyst' } });

    const response = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/insights`);

    expect(response.status).toBe(200);
  });

  it('refuses to read a domain that belongs to another workspace', async () => {
    const first = await createWorkspaceDomain('insights-scope-a.test');
    const { domainId } = first;
    const other = await createWorkspaceDomain('insights-scope-b.test');

    const anonymous = await request(app).get(`/api/workspaces/${other.organizationId}/domains/${domainId}/insights`);
    expect(anonymous.status).toBe(401);

    const crossWorkspace = await other.agent.get(
      `/api/workspaces/${other.organizationId}/domains/${domainId}/insights`,
    );
    expect(crossWorkspace.status).toBe(404);
  });
});
