import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

function aggregateReport(domain: string, reportId: string): string {
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
  <record>
    <row>
      <source_ip>192.0.2.10</source_ip>
      <count>1250</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>${domain}</header_from>
      <envelope_from>${domain}</envelope_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>${domain}</domain>
        <selector>google</selector>
        <result>pass</result>
      </dkim>
      <spf>
        <domain>${domain}</domain>
        <scope>mfrom</scope>
        <result>pass</result>
      </spf>
    </auth_results>
  </record>
</feedback>`;
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE');
}

async function createVerifiedDomain(domainName: string): Promise<{
  agent: ReturnType<typeof request.agent>;
  organizationId: string;
  domainId: string;
}> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `reports-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await agent.post('/api/auth/sign-up/email').send({
    name: 'Report Owner',
    email,
    password,
  });
  expect(signUp.status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const signIn = await agent.post('/api/auth/sign-in/email').send({ email, password });
  expect(signIn.status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Report Operations',
    slug: `report-operations-${Date.now()}-${fixtureId}`,
  });
  expect(workspace.status).toBe(201);

  const client = await agent.post(`/api/workspaces/${workspace.body.id}/clients`).send({
    name: 'Report Client',
    slug: `report-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);

  const domain = await agent.post(`/api/workspaces/${workspace.body.id}/clients/${client.body.id}/domains`).send({
    name: domainName,
  });
  expect(domain.status).toBe(201);
  await prisma.domain.update({
    where: { id: domain.body.id },
    data: { status: 'VERIFIED', verifiedAt: new Date() },
  });

  return {
    agent,
    organizationId: workspace.body.id as string,
    domainId: domain.body.id as string,
  };
}

describe('DMARC report ingestion', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('ingests, deduplicates, lists, and returns an aggregate report', async () => {
    const { agent, organizationId, domainId } = await createVerifiedDomain('reports.test');
    const xml = aggregateReport('reports.test', `report-${Date.now()}`);

    const ingested = await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({ xml });

    expect(ingested.status).toBe(201);
    expect(ingested.body.duplicate).toBe(false);
    expect(ingested.body.report.reportType).toBe('AGGREGATE');
    expect(ingested.body.report.policyDomain).toBe('reports.test');
    expect(ingested.body.report.records).toHaveLength(1);
    expect(ingested.body.report.records[0].messageCount).toBe(1250);
    expect(ingested.body.report.records[0].authResults).toHaveLength(2);

    const duplicate = await agent.post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`).send({ xml });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);
    expect(duplicate.body.report.id).toBe(ingested.body.report.id);

    const history = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/reports`);
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(1);

    const detail = await agent.get(`/api/workspaces/${organizationId}/reports/${ingested.body.report.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.reportId).toContain('report-');
    expect(detail.body.domain.name).toBe('reports.test');
  });

  it('rejects a report for a different domain', async () => {
    const { agent, organizationId, domainId } = await createVerifiedDomain('owner.test');

    const response = await agent
      .post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`)
      .send({ xml: aggregateReport('other.test', 'mismatch-report') });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('other.test');
  });

  it('rejects invalid report XML', async () => {
    const { agent, organizationId, domainId } = await createVerifiedDomain('invalid.test');

    const response = await agent
      .post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`)
      .send({ xml: '<feedback>' });

    expect(response.status).toBe(400);
  });

  it('requires report ingest permission', async () => {
    const { agent, organizationId, domainId } = await createVerifiedDomain('permission.test');
    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'analyst' } });

    const response = await agent
      .post(`/api/workspaces/${organizationId}/domains/${domainId}/reports`)
      .send({ xml: aggregateReport('permission.test', 'permission-report') });

    expect(response.status).toBe(403);
  });
});
