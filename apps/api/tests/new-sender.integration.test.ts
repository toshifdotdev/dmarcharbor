import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { buildSenderBreakdown, newSenderBlockers, possibleSpoofingSources } from '../src/services/sender-breakdown.service.js';
import { ingestDmarcReport } from '../src/services/report.service.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

function report(domain: string, reportId: string, rows: { ip: string; count: number; dkim: string; spf: string; spfDomain: string }[]) {
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
      <header_from>${row.spfDomain}</header_from>
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

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup() {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `newsender-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await agent.post('/api/auth/sign-up/email').send({ name: 'New Sender Owner', email, password });
  expect(signUp.status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({ name: 'Sender Agency', slug: `ns-${Date.now()}-${fixtureId}` });
  expect(workspace.status).toBe(201);

  const client = await agent.post(`/api/workspaces/${workspace.body.id}/clients`).send({
    name: 'New Sender Client',
    slug: `ns-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);

  const domain = await agent.post(`/api/workspaces/${workspace.body.id}/clients/${client.body.id}/domains`).send({
    name: `newsender-${fixtureId}.test`,
  });
  expect(domain.status).toBe(201);

  const domainName = `newsender-${fixtureId}.test`;
  await prisma.domain.update({
    where: { id: domain.body.id },
    data: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      dmarcPolicy: 'quarantine',
      dmarcRecord: 'v=DMARC1; p=quarantine; pct=5; rua=mailto:dmarc-reports@reports.dmarcharbor.com',
    },
  });

  return { agent, organizationId: workspace.body.id as string, domainId: domain.body.id as string, domainName };
}

async function ingest(organizationId: string, domainId: string, domainName: string, reportId: string, rows: Parameters<typeof report>[2]) {
  const outcome = await ingestDmarcReport({ organizationId, domainId, xml: report(domainName, reportId, rows) });
  expect(outcome.status).toBe('created');
}

async function backdateReports(domainId: string, days: number): Promise<void> {
  await prisma.dmarcReport.updateMany({
    where: { domainId },
    data: { receivedAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
  });
}

describe('new sending service detection', () => {
  beforeAll(resetDatabase);

  it('flags a brand new sender that passes neither SPF nor DKIM as a possible spoof', async () => {
    const { organizationId, domainId, domainName } = await setup();

    await ingest(organizationId, domainId, domainName, 'spoof-1', [
      { ip: '45.83.12.9', count: 400, dkim: 'fail', spf: 'fail', spfDomain: 'evil-lookalike.test' },
      { ip: '10.20.30.40', count: 500, dkim: 'pass', spf: 'pass', spfDomain: 'legit-esp.test' },
    ]);

    const rows = await buildSenderBreakdown(organizationId, domainId);
    const spoof = rows.find((row) => row.senderDomain === 'evil-lookalike.test');

    expect(spoof?.isNew).toBe(true);
    expect(spoof?.newSenderRisk).toBe('unauthenticated');

    const warnings = possibleSpoofingSources(rows);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].senderDomain).toBe('evil-lookalike.test');
    expect(warnings[0].sourceIps).toContain('45.83.12.9');
    expect(warnings[0].detail).toContain('spoofing');
    expect(warnings[0].detail).toContain('enforce');
  });

  it('does not flag a new sender that authenticates properly', async () => {
    const { organizationId, domainId, domainName } = await setup();

    await ingest(organizationId, domainId, domainName, 'legit-1', [
      { ip: '10.20.30.41', count: 600, dkim: 'pass', spf: 'pass', spfDomain: 'new-legit.test' },
    ]);

    const rows = await buildSenderBreakdown(organizationId, domainId);
    const sender = rows.find((row) => row.senderDomain === 'new-legit.test');

    expect(sender?.isNew).toBe(true);
    expect(sender?.newSenderRisk).toBe('authenticated');
    expect(possibleSpoofingSources(rows)).toHaveLength(0);
  });

  it('treats a sender that passes only one as partial, which blocks enforcement', async () => {
    const { organizationId, domainId, domainName } = await setup();

    await ingest(organizationId, domainId, domainName, 'partial-1', [
      { ip: '10.20.30.42', count: 300, dkim: 'pass', spf: 'fail', spfDomain: 'half-configured.test' },
    ]);

    const rows = await buildSenderBreakdown(organizationId, domainId);
    const sender = rows.find((row) => row.senderDomain === 'half-configured.test');

    expect(sender?.newSenderRisk).toBe('partially-authenticated');

    const blockers = newSenderBlockers(rows);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('half-configured.test');
    expect(blockers[0]).toContain('one of SPF or DKIM');
  });

  it('stops calling a sender new once it has history', async () => {
    const { organizationId, domainId, domainName } = await setup();

    await ingest(organizationId, domainId, domainName, 'aged-1', [
      { ip: '10.20.30.43', count: 400, dkim: 'pass', spf: 'pass', spfDomain: 'long-standing.test' },
    ]);
    await backdateReports(domainId, 30);

    const rows = await buildSenderBreakdown(organizationId, domainId);
    const sender = rows.find((row) => row.senderDomain === 'long-standing.test');

    expect(sender?.isNew).toBe(false);
    expect(sender?.newSenderRisk).toBeNull();
    expect(possibleSpoofingSources(rows)).toHaveLength(0);
    expect(newSenderBlockers(rows)).toHaveLength(0);
  });

  it('ignores an unauthenticated new sender with too little traffic to judge', async () => {
    const { organizationId, domainId, domainName } = await setup();

    await ingest(organizationId, domainId, domainName, 'tiny-1', [
      { ip: '45.83.12.10', count: 3, dkim: 'fail', spf: 'fail', spfDomain: 'tiny-spoof.test' },
    ]);

    const rows = await buildSenderBreakdown(organizationId, domainId);
    const sender = rows.find((row) => row.senderDomain === 'tiny-spoof.test');

    expect(sender?.isNew).toBe(true);
    expect(sender?.hasEnoughSignal).toBe(false);
    expect(possibleSpoofingSources(rows)).toHaveLength(0);
  });

  it('records first and last seen so a sudden new source is visible', async () => {
    const { organizationId, domainId, domainName } = await setup();

    await ingest(organizationId, domainId, domainName, 'dates-1', [
      { ip: '10.20.30.44', count: 100, dkim: 'pass', spf: 'pass', spfDomain: 'dated.test' },
    ]);

    const rows = await buildSenderBreakdown(organizationId, domainId);
    const sender = rows.find((row) => row.senderDomain === 'dated.test');

    expect(sender?.firstSeenAt).toBeTruthy();
    expect(sender?.lastSeenAt).toBeTruthy();
    expect(new Date(sender!.lastSeenAt).getTime()).toBeGreaterThanOrEqual(new Date(sender!.firstSeenAt).getTime());
  });

  it('exposes new sender findings on the senders endpoint', async () => {
    const { agent, organizationId, domainId, domainName } = await setup();

    await ingest(organizationId, domainId, domainName, 'api-1', [
      { ip: '45.83.12.11', count: 250, dkim: 'fail', spf: 'fail', spfDomain: 'api-spoof.test' },
      { ip: '10.20.30.45', count: 250, dkim: 'pass', spf: 'pass', spfDomain: 'api-legit.test' },
    ]);

    const response = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/senders`);
    expect(response.status).toBe(200);

    expect(response.body.newSenderWindowDays).toBe(7);
    expect(response.body.newSenders.length).toBe(2);
    expect(response.body.possibleSpoofingSources).toHaveLength(1);
    expect(response.body.possibleSpoofingSources[0].senderDomain).toBe('api-spoof.test');
  });

  it('reports the published pct and the next canary step in the onboarding state', async () => {
    const { agent, organizationId, domainId } = await setup();

    const response = await agent.get(`/api/workspaces/${organizationId}/domains/${domainId}/onboarding`);
    expect(response.status).toBe(200);

    expect(response.body.reporting.publishedPct).toBe(5);
    expect(response.body.rollout.recommendedPct).toBe(10);
    expect(response.body.rollout.advancing).toBe(true);

    const step = response.body.steps.find((entry: { id: string }) => entry.id === 'canary_rollout');
    expect(step).toBeTruthy();
    expect(step.status).toBe('pending');
    expect(step.detail).toContain('pct=10');
  });

  it('generates a canary record with pct and rejects a bad pct', async () => {
    const { agent, organizationId, domainId } = await setup();

    const canary = await agent.get(
      `/api/workspaces/${organizationId}/domains/${domainId}/dmarc-record?policy=quarantine&pct=5`,
    );
    expect(canary.status).toBe(200);
    expect(canary.body.value).toContain('pct=5');
    expect(canary.body.pct).toBe(5);

    const tooHigh = await agent.get(
      `/api/workspaces/${organizationId}/domains/${domainId}/dmarc-record?policy=quarantine&pct=250`,
    );
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.body.error.code).toBe('INVALID_REQUEST');

    const notANumber = await agent.get(
      `/api/workspaces/${organizationId}/domains/${domainId}/dmarc-record?policy=quarantine&pct=abc`,
    );
    expect(notANumber.status).toBe(400);
  });
});
