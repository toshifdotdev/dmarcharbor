import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanTier } from '@prisma/client';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { createApiKey } from '../src/services/api-key.service.js';
import { csvCell } from '../src/utils/csv.js';
import { grantPlan } from './helpers/plan.js';

/**
 * The monthly usage export an MSP bills its clients from.
 *
 * The figures must match the monthly client report (attributed by the start
 * of each report's period, never the day it arrived), cover every client
 * including the quiet ones, stay inside one workspace, and be safe to open in
 * a spreadsheet.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

/** The previous complete UTC month, as the export defaults to. */
function lastMonth(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return { start, end, key };
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "api_key", "idempotency_record", "entitlement_override", "subscription", "audit_log", "notification", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspace(label: string, plan: PlanTier | null = 'HARBOR') {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const created = await agent.post('/api/workspaces').send({
    name: `${label} Agency`,
    slug: `${label}-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status).toBe(201);
  const organizationId = created.body.id as string;
  if (plan) await grantPlan(organizationId, plan);
  const userId = (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
  return { agent, organizationId, userId };
}

async function client(organizationId: string, name: string) {
  fixtureId += 1;
  return prisma.client.create({
    data: { organizationId, name, slug: `c-${fixtureId}-${Date.now()}`, createdAt: new Date('2025-01-01T00:00:00Z') },
  });
}

async function domain(clientId: string, options: { createdAt?: Date; verifiedAt?: Date | null } = {}) {
  fixtureId += 1;
  return prisma.domain.create({
    data: {
      clientId,
      name: `usage-${fixtureId}-${Date.now()}.test`,
      slug: `usage-${fixtureId}-${Date.now()}`,
      status: options.verifiedAt === null ? 'PENDING' : 'VERIFIED',
      verifiedAt: options.verifiedAt === undefined ? new Date('2025-01-02T00:00:00Z') : options.verifiedAt,
      createdAt: options.createdAt ?? new Date('2025-01-02T00:00:00Z'),
    },
  });
}

async function report(domainId: string, begin: Date, records: Array<{ count: number; pass: boolean }>) {
  fixtureId += 1;
  return prisma.dmarcReport.create({
    data: {
      domainId,
      reportType: 'AGGREGATE',
      fingerprint: `usage-${fixtureId}-${Date.now()}`,
      reportingOrganization: 'Google LLC',
      dateRangeBegin: begin,
      dateRangeEnd: new Date(begin.getTime() + 24 * 60 * 60 * 1000 - 1),
      records: {
        create: records.map((record, index) => ({
          sourceIp: `203.0.113.${index + 1}`,
          messageCount: record.count,
          dkimResult: record.pass ? 'pass' : 'fail',
          spfResult: 'fail',
        })),
      },
    },
  });
}

describe('monthly usage export', () => {
  beforeEach(resetDatabase);

  it('totals each client for the month, by the start of each report period', async () => {
    const owner = await workspace('usage-totals');
    const { start, end, key } = lastMonth();
    const acme = await client(owner.organizationId, 'Acme Freight');
    const quiet = await client(owner.organizationId, 'Quiet Client');
    const acmeDomain = await domain(acme.id);
    await domain(acme.id, { verifiedAt: null });
    await domain(quiet.id);

    // In the month: 90 + 10 messages, 90 passing.
    await report(acmeDomain.id, start, [{ count: 90, pass: true }, { count: 10, pass: false }]);
    // The first instant of the next month belongs to the next month.
    await report(acmeDomain.id, end, [{ count: 500, pass: true }]);

    await prisma.dmarcForensicReport.create({
      data: {
        domainId: acmeDomain.id,
        fingerprint: `usage-forensic-${Date.now()}`,
        feedbackType: 'auth-failure',
        reportedDomain: acmeDomain.name,
        sourceIp: '198.51.100.7',
        redactionVersion: 1,
        receivedAt: new Date(start.getTime() + 60 * 60 * 1000),
        retentionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const rule = await prisma.alertRule.create({
      data: {
        organizationId: owner.organizationId,
        domainId: acmeDomain.id,
        createdById: owner.userId,
        name: 'Failure rate',
        metric: 'FAILURE_RATE',
        operator: 'GREATER_THAN',
        threshold: 5,
        windowMinutes: 1440,
      },
    });
    await prisma.alertEvent.create({
      data: {
        ruleId: rule.id,
        organizationId: owner.organizationId,
        domainId: acmeDomain.id,
        metric: 'FAILURE_RATE',
        operator: 'GREATER_THAN',
        observedValue: 10,
        threshold: 5,
        windowMinutes: 1440,
        summary: 'in month',
        triggeredAt: new Date(start.getTime() + 2 * 60 * 60 * 1000),
      },
    });

    const response = await owner.agent.get(`/api/workspaces/${owner.organizationId}/usage?format=json`);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-disposition']).toContain(`-${key}.json`);

    const body = JSON.parse(response.text);
    expect(body.period.key).toBe(key);
    expect(body.clients.map((row: { clientName: string }) => row.clientName)).toEqual(['Acme Freight', 'Quiet Client']);

    const acmeRow = body.clients[0];
    expect(acmeRow).toMatchObject({
      domains: 2,
      verifiedDomains: 1,
      activeDomains: 1,
      reports: 1,
      messages: 100,
      dmarcPassMessages: 90,
      dmarcPassPercent: 90,
      forensicReports: 1,
      alertsOpened: 1,
    });
    // A client with nothing that month still has a row, at zero.
    expect(body.clients[1]).toMatchObject({ domains: 1, activeDomains: 0, messages: 0, dmarcPassPercent: null, alertsOpened: 0 });
    expect(body.totals).toMatchObject({ domains: 3, messages: 100, dmarcPassMessages: 90, alertsOpened: 1 });

    expect(
      await prisma.auditLog.count({ where: { organizationId: owner.organizationId, action: 'EXPORT_DOWNLOADED', targetType: 'usage_export' } }),
    ).toBe(1);
  });

  it('writes a CSV with a totals row, and neutralises spreadsheet formulas', async () => {
    const owner = await workspace('usage-csv');
    await client(owner.organizationId, '=HYPERLINK("https://evil.test","Click")');

    const response = await owner.agent.get(`/api/workspaces/${owner.organizationId}/usage`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');

    const lines = response.text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'month,client,client_slug,client_id,domains,verified_domains,active_domains,aggregate_reports,messages,dmarc_pass_messages,dmarc_pass_percent,forensic_reports,alerts_opened',
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`"'=HYPERLINK(""https://evil.test"",""Click"")"`);
    expect(lines[2]).toContain('All clients');
  });

  it('counts only this workspace', async () => {
    const mine = await workspace('usage-mine');
    const theirs = await workspace('usage-theirs');
    const { start } = lastMonth();
    const theirClient = await client(theirs.organizationId, 'Someone Else');
    await report((await domain(theirClient.id)).id, start, [{ count: 1000, pass: true }]);
    await client(mine.organizationId, 'Mine');

    const body = JSON.parse((await mine.agent.get(`/api/workspaces/${mine.organizationId}/usage?format=json`)).text);
    expect(body.clients.map((row: { clientName: string }) => row.clientName)).toEqual(['Mine']);
    expect(body.totals.messages).toBe(0);

    // And a member of one workspace cannot read another's.
    expect((await mine.agent.get(`/api/workspaces/${theirs.organizationId}/usage`)).status).toBe(403);
  });

  it('refuses below Harbor, an unfinished month and a bad format', async () => {
    const fairway = await workspace('usage-fairway', 'FAIRWAY');
    const refused = await fairway.agent.get(`/api/workspaces/${fairway.organizationId}/usage`);
    expect(refused.status).toBe(402);
    expect(refused.body.error.feature).toBe('reports.usageExport');
    expect(refused.body.error.requiredIn).toBe('HARBOR');

    const harbor = await workspace('usage-periods');
    const now = new Date();
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const current = await harbor.agent.get(`/api/workspaces/${harbor.organizationId}/usage?month=${thisMonth}`);
    expect(current.status).toBe(400);
    expect(current.body.error.code).toBe('PERIOD_NOT_COMPLETE');
    expect((await harbor.agent.get(`/api/workspaces/${harbor.organizationId}/usage?month=2026-13`)).status).toBe(400);
    expect((await harbor.agent.get(`/api/workspaces/${harbor.organizationId}/usage?format=xlsx`)).status).toBe(400);
  });

  it('serves the same figures on /api/v1/usage', async () => {
    const owner = await workspace('usage-v1');
    const { start, key } = lastMonth();
    const acme = await client(owner.organizationId, 'Acme Freight');
    await report((await domain(acme.id)).id, start, [{ count: 42, pass: true }]);

    const issued = await createApiKey({
      organizationId: owner.organizationId,
      name: 'billing sync',
      scopes: ['read'],
      createdById: owner.userId,
    });
    const token = issued.key;

    const response = await request(app).get(`/api/v1/usage?month=${key}`).set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.period.key).toBe(key);
    expect(response.body.clients[0]).toMatchObject({ clientName: 'Acme Freight', messages: 42, dmarcPassMessages: 42 });
  });
});

describe('CSV cells', () => {
  it('quotes when needed and defuses formula prefixes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell(-2)).toBe('-2');
    expect(csvCell(null)).toBe('');
  });
});
