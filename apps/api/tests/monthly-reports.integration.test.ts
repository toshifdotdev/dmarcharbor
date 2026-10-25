import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PlanTier } from '@prisma/client';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { runMonthlyReportSchedules } from '../src/services/reports/monthly-report-schedule.service.js';
import { collectMonthlyFacts, issueMonthlyReport } from '../src/services/reports/monthly-report.service.js';
import { parseMonthlyPeriod } from '../src/services/reports/monthly-period.js';
import { purgeExpiredData } from '../src/services/retention.service.js';
import { buildExportPayload } from '../src/services/export/export.service.js';
import { grantPlan } from './helpers/plan.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const period = '2026-09';

function n(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function extractPdfText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  const pattern = /<([0-9a-fA-F]+)>/g;
  const parts: string[] = [];
  let match = pattern.exec(raw);
  while (match !== null) {
    const hex = match[1]!;
    if (hex.length % 2 === 0) {
      parts.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
    match = pattern.exec(raw);
  }
  return parts.join(' ');
}

function pdfHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "monthly_report_link", "monthly_report_schedule", "compliance_document_file", "compliance_pack", "email_delivery", "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "dns_change", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function createWorkspace(plan: PlanTier = 'HARBOR') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `monthly-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Monthly Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Northgate Digital',
    slug: `monthly-agency-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;
  if (plan !== 'MOORING') {
    await grantPlan(organizationId, plan);
  }
  return { agent, organizationId, email };
}

async function createClient(
  agent: ReturnType<typeof request.agent>,
  organizationId: string,
  name = 'Acme Freight',
  options: { createdAt?: Date } = {},
) {
  fixtureId += 1;
  const response = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${fixtureId}`,
  });
  expect(response.status).toBe(201);
  if (options.createdAt) {
    await prisma.client.update({ where: { id: response.body.id }, data: { createdAt: options.createdAt } });
  }
  return response.body as { id: string; name: string };
}

async function createDomain(
  agent: ReturnType<typeof request.agent>,
  organizationId: string,
  clientId: string,
  name: string,
  options: { verified?: boolean } = {},
) {
  const response = await agent
    .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
    .send({ name });
  expect(response.status).toBe(201);
  if (options.verified !== false) {
    await prisma.domain.update({
      where: { id: response.body.id },
      data: { status: 'VERIFIED', verifiedAt: new Date('2025-02-01T00:00:00Z'), dmarcPolicy: 'reject' },
    });
  }
  return response.body as { id: string; name: string; slug: string };
}

async function seedReport(input: {
  domainId: string;
  begin: Date;
  records: Array<{
    sourceIp: string;
    messageCount: number;
    dkim: string;
    spf: string;
    senderDomain?: string;
    headerFrom?: string;
  }>;
  reportingOrganization?: string;
  policyP?: string;
  reportNumber?: number;
}) {
  fixtureId += 1;
  return prisma.dmarcReport.create({
    data: {
      domainId: input.domainId,
      reportType: 'AGGREGATE',
      fingerprint: `monthly-fingerprint-${input.reportNumber ?? fixtureId}-${Date.now()}`,
      reportingOrganization: input.reportingOrganization ?? 'Google LLC',
      reportingEmail: 'noreply-dmarc-support@google.com',
      dateRangeBegin: input.begin,
      dateRangeEnd: new Date(input.begin.getTime() + 24 * 60 * 60 * 1000 - 1),
      policyP: input.policyP ?? 'reject',
      records: {
        create: input.records.map((record) => ({
          sourceIp: record.sourceIp,
          messageCount: record.messageCount,
          dkimResult: record.dkim,
          spfResult: record.spf,
          senderDomain: record.senderDomain ?? null,
          headerFrom: record.headerFrom ?? null,
        })),
      },
    },
  });
}

async function seedScan(domainId: string, completedAt: Date, policy: string, testing = false) {
  return prisma.scan.create({
    data: {
      domainId,
      status: 'COMPLETED',
      trigger: 'SCHEDULED',
      startedAt: completedAt,
      completedAt,
      result: {
        dmarc: { status: 'found', policy, testing },
      } as Prisma.InputJsonValue,
    },
  });
}

function setHeaders(response: request.Response): { reference: string; sha256: string; body: Buffer } {
  const raw = response.headers as unknown as Record<string, string>;
  const body = response.body as Buffer;
  return {
    reference: raw['x-dmarc-pack-reference'] ?? '',
    sha256: raw['x-dmarc-pack-sha256'] ?? '',
    body,
  };
}

async function waitForEmails(count: number): Promise<void> {
  await vi.waitFor(
    async () => {
      const rows = await prisma.emailDelivery.count({
        where: { idempotencyKey: { startsWith: 'monthly-report:' } },
      });
      expect(rows).toBe(count);
    },
    { timeout: 5_000, interval: 25 },
  );
}

describe('monthly evidence reports', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('is a reports.compliancePack feature, available on Harbor and Fleet', async () => {
    for (const [plan, expected] of [
      ['FAIRWAY', 402],
      ['HARBOR', 200],
      ['FLEET', 200],
    ] as Array<[PlanTier, number]>) {
      const workspace = await createWorkspace(plan);
      const client = await createClient(workspace.agent, workspace.organizationId, `Plan ${plan}`, {
        createdAt: new Date('2025-01-01T00:00:00Z'),
      });
      const response = await workspace.agent
        .post(`/api/workspaces/${workspace.organizationId}/clients/${client.id}/monthly-reports`)
        .send({ period });
      expect(response.status).toBe(expected);
      if (expected === 402) {
        expect(response.body.error.feature).toBe('reports.compliancePack');
      } else {
        expect(response.headers['content-type']).toContain('application/pdf');
      }
    }
  });

  it('issues a PDF whose header digest, body digest and public verification all agree', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId, 'Acme Freight', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, 'acme-freight.test');
    await seedScan(domain.id, new Date('2026-09-30T23:00:00Z'), 'reject');
    await seedReport({
      domainId: domain.id,
      begin: new Date('2026-09-01T00:00:00Z'),
      records: [
        { sourceIp: '198.51.100.7', messageCount: 100, dkim: 'pass', spf: 'fail', senderDomain: 'mailer.example' },
        { sourceIp: '198.51.100.8', messageCount: 20, dkim: 'fail', spf: 'fail', senderDomain: 'bad.example' },
      ],
    });

    const response = await workspace.agent
      .post(`/api/workspaces/${workspace.organizationId}/clients/${client.id}/monthly-reports`)
      .send({ period });
    expect(response.status).toBe(200);
    const issued = setHeaders(response);
    expect(issued.sha256).toBe(pdfHash(issued.body));
    expect(issued.reference).toMatch(/^RPT-202609-ACME-FREIGHT-[A-F0-9]{24}$/);
    expect(response.headers['content-disposition']).toContain('dmarc-report-acme-freight-2026-09.pdf');

    const text = n(extractPdfText(issued.body));
    expect(text).toContain('acme-freight.test');
    expect(text).toContain('198.51.100.8');
    expect(text).not.toContain('198.51.100.7');
    expect(text).not.toContain('retention');

    const verified = await request(app)
      .get('/api/compliance-packs/verify')
      .query({ reference: issued.reference });
    expect(verified.status).toBe(200);
    expect(verified.body.packs[0]).toMatchObject({
      reference: issued.reference,
      kind: 'monthly_report',
      period: '2026-09',
      sha256: issued.sha256,
    });
    expect(JSON.stringify(verified.body)).not.toContain('Acme Freight');
    expect(JSON.stringify(verified.body)).not.toContain('acme-freight.test');
  });

  it('keeps another client and another workspace out of the PDF', async () => {
    const first = await createWorkspace();
    const acme = await createClient(first.agent, first.organizationId, 'Acme Freight', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const acmeDomain = await createDomain(first.agent, first.organizationId, acme.id, 'acme-only.test');
    await seedReport({
      domainId: acmeDomain.id,
      begin: new Date('2026-09-01T00:00:00Z'),
      records: [{ sourceIp: '203.0.113.1', messageCount: 2, dkim: 'pass', spf: 'pass' }],
    });

    const sibling = await createClient(first.agent, first.organizationId, 'Sibling Secret Ltd', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const siblingDomain = await createDomain(first.agent, first.organizationId, sibling.id, 'sibling-secret.test');

    const other = await createWorkspace('ADMIRALTY');
    const otherClient = await createClient(other.agent, other.organizationId, 'Other Tenant Ltd', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const otherDomain = await createDomain(other.agent, other.organizationId, otherClient.id, 'other-tenant.test');

    const response = await first.agent
      .post(`/api/workspaces/${first.organizationId}/clients/${acme.id}/monthly-reports`)
      .send({ period });
    expect(response.status).toBe(200);
    const text = n(extractPdfText(response.body as Buffer));

    expect(text).toContain('acme-only.test');
    expect(text).not.toContain('siblingsecret');
    expect(text).not.toContain('sibling-secret.test');
    expect(text).not.toContain('othertenant');
    expect(text).not.toContain('other-tenant.test');
    void siblingDomain;
    void otherDomain;
  });

  it('says plainly when a month had no aggregate reports', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId, 'Quiet Client', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    await createDomain(workspace.agent, workspace.organizationId, client.id, 'quiet.test');

    const response = await workspace.agent
      .post(`/api/workspaces/${workspace.organizationId}/clients/${client.id}/monthly-reports`)
      .send({ period });
    expect(response.status).toBe(200);
    const text = n(extractPdfText(response.body as Buffer));
    expect(text).toContain('noaggregatereportswerereceivedforthisclient');
    expect(text).toContain('noaggregatereportswerereceivedforthisclient\x27sdomainsinseptember2026');
    expect(text).not.toContain('0.0%');
  });

  it('attributes a report by the day its reporting period begins, not by when it arrived', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId, 'Boundary Client', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, 'boundary.test');

    await seedReport({
      domainId: domain.id,
      begin: new Date('2026-09-01T00:00:00Z'),
      records: [{ sourceIp: '203.0.113.10', messageCount: 5, dkim: 'fail', spf: 'fail' }],
    });
    await seedReport({
      domainId: domain.id,
      begin: new Date('2026-10-01T00:00:00Z'),
      records: [{ sourceIp: '203.0.113.20', messageCount: 7, dkim: 'fail', spf: 'fail' }],
    });

    const response = await workspace.agent
      .post(`/api/workspaces/${workspace.organizationId}/clients/${client.id}/monthly-reports`)
      .send({ period });
    expect(response.status).toBe(200);
    const text = n(extractPdfText(response.body as Buffer));

    expect(text).toContain('203.0.113.10');
    expect(text).not.toContain('203.0.113.20');
  });

  it('supersedes only the previous report for that month, never a compliance pack', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId, 'Supersede Client', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    await createDomain(workspace.agent, workspace.organizationId, client.id, 'supersede.test');

    const first = await workspace.agent
      .post(`/api/workspaces/${workspace.organizationId}/clients/${client.id}/monthly-reports`)
      .send({ period });
    expect(first.status).toBe(200);
    const firstReference = setHeaders(first).reference;

    const second = await workspace.agent
      .post(`/api/workspaces/${workspace.organizationId}/clients/${client.id}/monthly-reports`)
      .send({ period });
    expect(second.status).toBe(200);
    const secondReference = setHeaders(second).reference;
    expect(secondReference).not.toBe(firstReference);

    const oldVerify = await request(app)
      .get('/api/compliance-packs/verify')
      .query({ reference: firstReference });
    expect(oldVerify.status).toBe(200);
    expect(oldVerify.body.packs[0].superseded).toBe(true);

    const history = await workspace.agent.get(
      `/api/workspaces/${workspace.organizationId}/clients/${client.id}/monthly-reports`,
    );
    expect(history.body.reports).toHaveLength(2);
    expect(history.body.reports[0].reference).toBe(secondReference);
    expect(history.body.reports[0].superseded).toBe(false);
    expect(history.body.reports[1].reference).toBe(firstReference);
    expect(history.body.reports[1].superseded).toBe(true);

    const pack = await workspace.agent.post(
      `/api/workspaces/${workspace.organizationId}/clients/${client.id}/compliance-packs`,
    );
    expect([200, 201]).toContain(pack.status);

    const packList = await workspace.agent.get(
      `/api/workspaces/${workspace.organizationId}/clients/${client.id}/compliance-packs`,
    );
    expect(packList.body.packs).toHaveLength(1);
    expect(packList.body.packs[0].reference).toMatch(/^DMARC-/);

    const third = await workspace.agent
      .post(`/api/workspaces/${workspace.organizationId}/clients/${client.id}/monthly-reports`)
      .send({ period });
    expect(third.status).toBe(200);
    const packVerify = await request(app)
      .get('/api/compliance-packs/verify')
      .query({ reference: packList.body.packs[0].reference as string });
    expect(packVerify.body.packs[0].superseded).toBe(false);
  });

  it('downloads identical bytes, refuses an expired file, and refuses tampered bytes', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId, 'Download Client', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    await createDomain(workspace.agent, workspace.organizationId, client.id, 'download.test');

    const issued = await workspace.agent
      .post(`/api/workspaces/${workspace.organizationId}/clients/${client.id}/monthly-reports`)
      .send({ period });
    expect(issued.status).toBe(200);
    const issuedBytes = issued.body as Buffer;
    const reference = setHeaders(issued).reference;
    const rows = await workspace.agent.get(
      `/api/workspaces/${workspace.organizationId}/clients/${client.id}/monthly-reports`,
    );
    const row = rows.body.reports[0] as { id: string };

    const downloaded = await workspace.agent.get(
      `/api/workspaces/${workspace.organizationId}/clients/${client.id}/monthly-reports/${row.id}/download`,
    );
    expect(downloaded.status).toBe(200);
    expect((downloaded.body as Buffer).equals(issuedBytes)).toBe(true);
    expect(downloaded.headers['x-dmarc-pack-sha256']).toBe(pdfHash(issuedBytes));

    await prisma.complianceDocumentFile.update({
      where: { packId: row.id },
      data: { expiresAt: new Date('2020-01-01T00:00:00Z') },
    });
    const expired = await workspace.agent.get(
      `/api/workspaces/${workspace.organizationId}/clients/${client.id}/monthly-reports/${row.id}/download`,
    );
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('REPORT_EXPIRED');

    const stillVerifiable = await request(app)
      .get('/api/compliance-packs/verify')
      .query({ reference });
    expect(stillVerifiable.status).toBe(200);

    await prisma.complianceDocumentFile.update({
      where: { packId: row.id },
      data: { expiresAt: new Date('2099-01-01T00:00:00Z'), bytes: Buffer.from('tampered') },
    });
    const corrupt = await workspace.agent.get(
      `/api/workspaces/${workspace.organizationId}/clients/${client.id}/monthly-reports/${row.id}/download`,
    );
    expect(corrupt.status).toBe(500);
    expect(corrupt.body.error.code).toBe('REPORT_CORRUPT');
  });

  it('issues and emails a due schedule once when two runs race, and releases a failed claim', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId, 'Scheduled Client', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    await createDomain(workspace.agent, workspace.organizationId, client.id, 'scheduled.test');

    const scheduleResponse = await workspace.agent
      .put(`/api/workspaces/${workspace.organizationId}/clients/${client.id}/monthly-report-schedule`)
      .send({
        enabled: true,
        dayOfMonth: 2,
        sendHourUtc: 9,
        recipientEmails: ['Finance@Client.test', 'security@client.test', 'finance@client.test'],
      });
    expect(scheduleResponse.status).toBe(200);
    expect(scheduleResponse.body.schedule.recipientEmails).toEqual([
      'finance@client.test',
      'security@client.test',
    ]);

    const runAt = new Date('2026-10-02T10:00:00.000Z');
    const [left, right] = await Promise.all([
      runMonthlyReportSchedules(runAt),
      runMonthlyReportSchedules(runAt),
    ]);
    expect(left.issued + right.issued).toBe(1);
    await waitForEmails(2);

    const reports = await prisma.compliancePack.findMany({ where: { clientId: client.id } });
    expect(reports).toHaveLength(1);
    const emails = await prisma.emailDelivery.findMany({
      where: { idempotencyKey: { startsWith: 'monthly-report:' } },
      orderBy: { to: 'asc' },
    });
    expect(emails.map((email) => email.to)).toEqual(['finance@client.test', 'security@client.test']);
    expect(emails[0]!.idempotencyKey).toBe(
      `monthly-report:${scheduleResponse.body.schedule.id}:2026-09:finance@client.test`,
    );
    expect(emails[0]!.text).toContain('/reports/download?token=');
    expect(emails[0]!.text).toContain('September 2026');

    const stored = await prisma.monthlyReportSchedule.findUniqueOrThrow({
      where: { clientId: client.id },
    });
    expect(stored.lastIssuedPeriod).toBe('2026-09');

    // A bad recipient is refused by the API, so the failure path is seeded
    // directly: the report is created, link creation throws, and the claim is
    // released for the next run.
    const broken = await createClient(workspace.agent, workspace.organizationId, 'Broken Schedule', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    await prisma.monthlyReportSchedule.create({
      data: {
        organizationId: workspace.organizationId,
        clientId: broken.id,
        dayOfMonth: 2,
        sendHourUtc: 9,
        recipientEmails: ['not-an-email'],
      },
    });
    const failed = await runMonthlyReportSchedules(runAt);
    expect(failed.failed).toBe(1);
    const brokenSchedule = await prisma.monthlyReportSchedule.findUniqueOrThrow({
      where: { clientId: broken.id },
    });
    expect(brokenSchedule.lastIssuedPeriod).toBeNull();
    expect(await prisma.emailDelivery.count({ where: { to: 'not-an-email' } })).toBe(0);
  });

  it('skips a schedule on a plan without the entitlement', async () => {
    const workspace = await createWorkspace('FAIRWAY');
    const client = await createClient(workspace.agent, workspace.organizationId, 'Unlicensed Client', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    await prisma.monthlyReportSchedule.create({
      data: {
        organizationId: workspace.organizationId,
        clientId: client.id,
        dayOfMonth: 2,
        sendHourUtc: 9,
        recipientEmails: ['client@example.com'],
      },
    });

    const result = await runMonthlyReportSchedules(new Date('2026-10-02T10:00:00Z'));
    expect(result.claimed).toBe(0);
    const schedule = await prisma.monthlyReportSchedule.findUniqueOrThrow({ where: { clientId: client.id } });
    expect(schedule.lastIssuedPeriod).toBeNull();
    expect(await prisma.compliancePack.count({ where: { clientId: client.id } })).toBe(0);
  });

  it('reaches schedules beyond the first batch once the earlier ones are issued', async () => {
    const workspace = await createWorkspace();
    const createdAt = new Date('2025-01-01T00:00:00Z');
    // 25 schedules already issued for September, created first, then one that is not.
    for (let index = 0; index < 25; index += 1) {
      const client = await prisma.client.create({
        data: { organizationId: workspace.organizationId, name: `Done ${index}`, slug: `done-${index}-${Date.now()}`, createdAt },
      });
      await prisma.monthlyReportSchedule.create({
        data: {
          organizationId: workspace.organizationId,
          clientId: client.id,
          recipientEmails: [],
          lastIssuedPeriod: period,
          createdAt: new Date(createdAt.getTime() + index * 1000),
        },
      });
    }
    const waiting = await prisma.client.create({
      data: { organizationId: workspace.organizationId, name: 'Still Waiting', slug: `waiting-${Date.now()}`, createdAt },
    });
    await prisma.monthlyReportSchedule.create({
      data: {
        organizationId: workspace.organizationId,
        clientId: waiting.id,
        recipientEmails: [],
        createdAt: new Date(createdAt.getTime() + 60_000),
      },
    });

    const result = await runMonthlyReportSchedules(new Date('2026-10-02T10:00:00Z'));
    expect(result.issued).toBe(1);
    expect(
      (await prisma.monthlyReportSchedule.findUniqueOrThrow({ where: { clientId: waiting.id } })).lastIssuedPeriod,
    ).toBe(period);
  });

  it('detects a policy move from reports alone when no scan exists', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId, 'Report Only', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, 'report-only.test');
    const records = [{ sourceIp: '192.0.2.1', messageCount: 10, dkim: 'pass', spf: 'pass' }];
    await seedReport({ domainId: domain.id, begin: new Date('2026-09-02T00:00:00Z'), policyP: 'none', records });
    await seedReport({ domainId: domain.id, begin: new Date('2026-09-25T00:00:00Z'), policyP: 'reject', records });

    const loaded = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
      select: { id: true, name: true, createdAt: true, organizationId: true, organization: { select: { id: true, name: true } } },
    });
    const facts = await collectMonthlyFacts({
      client: loaded,
      period: parseMonthlyPeriod(period, new Date('2026-10-10T00:00:00Z'), loaded.createdAt),
      reference: 'RPT-TEST',
      issuedAt: new Date('2026-10-10T00:00:00Z'),
    });
    expect(facts.policyMoved).toBe(1);
    expect(facts.domains[0]?.policy).toBe('reject');
  });

  it('serves an emailed token, audits it, and answers every bad token identically', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId, 'Token Client', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    await createDomain(workspace.agent, workspace.organizationId, client.id, 'token.test');
    const issued = await issueMonthlyReport({
      clientId: client.id,
      organizationId: workspace.organizationId,
      period,
      recipients: ['recipient@example.com'],
    });
    // The raw token is deliberately not stored. Mint one for the endpoint test.
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const knownLink = await prisma.monthlyReportLink.create({
      data: {
        packId: issued.id,
        tokenHash,
        recipientEmail: 'other@example.com',
        expiresAt: new Date('2099-01-01T00:00:00Z'),
      },
    });

    const downloaded = await request(app).get('/api/monthly-reports/download').query({ token });
    expect(downloaded.status).toBe(200);
    expect(pdfHash(downloaded.body as Buffer)).toBe(issued.hash);
    expect(downloaded.headers['cache-control']).toBe('no-store');
    expect(downloaded.headers['referrer-policy']).toBe('no-referrer');

    const used = await prisma.monthlyReportLink.findFirstOrThrow({
      where: { tokenHash },
    });
    expect(used.useCount).toBe(1);
    expect(used.lastUsedAt).not.toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'MONTHLY_REPORT_DOWNLOADED', targetType: 'monthly_report_link' },
    });
    expect(audit.actorUserId).toBeNull();
    expect(JSON.stringify(audit.detail)).not.toContain('other@example.com');

    await prisma.monthlyReportLink.update({
      where: { id: knownLink.id },
      data: { expiresAt: new Date('2020-01-01T00:00:00Z') },
    });
    const expired = await request(app).get('/api/monthly-reports/download').query({ token });
    const unknown = await request(app).get('/api/monthly-reports/download').query({ token: 'not-a-real-token' });
    const malformed = await request(app).get('/api/monthly-reports/download');
    expect(expired.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(expired.body).toEqual(unknown.body);
    expect(malformed.body).toEqual(unknown.body);
  });

  it('lists only current reports in the portal and enforces another client boundary', async () => {
    const workspace = await createWorkspace();
    const first = await createClient(workspace.agent, workspace.organizationId, 'Portal Client A', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const second = await createClient(workspace.agent, workspace.organizationId, 'Portal Client B', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    await createDomain(workspace.agent, workspace.organizationId, first.id, 'portal-a.test');
    await createDomain(workspace.agent, workspace.organizationId, second.id, 'portal-b.test');

    const august = await issueMonthlyReport({
      clientId: first.id,
      organizationId: workspace.organizationId,
      period: '2026-08',
    });
    const septemberFirst = await issueMonthlyReport({
      clientId: first.id,
      organizationId: workspace.organizationId,
      period,
    });
    const septemberSecond = await issueMonthlyReport({
      clientId: first.id,
      organizationId: workspace.organizationId,
      period,
    });

    const contactEmail = `portal-contact-${Date.now()}@example.com`;
    await prisma.clientPortalAccess.create({
      data: {
        organizationId: workspace.organizationId,
        clientId: first.id,
        email: contactEmail,
        displayName: 'Portal Contact',
      },
    });
    const contact = request.agent(app);
    expect((await contact.post('/api/auth/sign-up/email').send({ name: 'Portal Contact', email: contactEmail, password })).status).toBe(200);
    await prisma.user.update({ where: { email: contactEmail }, data: { emailVerified: true } });
    expect((await contact.post('/api/auth/sign-in/email').send({ email: contactEmail, password })).status).toBe(200);

    const list = await contact.get(`/api/portal/clients/${first.id}/monthly-reports`);
    expect(list.status).toBe(200);
    const ids = list.body.reports.map((row: { id: string }) => row.id);
    expect(ids).toContain(august.id);
    expect(ids).toContain(septemberSecond.id);
    expect(ids).not.toContain(septemberFirst.id);

    const own = await contact.get(
      `/api/portal/clients/${first.id}/monthly-reports/${septemberSecond.id}/download`,
    );
    expect(own.status).toBe(200);

    const superseded = await contact.get(
      `/api/portal/clients/${first.id}/monthly-reports/${septemberFirst.id}/download`,
    );
    expect(superseded.status).toBe(404);

    const foreign = await contact.get(`/api/portal/clients/${second.id}/monthly-reports`);
    expect(foreign.status).toBe(404);
  });

  it('sweeps expired report files and links, and keeps the row and fingerprint', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId, 'Retention Client', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    await createDomain(workspace.agent, workspace.organizationId, client.id, 'retention-report.test');
    const issued = await issueMonthlyReport({
      clientId: client.id,
      organizationId: workspace.organizationId,
      period,
      recipients: ['retention@example.com'],
    });
    await prisma.complianceDocumentFile.update({
      where: { packId: issued.id },
      data: { expiresAt: new Date('2020-01-01T00:00:00Z') },
    });
    await prisma.monthlyReportLink.updateMany({
      where: { packId: issued.id },
      data: { expiresAt: new Date('2020-01-01T00:00:00Z') },
    });

    const swept = await purgeExpiredData(new Date());
    expect(swept.monthlyReportFiles).toBe(1);
    expect(swept.monthlyReportLinks).toBe(1);
    expect(await prisma.complianceDocumentFile.count({ where: { packId: issued.id } })).toBe(0);
    expect(await prisma.monthlyReportLink.count({ where: { packId: issued.id } })).toBe(0);
    expect(await prisma.compliancePack.findUnique({ where: { id: issued.id } })).not.toBeNull();
  });

  it('exports monthly report metadata only', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId, 'Export Client', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    await createDomain(workspace.agent, workspace.organizationId, client.id, 'export-report.test');
    const issued = await issueMonthlyReport({
      clientId: client.id,
      organizationId: workspace.organizationId,
      period,
    });

    const payload = await buildExportPayload({
      organizationId: workspace.organizationId,
      scope: 'CLIENT',
      targetId: client.id,
      format: 'JSON',
      scopeLabel: 'client',
    });
    const monthly = payload.data.monthlyReports as Array<Record<string, unknown>>;
    expect(monthly).toHaveLength(1);
    expect(monthly[0]).toMatchObject({
      reference: issued.reference,
      period,
      sha256: issued.hash,
      superseded: false,
    });
    expect(JSON.stringify(monthly)).not.toContain('bytes');
  });
});
