import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { grantPlan } from './helpers/plan.js';
import type { ScanResult } from '../src/models/scan.model.js';
import { setProspectScannerForTests } from '../src/services/prospect/prospect-report.service.js';

/**
 * Prospect risk reports end to end. The scanner is replaced with a recorded
 * result, so nothing here reads real DNS; everything else is the real code.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
let scanned: string[] = [];
let failScan = false;

function recordedScan(domain: string): ScanResult {
  return {
    domain,
    scannedAt: new Date().toISOString(),
    status: 'needs_attention',
    score: 41,
    scoreBreakdown: { base: 100, final: 41, factors: [] },
    dmarc: {
      status: 'found',
      record: 'v=DMARC1; p=none',
      policy: 'none',
      tags: { p: 'none' },
      hasAggregateReports: false,
      hasForensicReports: false,
      aggregateMailtoTargets: [],
      aggregateWebTargets: [],
    },
    spf: { status: 'found', record: 'v=spf1 include:_spf.google.com ~all', valid: true, lookupCount: 3 },
    dkim: { status: 'missing', selectors: [], checkedSelectors: ['google', 'selector1', 'default'], records: {} },
    mx: { status: 'found', records: [{ exchange: 'aspmx.l.google.com', priority: 1 }] },
    issues: [],
    recommendations: [],
  };
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "prospect_report", "rate_limit_bucket", "audit_log", "session", "account", "verification", "two_factor", member, invitation, "user", "organization" CASCADE',
  );
  scanned = [];
  failScan = false;
  setProspectScannerForTests(async (domain) => {
    scanned.push(domain);
    if (failScan) {
      return { ...recordedScan(domain), status: 'error', score: 0 };
    }
    return recordedScan(domain);
  });
});

afterEach(() => setProspectScannerForTests(null));

async function setup(plan: 'HARBOR' | 'FAIRWAY' | 'MOORING' = 'HARBOR') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `prospect-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Prospect Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const workspace = await agent.post('/api/workspaces').send({
    name: 'Northwind IT',
    slug: `northwind-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId, plan);
  return { agent, organizationId, email };
}

const base = (organizationId: string) => `/api/workspaces/${organizationId}/prospect-reports`;
const tokenOf = (url: string) => url.split('/prospect/')[1]!;

describe('prospect risk reports', () => {
  it('scans a domain nobody verified and serves a plain-language page from the snapshot', async () => {
    const fixture = await setup();
    const created = await fixture.agent.post(base(fixture.organizationId)).send({
      domain: 'Acme-Widgets.example.',
      prospectName: 'Acme Widgets',
      note: 'Following our call on Tuesday.',
      contactEmail: 'sales@northwind.example',
    });
    expect(created.status).toBe(201);
    expect(scanned).toEqual(['acme-widgets.example']);
    expect(created.body.report).toMatchObject({
      domain: 'acme-widgets.example',
      prospectName: 'Acme Widgets',
      score: 41,
      level: 'high',
      state: 'active',
      viewCount: 0,
    });
    expect(created.body.report.url).toMatch(/\/prospect\/[A-Za-z0-9_-]{43}$/);

    const token = tokenOf(created.body.report.url);
    const page = await request(app).get(`/api/prospect-reports/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-robots-tag']).toBe('noindex');
    expect(page.body.preparedBy.workspaceName).toBe('Northwind IT');
    // Harbor includes the agency's logo and colours, but none are saved here,
    // so none are offered.
    expect(page.body.preparedBy).toMatchObject({ branded: true, logoUrl: null, primaryColor: null });
    expect(page.body).toMatchObject({
      domain: 'acme-widgets.example',
      prospectName: 'Acme Widgets',
      note: 'Following our call on Tuesday.',
      contactEmail: 'sales@northwind.example',
    });
    expect(page.body.assessment.headline).toBe('acme-widgets.example can be impersonated by email today.');
    expect(page.body.assessment.findings[0].status).toBe('risk');
    expect(page.body.evidence.dmarcRecord).toBe('v=DMARC1; p=none');
    // Nothing internal leaks: no token, no creator, no raw scanner document.
    const text = JSON.stringify(page.body);
    expect(text).not.toContain(token);
    expect(text).not.toContain(fixture.email);
    expect(page.body.result).toBeUndefined();

    // Opening the link never scans again, and each view is counted.
    await request(app).get(`/api/prospect-reports/${token}`);
    expect(scanned).toHaveLength(1);
    const list = await fixture.agent.get(base(fixture.organizationId));
    expect(list.body.reports[0].viewCount).toBe(2);
    expect(list.body.usage).toMatchObject({ used: 1, limit: 50 });

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'PROSPECT_REPORT_CREATED' } });
    expect(audit.detail).toMatchObject({ domain: 'acme-widgets.example' });
  });

  it('answers one 404 for a revoked, expired or made-up link, and removes only what is no longer live', async () => {
    const fixture = await setup();
    const created = await fixture.agent.post(base(fixture.organizationId)).send({ domain: 'beta.example' });
    const id = created.body.report.id as string;
    const token = tokenOf(created.body.report.url);

    expect((await fixture.agent.delete(`${base(fixture.organizationId)}/${id}`)).status).toBe(409);

    expect((await fixture.agent.post(`${base(fixture.organizationId)}/${id}/revoke`)).status).toBe(204);
    const revoked = await request(app).get(`/api/prospect-reports/${token}`);
    expect(revoked.status).toBe(404);
    const madeUp = await request(app).get(`/api/prospect-reports/${'x'.repeat(43)}`);
    expect(madeUp.status).toBe(404);
    expect(madeUp.body).toEqual(revoked.body);
    expect((await request(app).get('/api/prospect-reports/short')).status).toBe(404);

    expect((await fixture.agent.delete(`${base(fixture.organizationId)}/${id}`)).status).toBe(204);
    expect(await prisma.prospectReport.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'PROSPECT_REPORT_DELETED' } })).toBe(1);

    const second = await fixture.agent.post(base(fixture.organizationId)).send({ domain: 'gamma.example' });
    await prisma.prospectReport.update({ where: { id: second.body.report.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).get(`/api/prospect-reports/${tokenOf(second.body.report.url)}`)).status).toBe(404);
    // Expired is no longer live, so it can be removed without revoking.
    expect((await fixture.agent.delete(`${base(fixture.organizationId)}/${second.body.report.id}`)).status).toBe(204);
  });

  it('refuses the free plan, and keeps list and revoke open after a downgrade', async () => {
    const free = await setup('MOORING');
    const refused = await free.agent.post(base(free.organizationId)).send({ domain: 'acme.example' });
    expect(refused.status).toBe(402);
    expect(scanned).toHaveLength(0);

    const paid = await setup();
    const created = await paid.agent.post(base(paid.organizationId)).send({ domain: 'acme.example' });
    await grantPlan(paid.organizationId, 'MOORING');
    const list = await paid.agent.get(base(paid.organizationId));
    expect(list.status).toBe(200);
    expect(list.body.usage.limit).toBe(0);
    expect((await paid.agent.post(`${base(paid.organizationId)}/${created.body.report.id}/revoke`)).status).toBe(204);
  });

  it('stops at the monthly allowance, even when the last ones are requested at once', async () => {
    const fixture = await setup('FAIRWAY');
    await prisma.prospectReport.createMany({
      data: Array.from({ length: 9 }, (_, index) => ({
        organizationId: fixture.organizationId,
        domain: `old-${index}.example`,
        token: `seeded-token-${index}-${'a'.repeat(40)}`,
        result: recordedScan(`old-${index}.example`) as unknown as object,
        score: 41,
        scannedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      })),
    });

    const results = await Promise.all([
      fixture.agent.post(base(fixture.organizationId)).send({ domain: 'one.example' }),
      fixture.agent.post(base(fixture.organizationId)).send({ domain: 'two.example' }),
      fixture.agent.post(base(fixture.organizationId)).send({ domain: 'three.example' }),
    ]);
    expect(results.filter((response) => response.status === 201)).toHaveLength(1);
    const refused = results.filter((response) => response.status === 402);
    expect(refused).toHaveLength(2);
    expect(refused[0]!.body.error).toMatchObject({ code: 'PROSPECT_LIMIT_REACHED', limit: 10, used: 10 });
    expect(await prisma.prospectReport.count({ where: { organizationId: fixture.organizationId } })).toBe(10);

    // Last month's reports do not count.
    await prisma.prospectReport.updateMany({
      where: { organizationId: fixture.organizationId },
      data: { createdAt: new Date(Date.UTC(2020, 0, 1)) },
    });
    expect((await fixture.agent.post(base(fixture.organizationId)).send({ domain: 'next.example' })).status).toBe(201);
  });

  it('saves nothing and counts nothing when the scan fails, and refuses a domain that is not one', async () => {
    const fixture = await setup();
    failScan = true;
    const failed = await fixture.agent.post(base(fixture.organizationId)).send({ domain: 'down.example' });
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('SCAN_FAILED');
    expect(await prisma.prospectReport.count()).toBe(0);

    failScan = false;
    for (const domain of ['localhost', 'not a domain', 'https://acme.example/path']) {
      const bad = await fixture.agent.post(base(fixture.organizationId)).send({ domain });
      expect(bad.status, domain).toBe(400);
    }
    const badEmail = await fixture.agent.post(base(fixture.organizationId)).send({ domain: 'acme.example', contactEmail: 'nope' });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.error.message).toContain('contact email');
    // Only the failed scan reached the scanner; no refused input did.
    expect(scanned).toEqual(['down.example']);
  });

  it('is invisible to another workspace', async () => {
    const owner = await setup();
    const stranger = await setup();
    const created = await owner.agent.post(base(owner.organizationId)).send({ domain: 'acme.example' });

    expect((await stranger.agent.get(base(owner.organizationId))).status).toBe(403);
    expect((await stranger.agent.post(`${base(owner.organizationId)}/${created.body.report.id}/revoke`)).status).toBe(403);
    // Its own workspace path, someone else's report id.
    expect((await stranger.agent.post(`${base(stranger.organizationId)}/${created.body.report.id}/revoke`)).status).toBe(404);
    expect((await stranger.agent.delete(`${base(stranger.organizationId)}/${created.body.report.id}`)).status).toBe(404);
  });
});
