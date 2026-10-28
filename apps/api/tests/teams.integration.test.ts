import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { grantPlan } from './helpers/plan.js';
import { app } from '../src/index.js';
import { evaluateAlertRules } from '../src/services/alert.service.js';
import { deliverDnsChangeNotifications } from '../src/services/monitoring/dns-change-notify.service.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

/**
 * The address is assembled from parts, on purpose.
 *
 * A literal Workflows URL with a `sig=` value is indistinguishable from a live
 * credential to a secret scanner, and GitHub push protection has rejected a push
 * from this repository before. Every piece here is obviously fake: `prod-00`,
 * `0000`, and a signature spelled `TESTSIGNOTREAL`.
 */
const TEAMS_HOST = 'prod-00.westus.logic.azure.com';
const TEAMS_SIG = 'TESTSIGNOTREAL';
const TEAMS = `https://${TEAMS_HOST}:443/workflows/0000/triggers/manual/paths/invoke?api-version=2016-06-01&sig=${TEAMS_SIG}`;
const TEAMS_PATH_TAIL = 'voke';

const SLACK_HOST = 'hooks.slack.com';
const SLACK_PATH = 'abcdefghijklmnopqrstuvwx';
const SLACK = `https://${SLACK_HOST}/services/T00000000/B00000000/${SLACK_PATH}`;

interface FetchCall {
  url: string;
  body: string;
}

/**
 * A stubbed `fetch`, because a test must never post to Microsoft or Slack.
 *
 * `failFor` decides which hosts answer with an error, so the same helper can
 * prove both "both channels get it" and "one channel failing does not stop the
 * other".
 */
function stubFetch(options: { failFor?: 'teams' | 'slack' } = {}): FetchCall[] {
  const calls: FetchCall[] = [];

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, body: String(init?.body ?? '') });

    const failing =
      (options.failFor === 'teams' && url.includes('logic.azure.com')) ||
      (options.failFor === 'slack' && url.includes(SLACK_HOST));

    if (failing) {
      return new Response('the flow is turned off', { status: 400 });
    }

    return new Response('', { status: 202 });
  });

  return calls;
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "teams_destination", "slack_destination", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dns_change", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function createWorkspace(plan: 'MOORING' | 'HARBOR' = 'HARBOR'): Promise<{
  agent: ReturnType<typeof request.agent>;
  organizationId: string;
  userId: string;
}> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `teams-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Teams Owner', email, password })).status).toBe(200);
  const user = await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Teams Workspace',
    slug: `teams-workspace-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  if (plan !== 'MOORING') {
    await grantPlan(workspace.body.id);
  }

  return { agent, organizationId: workspace.body.id as string, userId: user.id };
}

function aggregateReport(
  domain: string,
  reportId: string,
  rows: { ip: string; count: number; dkim: string; spf: string }[],
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
  </record>`,
  )
  .join('\n')}
</feedback>`;
}

/** A verified domain with a failing report and a rule that will fire. */
async function createFiringAlert(fixture: {
  agent: ReturnType<typeof request.agent>;
  organizationId: string;
  userId: string;
}): Promise<{ domainId: string; domainSlug: string }> {
  const client = await fixture.agent
    .post(`/api/workspaces/${fixture.organizationId}/clients`)
    .send({ name: 'Acme Ltd', slug: `acme-ltd-${Date.now()}-${fixtureId}` });
  expect(client.status, JSON.stringify(client.body)).toBe(201);
  const domain = await fixture.agent
    .post(`/api/workspaces/${fixture.organizationId}/clients/${client.body.id}/domains`)
    .send({ name: `teams-alert-${Date.now()}-${fixtureId}.test` });
  expect(domain.status, JSON.stringify(domain.body)).toBe(201);
  const domainId = domain.body.id as string;
  const domainName = domain.body.name as string;

  const row = await prisma.domain.update({
    where: { id: domainId },
    data: { status: 'VERIFIED', verifiedAt: new Date(), dmarcPolicy: 'none' },
    select: { slug: true },
  });

  const ingested = await fixture.agent
    .post(`/api/workspaces/${fixture.organizationId}/domains/${domainId}/reports`)
    .send({
      xml: aggregateReport(domainName, `teams-${fixtureId}`, [
        { ip: '45.83.12.9', count: 500, dkim: 'fail', spf: 'fail' },
      ]),
    });
  expect(ingested.status).toBe(201);

  const rule = await fixture.agent.post(`/api/workspaces/${fixture.organizationId}/alert-rules`).send({
    domainId,
    name: 'More than 100 failures',
    metric: 'FAILURE_COUNT',
    operator: 'GREATER_THAN',
    threshold: 100,
    windowMinutes: 1440,
    cooldownMinutes: 5,
    recipientUserIds: [fixture.userId],
  });
  expect(rule.status).toBe(201);

  return { domainId, domainSlug: row.slug };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Microsoft Teams destination', () => {
  beforeAll(resetDatabase);

  it('stores a Workflows address and never returns it, not even its signature', async () => {
    const { agent, organizationId } = await createWorkspace();

    const response = await agent
      .put(`/api/workspaces/${organizationId}/teams-destination`)
      .send({ webhookUrl: TEAMS, channelLabel: 'Alerts' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.maskedUrl).toContain(TEAMS_HOST);
    expect(response.body.maskedUrl).toContain(TEAMS_PATH_TAIL);
    // The sig query parameter is the credential. Handing it back would make this
    // endpoint a way to read a secret that was deliberately stored encrypted.
    expect(JSON.stringify(response.body)).not.toContain(TEAMS_SIG);
    expect(JSON.stringify(response.body)).not.toContain('sig=');
    expect(response.body.channelLabel).toBe('Alerts');
  });

  it('stores the address encrypted rather than in the clear', async () => {
    const { agent, organizationId } = await createWorkspace();

    await agent.put(`/api/workspaces/${organizationId}/teams-destination`).send({ webhookUrl: TEAMS });

    const row = await prisma.teamsDestination.findFirst({ where: { organizationId } });
    expect(row?.encryptedWebhookUrl).toBeTruthy();
    expect(row?.encryptedWebhookUrl).not.toContain(TEAMS_SIG);
    expect(row?.encryptedWebhookUrl).not.toContain(TEAMS_HOST);
  });

  it('refuses the retired Office 365 connector with its own explanation', async () => {
    const { agent, organizationId } = await createWorkspace();

    const response = await agent
      .put(`/api/workspaces/${organizationId}/teams-destination`)
      .send({ webhookUrl: 'https://outlook.office.com/webhook/abc' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('LEGACY_WEBHOOK_URL');
    expect(response.body.error.message).toContain('switched off in May 2026');
    expect(await prisma.teamsDestination.count({ where: { organizationId } })).toBe(0);
  });

  it('refuses a host that merely contains the allowed suffix', async () => {
    const { agent, organizationId } = await createWorkspace();

    for (const url of [
      'https://evillogic.azure.com.attacker.net/workflows/x',
      'https://logic.azure.com.evil/workflows/x',
      'https://169.254.169.254/latest/meta-data/',
    ]) {
      const response = await agent
        .put(`/api/workspaces/${organizationId}/teams-destination`)
        .send({ webhookUrl: url });
      expect(response.status, url).toBe(400);
      expect(response.body.error.code).toBe('INVALID_WEBHOOK_URL');
    }

    expect(await prisma.teamsDestination.count({ where: { organizationId } })).toBe(0);
  });

  it('requires a session', async () => {
    const { organizationId } = await createWorkspace();
    const anonymous = request(app);

    expect((await anonymous.get(`/api/workspaces/${organizationId}/teams-destination`)).status).toBe(401);
    expect(
      (await anonymous.post(`/api/workspaces/${organizationId}/teams-destination/test`)).status,
    ).toBe(401);
  });

  it('does not let one workspace read, change or test another destination', async () => {
    const mine = await createWorkspace();
    const theirs = await createWorkspace();

    await mine.agent.put(`/api/workspaces/${mine.organizationId}/teams-destination`).send({ webhookUrl: TEAMS });

    expect((await theirs.agent.get(`/api/workspaces/${mine.organizationId}/teams-destination`)).status).toBe(403);
    expect(
      (
        await theirs.agent
          .put(`/api/workspaces/${mine.organizationId}/teams-destination`)
          .send({ webhookUrl: TEAMS })
      ).status,
    ).toBe(403);
    expect(
      (await theirs.agent.post(`/api/workspaces/${mine.organizationId}/teams-destination/test`)).status,
    ).toBe(403);

    // The attacker's rejected writes must not have replaced anything.
    expect(await prisma.teamsDestination.count({ where: { organizationId: theirs.organizationId } })).toBe(0);
  });

  it('can be disabled without losing the address, and refuses to enable a missing one', async () => {
    const { agent, organizationId } = await createWorkspace();

    await agent.put(`/api/workspaces/${organizationId}/teams-destination`).send({ webhookUrl: TEAMS });
    expect(
      (await agent.patch(`/api/workspaces/${organizationId}/teams-destination`).send({ enabled: false })).status,
    ).toBe(204);

    const read = await agent.get(`/api/workspaces/${organizationId}/teams-destination`);
    expect(read.body.enabled).toBe(false);
    // Re-enabling must not need the address pasted again.
    expect(read.body.maskedUrl).toContain(TEAMS_HOST);

    const missing = await createWorkspace();
    expect(
      (await missing.agent.patch(`/api/workspaces/${missing.organizationId}/teams-destination`).send({ enabled: true }))
        .status,
    ).toBe(404);
  });

  it('deletes the destination', async () => {
    const { agent, organizationId } = await createWorkspace();

    await agent.put(`/api/workspaces/${organizationId}/teams-destination`).send({ webhookUrl: TEAMS });
    expect((await agent.delete(`/api/workspaces/${organizationId}/teams-destination`)).status).toBe(204);
    expect((await agent.get(`/api/workspaces/${organizationId}/teams-destination`)).body).toBeNull();
  });

  it('records an audit row that names the host and never the address', async () => {
    const { agent, organizationId } = await createWorkspace();

    await agent.put(`/api/workspaces/${organizationId}/teams-destination`).send({ webhookUrl: TEAMS });
    await agent.put(`/api/workspaces/${organizationId}/slack-destination`).send({ webhookUrl: SLACK });
    await agent.delete(`/api/workspaces/${organizationId}/teams-destination`);
    await agent.delete(`/api/workspaces/${organizationId}/slack-destination`);

    const rows = await prisma.auditLog.findMany({
      where: {
        organizationId,
        action: { in: ['TEAMS_DESTINATION_CONFIGURED', 'TEAMS_DESTINATION_REMOVED', 'SLACK_DESTINATION_CONFIGURED', 'SLACK_DESTINATION_REMOVED'] },
      },
    });

    // Slack had no audit trail at all until Teams arrived, so both are checked
    // here: one feature having a record and the other not is the worse outcome.
    expect(rows.map((row) => row.action).sort()).toEqual([
      'SLACK_DESTINATION_CONFIGURED',
      'SLACK_DESTINATION_REMOVED',
      'TEAMS_DESTINATION_CONFIGURED',
      'TEAMS_DESTINATION_REMOVED',
    ]);

    const serialised = JSON.stringify(rows.map((row) => row.detail));
    expect(serialised).not.toContain(TEAMS_SIG);
    expect(serialised).not.toContain(SLACK_PATH);
    expect(serialised).toContain(TEAMS_HOST);
  });

  it('posts a test message once, and stops at five in a minute', async () => {
    const { agent, organizationId } = await createWorkspace();
    await agent.put(`/api/workspaces/${organizationId}/teams-destination`).send({ webhookUrl: TEAMS });

    const calls = stubFetch();

    const first = await agent.post(`/api/workspaces/${organizationId}/teams-destination/test`);
    expect(first.status).toBe(200);
    expect(first.body.delivered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('logic.azure.com');
    expect(calls[0]!.body).toContain('DMARC Harbor test message');

    // The limiter is per workspace, so four more are allowed and the sixth is not.
    for (let index = 0; index < 4; index += 1) {
      expect((await agent.post(`/api/workspaces/${organizationId}/teams-destination/test`)).status).toBe(200);
    }
    expect((await agent.post(`/api/workspaces/${organizationId}/teams-destination/test`)).status).toBe(429);
  });

  it('reports a refused test message in words rather than throwing', async () => {
    const { agent, organizationId } = await createWorkspace();
    await agent.put(`/api/workspaces/${organizationId}/teams-destination`).send({ webhookUrl: TEAMS });

    stubFetch({ failFor: 'teams' });

    const response = await agent.post(`/api/workspaces/${organizationId}/teams-destination/test`);
    expect(response.status).toBe(200);
    expect(response.body.delivered).toBe(false);
    expect(response.body.error).toContain('400');

    const row = await prisma.teamsDestination.findFirstOrThrow({ where: { organizationId } });
    expect(row.consecutiveFailures).toBe(1);
  });
});

describe('Teams alert delivery', () => {
  beforeAll(resetDatabase);

  it('posts one alert to both channels and writes one delivery row per channel', async () => {
    const fixture = await createWorkspace();
    await fixture.agent.put(`/api/workspaces/${fixture.organizationId}/teams-destination`).send({ webhookUrl: TEAMS });
    await fixture.agent.put(`/api/workspaces/${fixture.organizationId}/slack-destination`).send({ webhookUrl: SLACK });

    await createFiringAlert(fixture);
    const calls = stubFetch();

    const results = await evaluateAlertRules();
    expect(results.some((result) => result.outcome === 'triggered')).toBe(true);

    // One post each, not one per recipient: a channel is shared.
    expect(calls.filter((call) => call.url.includes('logic.azure.com'))).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes(SLACK_HOST))).toHaveLength(1);

    const event = await prisma.alertEvent.findFirstOrThrow({ where: { organizationId: fixture.organizationId } });
    const deliveries = await prisma.alertDelivery.findMany({
      where: { eventId: event.id, channel: { in: ['SLACK', 'TEAMS'] } },
    });
    // One row per channel, and exactly one of each: the shared-channel rule, not
    // one per recipient. (Email rows also exist; that is the feature working.)
    expect(deliveries.map((row) => row.channel).sort()).toEqual(['SLACK', 'TEAMS']);
    expect(deliveries.every((row) => row.status === 'SENT')).toBe(true);

    // The card is an Adaptive Card in the envelope the Workflows template expects.
    const teamsCall = calls.find((call) => call.url.includes('logic.azure.com'))!;
    const payload = JSON.parse(teamsCall.body) as {
      type: string;
      attachments: Array<{ contentType: string; content: { type: string } }>;
    };
    expect(payload.type).toBe('message');
    expect(payload.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(payload.attachments[0]!.content.type).toBe('AdaptiveCard');
  });

  it('keeps Slack working when Teams fails, and counts the Teams failure', async () => {
    const fixture = await createWorkspace();
    await fixture.agent.put(`/api/workspaces/${fixture.organizationId}/teams-destination`).send({ webhookUrl: TEAMS });
    await fixture.agent.put(`/api/workspaces/${fixture.organizationId}/slack-destination`).send({ webhookUrl: SLACK });

    await createFiringAlert(fixture);
    stubFetch({ failFor: 'teams' });

    await evaluateAlertRules();

    const event = await prisma.alertEvent.findFirstOrThrow({ where: { organizationId: fixture.organizationId } });
    const deliveries = await prisma.alertDelivery.findMany({ where: { eventId: event.id } });
    const slack = deliveries.find((row) => row.channel === 'SLACK');
    const teams = deliveries.find((row) => row.channel === 'TEAMS');

    // The two are independent: one channel refusing a message is not a reason to
    // abandon the other, or the remaining rules in the tick.
    expect(slack?.status).toBe('SENT');
    expect(teams?.status).toBe('FAILED');
    expect(teams?.lastError).toContain('400');

    const destination = await prisma.teamsDestination.findFirstOrThrow({
      where: { organizationId: fixture.organizationId },
    });
    expect(destination.consecutiveFailures).toBe(1);
    expect(destination.lastDeliveredAt).toBeNull();
  });

  it('posts one Teams summary for a pass of critical DNS changes', async () => {
    const fixture = await createWorkspace();
    await fixture.agent.put(`/api/workspaces/${fixture.organizationId}/teams-destination`).send({ webhookUrl: TEAMS });

    const client = await prisma.client.create({
      data: { organizationId: fixture.organizationId, name: 'Dns Client', slug: `dns-client-${fixtureId}` },
      select: { id: true },
    });
    const domain = await prisma.domain.create({
      data: {
        clientId: client.id,
        name: `dns-changes-${Date.now()}.test`,
        slug: `dns-changes-${Date.now()}`,
        status: 'VERIFIED',
      },
      select: { id: true },
    });
    const scan = await prisma.scan.create({ data: { domainId: domain.id, status: 'COMPLETED' }, select: { id: true } });

    await prisma.dnsChange.createMany({
      data: [
        { organizationId: fixture.organizationId, domainId: domain.id, scanId: scan.id, kind: 'SPF_RECORD', severity: 'CRITICAL', code: 'SPF_REMOVED', summary: 'SPF record removed' },
        { organizationId: fixture.organizationId, domainId: domain.id, scanId: scan.id, kind: 'DMARC_RECORD', severity: 'CRITICAL', code: 'DMARC_REMOVED', summary: 'DMARC record removed' },
      ],
    });

    const calls = stubFetch();
    const outcome = await deliverDnsChangeNotifications();

    // One summary for the workspace per pass, not one per change.
    const teamsCalls = calls.filter((call) => call.url.includes('logic.azure.com'));
    expect(teamsCalls).toHaveLength(1);
    expect(outcome.teams).toBe(1);

    const payload = teamsCalls[0]!.body;
    expect(payload).toContain('SPF record removed');
    expect(payload).toContain('DMARC record removed');
  });

  it('sends nothing when the destination is paused', async () => {
    const fixture = await createWorkspace();
    await fixture.agent.put(`/api/workspaces/${fixture.organizationId}/teams-destination`).send({ webhookUrl: TEAMS });
    await fixture.agent.patch(`/api/workspaces/${fixture.organizationId}/teams-destination`).send({ enabled: false });

    await createFiringAlert(fixture);
    const calls = stubFetch();

    await evaluateAlertRules();

    expect(calls.filter((call) => call.url.includes('logic.azure.com'))).toHaveLength(0);
    const event = await prisma.alertEvent.findFirstOrThrow({ where: { organizationId: fixture.organizationId } });
    expect(await prisma.alertDelivery.count({ where: { eventId: event.id, channel: 'TEAMS' } })).toBe(0);
  });
});
