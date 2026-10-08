import { createHmac } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { purgeExpiredForensicReports } from '../src/services/forensic-report.service.js';
import { setOrganizationPlan } from '../src/services/entitlements/entitlement.service.js';
import { grantPlan } from './helpers/plan.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const boundary = 'ruf-boundary';

function forensicEmail(domain: string, options: { sourceIp?: string; messageId?: string } = {}): string {
  const sourceIp = options.sourceIp ?? '192.0.2.10';
  const messageId = options.messageId ?? 'abc123@spammer.test';

  return [
    'From: noreply-dmarc-support@google.com',
    'To: dmarc-reports@reports.dmarcharbor.com',
    `Subject: DMARC failure report for ${domain}`,
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
    'Final-Recipient: rfc822; alice@example.com',
    'Original-Recipient: rfc822; alice@example.com',
    'Action: fail',
    'Status: 5.7.1',
    'Diagnostic-Code: smtp; 550 5.7.1 Rejected due to DMARC policy for alice@example.com',
    'Remote-MTA: dns; mx1.spammer.test',
    `--${boundary}`,
    'Content-Type: application/feedback-report',
    '',
    'Feedback-Type: feedback-report',
    'Version: 1',
    'User-Agent: Google SMTP',
    'Original-Mail-From: <attacker@spammer.test>',
    'Original-Rcpt-To: <alice@example.com>',
    'Reporting-MTA: dns; mx.google.com',
    `Source-IP: ${sourceIp}`,
    `Reported-Domain: ${domain}`,
    'Authentication-Results: mx.google.com; spf=fail smtp.mailfrom=spammer.test; dkim=fail header.i=@spammer.test header.s=key1 header.d=spammer.test',
    `--${boundary}`,
    'Content-Type: text/rfc822-headers',
    '',
    'From: attacker@spammer.test',
    'To: alice@example.com',
    'Subject: Wire transfer details',
    'Date: Sat, 06 Apr 2024 11:59:00 +0000',
    `Message-ID: <${messageId}>`,
    `--${boundary}--`,
    '',
  ].join('\r\n');
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
  options: { collectForensicReports?: boolean; ruf?: boolean } = {},
): Promise<{
  agent: ReturnType<typeof request.agent>;
  organizationId: string;
  domainId: string;
}> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `forensics-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await agent.post('/api/auth/sign-up/email').send({
    name: 'Forensic Owner',
    email,
    password,
  });
  expect(signUp.status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const signIn = await agent.post('/api/auth/sign-in/email').send({ email, password });
  expect(signIn.status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Forensic Operations',
    slug: `forensic-operations-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
  expect(workspace.status).toBe(201);

  const client = await agent.post(`/api/workspaces/${workspace.body.id}/clients`).send({
    name: 'Forensic Client',
    slug: `forensic-client-${Date.now()}-${fixtureId}`,
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
      collectForensicReports: options.collectForensicReports ?? true,
      dmarcRecord: `v=DMARC1; p=reject; rua=mailto:agg@reports.dmarcharbor.com${
        options.ruf === false ? '' : '; ruf=mailto:forensics@reports.dmarcharbor.com'
      }`,
    },
  });

  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId);

  return {
    agent,
    organizationId: organizationId,
    domainId: domain.body.id as string,
  };
}

describe('forensic report ingestion', () => {
  beforeAll(resetDatabase);

  it('stores a redacted forensic report delivered by a signed inbound email', async () => {
    const { agent, organizationId, domainId } = await createWorkspaceDomain('forensic.test');
    const rawEmail = forensicEmail('forensic.test');

    const response = await postSignedInbound(rawEmail);

    expect(response.status).toBe(200);
    expect(response.body.kind).toBe('forensic');
    expect(response.body.candidateCount).toBe(1);
    expect(response.body.results[0].status).toBe('created');
    expect(response.body.results[0].reportDomain).toBe('forensic.test');

    const stored = await prisma.dmarcForensicReport.findFirstOrThrow({ where: { domainId } });
    expect(stored.reportedDomain).toBe('forensic.test');
    expect(stored.sourceIp).toBe('192.0.2.10');
    expect(stored.disposition).toBe('reject');
    expect(stored.dkimResult).toBe('fail');
    expect(stored.spfResult).toBe('fail');
    expect(stored.redactionVersion).toBe(1);
    expect(stored.retentionExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(stored.recipientCount).toBe(1);

    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('attacker@spammer.test');
    expect(serialized).not.toContain('Wire transfer details');
    expect(stored.subjectPseudonym).toMatch(/^[0-9a-f]{64}$/);

    const detail = await agent.get(`/api/workspaces/${organizationId}/forensics/${stored.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.sourceIp).toBe('192.0.2.10');
    expect(detail.body.domain.name).toBe('forensic.test');
  });

  it('treats a repeat delivery of the same message as a duplicate', async () => {
    const { domainId } = await createWorkspaceDomain('duplicate.test');
    const rawEmail = forensicEmail('duplicate.test', { messageId: 'dup-1@spammer.test' });

    const first = await postSignedInbound(rawEmail);
    const second = await postSignedInbound(rawEmail);

    expect(first.body.results[0].status).toBe('created');
    expect(second.body.results[0].status).toBe('duplicate');
    expect(second.body.results[0].reportId).toBe(first.body.results[0].reportId);
    expect(await prisma.dmarcForensicReport.count({ where: { domainId } })).toBe(1);
  });

  it('refuses to collect forensic reports when the domain has not opted in', async () => {
    await createWorkspaceDomain('opted-out.test', { collectForensicReports: false });

    const response = await postSignedInbound(forensicEmail('opted-out.test'));

    expect(response.status).toBe(200);
    expect(response.body.results[0].status).toBe('rejected');
    expect(response.body.results[0].message).toContain('disabled');
    expect(await prisma.dmarcForensicReport.count({ where: { reportedDomain: 'opted-out.test' } })).toBe(0);
  });

  it('refuses to collect forensic reports when the domain publishes no ruf address', async () => {
    await createWorkspaceDomain('no-ruf.test', { ruf: false });

    const response = await postSignedInbound(forensicEmail('no-ruf.test'));

    expect(response.status).toBe(200);
    expect(response.body.results[0].status).toBe('rejected');
    expect(response.body.results[0].message).toContain('ruf=');
    expect(await prisma.dmarcForensicReport.count({ where: { reportedDomain: 'no-ruf.test' } })).toBe(0);
  });

  it('supports manual forensic ingestion and the collection opt-in switch', async () => {
    const { agent, organizationId, domainId } = await createWorkspaceDomain('manual.test', {
      collectForensicReports: false,
    });
    const rawEmail = forensicEmail('manual.test', { messageId: 'manual-1@spammer.test' });

    const blocked = await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/forensics`).send({ rawEmail });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('Enable forensic report collection');

    const enabled = await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domainId}/forensics`)
      .send({ collectForensicReports: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.domain.collectForensicReports).toBe(true);
    expect(enabled.body.domain.rufConfigured).toBe(true);
    expect(enabled.body.retentionDays).toBeGreaterThan(0);

    const ingested = await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/forensics`).send({ rawEmail });
    expect(ingested.status).toBe(201);
    expect(ingested.body.duplicate).toBe(false);
    expect(ingested.body.forensic.reportedDomain).toBe('manual.test');

    const list = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/forensics`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.redactionVersion).toBe(1);
  });

  it('restricts forensic reads to roles that hold the forensic permission', async () => {
    const { agent, organizationId, domainId } = await createWorkspaceDomain('roles.test');
    await postSignedInbound(forensicEmail('roles.test', { messageId: 'roles-1@spammer.test' }));

    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'viewer' } });
    const denied = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/forensics`);
    expect(denied.status).toBe(403);

    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'analyst' } });
    const allowed = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/forensics`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.items).toHaveLength(1);
  });

  /**
   * The licence check and the role check are different questions, and a route
   * that asks only one of them is wrong in a way that is invisible from the UI.
   *
   * Four of these routes asked only "does this role hold forensic:*" and never
   * "is this workspace paying for forensics". That is not a cosmetic gap: a Mooring
   * workspace, which deliberately excludes forensics from the free plan, could
   * turn collection on and then delete a domain's entire forensic history, while
   * being unable to read a single report back. Destroying evidence is strictly
   * worse than collecting it, so the purges now ask for the licence too.
   */
  it('refuses to destroy forensic data on a plan that does not include it', async () => {
    const { agent, organizationId, domainId } = await createWorkspaceDomain('licence.test');
    await postSignedInbound(forensicEmail('licence.test', { messageId: 'licence-1@spammer.test' }));
    const stored = await prisma.dmarcForensicReport.findFirstOrThrow({ where: { domainId } });

    // Admin holds every permission, so only the licence can refuse this.
    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'admin' } });
    await setOrganizationPlan(organizationId, 'MOORING');

    const list = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/forensics`);
    expect(list.status).toBe(402);
    expect(list.body.error.feature).toBe('reports.forensic');

    const detail = await agent.get(`/api/workspaces/${organizationId}/forensics/${stored.id}`);
    expect(detail.status).toBe(402);

    const purgeOne = await agent.delete(`/api/workspaces/${organizationId}/forensics/${stored.id}`);
    expect(purgeOne.status).toBe(402);

    const purgeAll = await agent.delete(`/api/workspaces/${organizationId}/domains/${domainId}/forensics`);
    expect(purgeAll.status).toBe(402);

    // The refusal has to have cost nothing, or the gate is theatre.
    expect(await prisma.dmarcForensicReport.count({ where: { domainId } })).toBe(1);

    const collection = await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domainId}/forensics`)
      .send({ collectForensicReports: false });
    expect(collection.status).toBe(402);

    // Same workspace, same admin, one plan higher: everything works.
    await setOrganizationPlan(organizationId, 'FAIRWAY');
    expect(
      (await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/forensics`)).status,
    ).toBe(200);
    expect(
      (await agent.delete(`/api/workspaces/${organizationId}/forensics/${stored.id}`)).status,
    ).toBe(204);
  });

  it('lets only forensic purge holders delete forensic data', async () => {
    const { agent, organizationId, domainId } = await createWorkspaceDomain('purge.test');
    await postSignedInbound(forensicEmail('purge.test', { messageId: 'purge-1@spammer.test' }));
    const stored = await prisma.dmarcForensicReport.findFirstOrThrow({ where: { domainId } });

    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'analyst' } });
    const denied = await agent.delete(`/api/workspaces/${organizationId}/forensics/${stored.id}`);
    expect(denied.status).toBe(403);

    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'admin' } });
    const allowed = await agent.delete(`/api/workspaces/${organizationId}/forensics/${stored.id}`);
    expect(allowed.status).toBe(204);
    expect(await prisma.dmarcForensicReport.count({ where: { domainId } })).toBe(0);
  });

  it('deletes forensic data once the retention window has passed', async () => {
    const { domainId } = await createWorkspaceDomain('retention.test');
    await postSignedInbound(forensicEmail('retention.test', { messageId: 'retention-1@spammer.test' }));

    const stored = await prisma.dmarcForensicReport.findFirstOrThrow({ where: { domainId } });
    expect(stored.retentionExpiresAt.getTime()).toBeGreaterThan(Date.now());

    await prisma.dmarcForensicReport.update({
      where: { id: stored.id },
      data: { retentionExpiresAt: new Date(Date.now() - 1000) },
    });

    const purged = await purgeExpiredForensicReports(true);
    expect(purged).toBe(1);
    expect(await prisma.dmarcForensicReport.count({ where: { domainId } })).toBe(0);
  });
});
