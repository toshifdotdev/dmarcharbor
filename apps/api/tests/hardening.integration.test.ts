import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { resolveRequestId } from '../src/middleware/request-context.middleware.js';
import { buildPage, resolveLimit } from '../src/utils/pagination.js';
import { errorBody } from '../src/utils/api-error.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

function aggregateReport(domain: string, reportId: string, count: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>Google LLC</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>${reportId}</report_id>
    <date_range><begin>1712188800</begin><end>1712275199</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><fraction>100</fraction>
  </policy_published>
  <record>
    <row>
      <source_ip>192.0.2.1</source_ip>
      <count>${count}</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>${domain}</header_from></identifiers>
  </record>
</feedback>`;
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup() {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `harden-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await agent.post('/api/auth/sign-up/email').send({ name: 'Harden Owner', email, password });
  expect(signUp.status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const signIn = await agent.post('/api/auth/sign-in/email').send({ email, password });
  expect(signIn.status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Harden Agency',
    slug: `harden-${Date.now()}-${fixtureId}`,
  });
  expect(workspace.status).toBe(201);

  const client = await agent.post(`/api/workspaces/${workspace.body.id}/clients`).send({
    name: 'Harden Client',
    slug: `harden-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);

  const domain = await agent.post(`/api/workspaces/${workspace.body.id}/clients/${client.body.id}/domains`).send({
    name: `harden-${fixtureId}.test`,
  });
  expect(domain.status).toBe(201);

  await prisma.domain.update({
    where: { id: domain.body.id },
    data: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      collectForensicReports: true,
      dmarcRecord: 'v=DMARC1; p=none; rua=mailto:dmarc-reports@reports.dmarcharbor.com',
    },
  });

  return {
    agent,
    organizationId: workspace.body.id as string,
    domainId: domain.body.id as string,
    domainName: `harden-${fixtureId}.test`,
  };
}

describe('pagination helpers', () => {
  it('clamps the requested page size', () => {
    expect(resolveLimit(undefined)).toBe(50);
    expect(resolveLimit(0)).toBe(1);
    expect(resolveLimit(5)).toBe(5);
    expect(resolveLimit(5_000)).toBe(200);
  });

  it('returns a cursor only when more rows remain', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    const first = buildPage(rows, 2);
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe('b');

    const last = buildPage(rows, 3);
    expect(last.hasMore).toBe(false);
    expect(last.nextCursor).toBeNull();

    const empty = buildPage([], 10);
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toBeNull();
  });
});

describe('error body helper', () => {
  it('maps status codes to machine readable codes', () => {
    expect(errorBody(400, 'bad')).toEqual({ error: { code: 'INVALID_REQUEST', message: 'bad' } });
    expect(errorBody(401, 'no').error.code).toBe('UNAUTHORIZED');
    expect(errorBody(403, 'no').error.code).toBe('FORBIDDEN');
    expect(errorBody(404, 'no').error.code).toBe('NOT_FOUND');
    expect(errorBody(409, 'no').error.code).toBe('CONFLICT');
    expect(errorBody(429, 'no').error.code).toBe('RATE_LIMITED');
    expect(errorBody(500, 'no').error.code).toBe('INTERNAL');
  });

  it('carries extra fields such as confirmation flags', () => {
    expect(errorBody(400, 'confirm', { requiresNamePurgeConfirmation: true })).toEqual({
      error: { code: 'INVALID_REQUEST', message: 'confirm', requiresNamePurgeConfirmation: true },
    });
  });
});

describe('request identifiers', () => {
  it('accepts a well formed incoming id and rejects a malformed one', () => {
    expect(resolveRequestId('abc12345')).toBe('abc12345');
    expect(resolveRequestId('has spaces')).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the request id in the response header and echoes a supplied one', async () => {
    const supplied = await request(app).get('/api/health').set('X-Request-Id', 'trace-abc-123');
    expect(supplied.headers['x-request-id']).toBe('trace-abc-123');

    const generated = await request(app).get('/api/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('unknown routes', () => {
  it('returns a structured 404 for unknown api paths', async () => {
    const response = await request(app).get('/api/definitely-not-a-route');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message).toContain('does not exist');
  });
});

describe('paginated report history', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('walks through history with a cursor without repeating or skipping rows', async () => {
    const { agent, organizationId, domainId, domainName } = await setup();

    for (let index = 0; index < 7; index += 1) {
      const created = await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({
        xml: aggregateReport(domainName, `page-${index}-${Date.now()}-${index}`, 100 + index),
      });
      expect(created.status).toBe(201);
    }

    const firstPage = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/reports?limit=3`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items).toHaveLength(3);
    expect(firstPage.body.hasMore).toBe(true);
    expect(firstPage.body.nextCursor).toBeTruthy();

    const secondPage = await agent.get(
      `/api/workspaces/${organizationId}/domains/${domainId}/reports?limit=3&cursor=${firstPage.body.nextCursor}`,
    );
    expect(secondPage.body.items).toHaveLength(3);
    expect(secondPage.body.hasMore).toBe(true);

    const thirdPage = await agent.get(
      `/api/workspaces/${organizationId}/domains/${domainId}/reports?limit=3&cursor=${secondPage.body.nextCursor}`,
    );
    expect(thirdPage.body.items).toHaveLength(1);
    expect(thirdPage.body.hasMore).toBe(false);
    expect(thirdPage.body.nextCursor).toBeNull();

    const ids = [...firstPage.body.items, ...secondPage.body.items, ...thirdPage.body.items].map(
      (report: { id: string }) => report.id,
    );
    expect(new Set(ids).size).toBe(7);
    expect(await prisma.dmarcReport.count({ where: { domainId } })).toBe(7);
  });

  it('rejects an invalid limit instead of silently defaulting', async () => {
    const { agent, organizationId, domainId } = await setup();

    const tooBig = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/reports?limit=5000`);
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error.code).toBe('INVALID_REQUEST');

    const notANumber = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/reports?limit=abc`);
    expect(notANumber.status).toBe(400);
  });
});

describe('public share rate limiting', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('limits repeated unauthenticated views of a share link', async () => {
    const { agent, organizationId, domainId } = await setup();

    const share = await agent.post(`/api/workspaces/${organizationId}/report-shares`).send({ domainId });
    expect(share.status).toBe(201);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await request(app).get(share.body.url);
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.body.error.code).toBe('RATE_LIMITED');
        break;
      }
    }

    expect(statuses).toContain(429);
    expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(30);
  });
});
