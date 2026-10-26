import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

function dkimKey(): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return `v=DKIM1; k=rsa; p=${Buffer.from(der).toString('base64')}`;
}

function scanResult() {
  return {
    domain: 'placeholder',
    scannedAt: new Date().toISOString(),
    status: 'healthy',
    score: 90,
    scoreBreakdown: { total: 100, factors: [] },
    dmarc: {
      status: 'found',
      record: 'v=DMARC1; p=none; rua=mailto:reports@example.test',
      policy: 'none',
      tags: {},
      hasAggregateReports: true,
      hasForensicReports: false,
      aggregateMailtoTargets: ['mailto:reports@example.test'],
      aggregateWebTargets: [],
    },
    spf: { status: 'found', record: 'v=spf1 -all', valid: true, lookupCount: 0 },
    dkim: { status: 'found', selectors: ['s1'], checkedSelectors: ['s1'], records: { s1: dkimKey() } },
    mx: { status: 'found', records: [{ exchange: 'mx.example.test', priority: 10 }] },
    issues: [],
    recommendations: [],
  };
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "source_ip_intel", "sender_review", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "dns_change", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup() {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `mailbox-owner-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Mailbox Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Mailbox Compliance Agency',
    slug: `mailbox-compliance-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;

  const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name: 'Mailbox Client',
    slug: `mailbox-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);

  const domainName = `mailbox-${fixtureId}.test`;
  const domain = await agent.post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`).send({
    name: domainName,
  });
  expect(domain.status).toBe(201);

  await prisma.domain.update({
    where: { id: domain.body.id },
    data: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      dmarcPolicy: 'none',
      dmarcRecord: 'v=DMARC1; p=none; rua=mailto:reports@example.test',
    },
  });

  const result = scanResult();
  result.domain = domainName;
  const scan = await prisma.scan.create({
    data: {
      domainId: domain.body.id,
      status: 'COMPLETED',
      trigger: 'MANUAL',
      score: 90,
      result,
      completedAt: new Date(),
    },
  });

  const end = new Date(Date.now() - 86_400_000);
  const begin = new Date(end.getTime() - 20 * 60 * 60 * 1000);

  await prisma.dmarcReport.create({
    data: {
      domainId: domain.body.id,
      reportType: 'AGGREGATE',
      fingerprint: `mailbox-google-${Date.now()}-${fixtureId}`,
      reportingEmail: 'noreply-dmarc-support@google.com',
      reportingOrganization: 'google.com',
      dateRangeBegin: begin,
      dateRangeEnd: end,
      receivedAt: end,
      recordCount: 3,
      records: {
        create: [
          {
            sourceIp: '198.51.100.10',
            messageCount: 100,
            dkimResult: 'pass',
            spfResult: 'pass',
            senderKey: 'good.google.test',
            senderDomain: 'good.google.test',
            authResults: {
              create: [
                { type: 'DKIM', result: 'pass', domain: 'good.google.test' },
                { type: 'SPF', result: 'pass', domain: 'good.google.test', scope: 'mfrom' },
              ],
            },
          },
          {
            sourceIp: '198.51.100.11',
            messageCount: 90,
            dkimResult: 'pass',
            spfResult: 'pass',
            senderKey: 'bad.google.test',
            senderDomain: 'bad.google.test',
            authResults: {
              create: [
                { type: 'DKIM', result: 'pass', domain: 'bad.google.test' },
                { type: 'SPF', result: 'pass', domain: 'bad.google.test', scope: 'mfrom' },
              ],
            },
          },
          {
            sourceIp: '198.51.100.11',
            messageCount: 10,
            dkimResult: 'fail',
            spfResult: 'fail',
            senderKey: 'bad.google.test',
            senderDomain: 'bad.google.test',
            authResults: {
              create: [
                { type: 'DKIM', result: 'fail', domain: 'bad.google.test' },
                { type: 'SPF', result: 'fail', domain: 'bad.google.test', scope: 'mfrom' },
              ],
            },
          },
          {
            sourceIp: '45.83.12.9',
            messageCount: 100,
            dkimResult: 'fail',
            spfResult: 'fail',
            senderKey: 'notours.test',
            senderDomain: 'notours.test',
            authResults: {
              create: [
                { type: 'DKIM', result: 'fail', domain: 'notours.test' },
                { type: 'SPF', result: 'fail', domain: 'notours.test', scope: 'mfrom' },
              ],
            },
          },
        ],
      },
    },
  });

  await prisma.dmarcReport.create({
    data: {
      domainId: domain.body.id,
      reportType: 'AGGREGATE',
      fingerprint: `mailbox-yahoo-${Date.now()}-${fixtureId}`,
      reportingEmail: null,
      reportingOrganization: 'Yahoo',
      dateRangeBegin: begin,
      dateRangeEnd: end,
      receivedAt: new Date(end.getTime() + 60_000),
      recordCount: 1,
      records: {
        create: [
          {
            sourceIp: '198.51.100.20',
            messageCount: 100,
            dkimResult: 'pass',
            spfResult: 'pass',
            senderKey: 'good.yahoo.test',
            senderDomain: 'good.yahoo.test',
            authResults: {
              create: [
                { type: 'DKIM', result: 'pass', domain: 'good.yahoo.test' },
                { type: 'SPF', result: 'pass', domain: 'good.yahoo.test', scope: 'mfrom' },
              ],
            },
          },
        ],
      },
    },
  });

  await prisma.senderReview.create({
    data: {
      organizationId,
      domainId: domain.body.id,
      senderKey: 'notours.test',
      status: 'NOT_OURS',
      reviewedAt: new Date(),
    },
  });

  const future = new Date(Date.now() + 30 * 86_400_000);
  await prisma.sourceIpIntel.createMany({
    data: [
      {
        ip: '198.51.100.10',
        ptr: 'mail.good.google.test',
        ptrConfirmed: true,
        status: 'OK',
        lookedUpAt: new Date(),
        expiresAt: future,
        lastSeenAt: new Date(),
      },
      {
        ip: '198.51.100.20',
        ptr: 'mail.good.yahoo.test',
        ptrConfirmed: true,
        status: 'OK',
        lookedUpAt: new Date(),
        expiresAt: future,
        lastSeenAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });

  return { agent, organizationId, domainId: domain.body.id as string, domainName, scanId: scan.id, email };
}

async function addViewer(organizationId: string) {
  fixtureId += 1;
  const email = `mailbox-viewer-${Date.now()}-${fixtureId}@example.com`;
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Mailbox Viewer', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  await prisma.member.create({
    data: { id: `mailbox-viewer-${fixtureId}`, organizationId, userId: user.id, role: 'viewer', createdAt: new Date() },
  });
  return agent;
}

describe('mailbox requirement checks', () => {
  beforeEach(resetDatabase);

  it('returns the provider strip and requirement verdicts from stored evidence', async () => {
    const ctx = await setup();

    const response = await ctx.agent.get(
      `/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/mailbox-compliance`,
    );
    expect(response.status).toBe(200);

    expect(response.body).toMatchObject({
      domain: { id: ctx.domainId, name: ctx.domainName },
      windowDays: 30,
      rowsTruncated: false,
      scan: { id: ctx.scanId },
      thresholds: { minimumMessagesForSignal: 50, maximumFailureSharePercent: 5 },
    });

    const google = response.body.providers.find((provider: { id: string }) => provider.id === 'google');
    expect(google).toMatchObject({
      reportCount: 1,
      messages: 200,
      peakDailyMessages: 200,
      aboveBulkThreshold: false,
      bulkThreshold: 5000,
    });
    const yahoo = response.body.providers.find((provider: { id: string }) => provider.id === 'yahoo');
    expect(yahoo).toMatchObject({ reportCount: 1, messages: 100 });
    const microsoft = response.body.providers.find((provider: { id: string }) => provider.id === 'microsoft');
    expect(microsoft).toMatchObject({ reportCount: 0, messages: 0, peakDailyMessages: null, aboveBulkThreshold: null });

    const checks = Object.fromEntries(
      response.body.checks.map((entry: { code: string }) => [entry.code, entry]),
    );
    expect(checks.spf_or_dkim.status).toBe('meets');
    expect(checks.dkim_key_length.status).toBe('meets');
    expect(checks.reverse_dns.status).toBe('meets');
    expect(checks.spf_record.status).toBe('meets');
    expect(checks.dkim_record.status).toBe('meets');
    expect(checks.dmarc_record.status).toBe('meets');
    expect(checks.dmarc_reporting.status).toBe('meets');
    expect(checks.dmarc_passing.status).toBe('fails');
    expect(checks.dkim_passing.status).toBe('fails');
    expect(checks.spf_passing.status).toBe('fails');
    expect(checks.spam_rate.status).toBe('not_checkable');
    expect(checks.spam_rate.whereToCheck).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: 'https://postmaster.google.com/' })]),
    );

    const dmarcGoogle = checks.dmarc_passing.perProvider.find(
      (entry: { provider: string }) => entry.provider === 'google',
    );
    expect(dmarcGoogle.failingSenders[0]).toMatchObject({
      senderKey: 'bad.google.test',
      failingMessages: 10,
      failingSharePercent: 10,
    });
    expect(JSON.stringify(response.body)).not.toContain('notours.test');
    expect(JSON.stringify(response.body).toLowerCase()).not.toContain('compliant');
  });

  it('is available on Mooring without a plan grant', async () => {
    const ctx = await setup();
    const response = await ctx.agent.get(
      `/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/mailbox-compliance`,
    );
    expect(response.status).toBe(200);
  });

  it('allows a viewer to read it, and refuses another workspace or no session', async () => {
    const ctx = await setup();
    const viewer = await addViewer(ctx.organizationId);

    expect(
      (
        await viewer.get(
          `/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/mailbox-compliance`,
        )
      ).status,
    ).toBe(200);

    const other = await setup();
    expect(
      (
        await other.agent.get(
          `/api/workspaces/${other.organizationId}/domains/${ctx.domainId}/mailbox-compliance`,
        )
      ).status,
    ).toBe(404);

    expect(
      (
        await request(app).get(
          `/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/mailbox-compliance`,
        )
      ).status,
    ).toBe(401);
  });
});
