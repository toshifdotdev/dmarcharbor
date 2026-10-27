import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { env } from '../src/config/env.js';
import { clientAggregateAddress } from '../src/services/report-address.service.js';
import { runDomainScan } from '../src/services/domain-scan.service.js';
import { runDnsMonitorPass } from '../src/services/monitoring/dns-monitor.service.js';
import { deliverDnsChangeNotifications } from '../src/services/monitoring/dns-change-notify.service.js';
import { ingestForensicReportByReportedDomain } from '../src/services/forensic-report.service.js';
import { purgeExpiredData } from '../src/services/retention.service.js';
import { encryptSensitive } from '../src/services/privacy.service.js';
import { deliverDueWebhooks } from '../src/services/webhook.service.js';
import { grantPlan } from './helpers/plan.js';
import type { DnsReader, LookupResult, MxRecord } from '../src/scanner/types.js';
import type { HttpsGetResult, HttpsGetter } from '../src/scanner/https-get.js';

const password = 'correct-horse-battery-staple';
const forensicBoundary = 'dns-monitor-boundary';
// A fake webhook, assembled at runtime: written as one literal it matches the
// Slack webhook pattern and GitHub push protection refuses the commit.
const slackWebhook = ['https://hooks.slack.com/services', 'T00000000', 'B00000000', 'abcdefghijklmnopqrstuvwx'].join('/');
const incumbentUri = 'mailto:aggregate@ag.dmarcian.com';

let fixtureId = 0;

interface Received {
  path: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

let receiver: Server;
let receiverUrl: string;
let received: Received[] = [];

function nextId(): number {
  fixtureId += 1;
  return fixtureId;
}

function uniqueDomain(label: string): string {
  return `${label}-${Date.now()}-${nextId()}.test`;
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "dns_change", "notification", "email_delivery", "webhook_delivery", "webhook_endpoint", "slack_destination", "domain_switch", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "audit_log", "billing_event", "entitlement_override", "subscription", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

function startReceiver(): Promise<void> {
  return new Promise((resolve) => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        received.push({
          path: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          headers: req.headers as Record<string, string | string[] | undefined>,
        });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    receiver.listen(0, '127.0.0.1', () => {
      receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
      resolve();
    });
  });
}

async function createWorkspace(options: { plan?: 'HARBOR' | null } = {}): Promise<{
  agent: ReturnType<typeof request.agent>;
  organizationId: string;
  userId: string;
  email: string;
}> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `dns-monitor-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Monitor Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Monitor Agency',
    slug: `monitor-agency-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);

  const organizationId = workspace.body.id as string;
  if (options.plan !== null) {
    await grantPlan(organizationId, options.plan ?? 'HARBOR');
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { agent, organizationId, userId: user.id, email };
}

async function addMember(
  organizationId: string,
  role: 'admin' | 'viewer' | 'analyst',
): Promise<{ agent: ReturnType<typeof request.agent>; userId: string; email: string }> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `dns-member-${role}-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: `Monitor ${role}`, email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  await prisma.member.create({
    data: {
      id: randomUUID(),
      organizationId,
      userId: user.id,
      role,
      createdAt: new Date(),
    },
  });

  return { agent, userId: user.id, email };
}

async function createClient(
  agent: ReturnType<typeof request.agent>,
  organizationId: string,
  label = 'Monitor Client',
): Promise<{ id: string; name: string; reportToken: string }> {
  fixtureId += 1;
  const response = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name: `${label} ${fixtureId}`,
    slug: `${label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${fixtureId}`,
  });
  expect(response.status).toBe(201);

  const client = await prisma.client.findUniqueOrThrow({
    where: { id: response.body.id },
    select: { id: true, name: true, reportToken: true },
  });
  return client;
}

async function createDomain(
  agent: ReturnType<typeof request.agent>,
  organizationId: string,
  clientId: string,
  name: string,
  options: { verified?: boolean } = {},
): Promise<{ id: string; name: string; slug: string; verificationToken: string }> {
  const response = await agent
    .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
    .send({ name });
  expect(response.status).toBe(201);

  if (options.verified !== false) {
    await prisma.domain.update({
      where: { id: response.body.id },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    });
  }

  return response.body as { id: string; name: string; slug: string; verificationToken: string };
}

interface DnsState {
  dmarc: string | null;
  spf: string | null;
  mx?: string[];
  txt?: Record<string, string>;
  fail?: boolean;
}

function dnsState(overrides: Partial<DnsState> = {}): DnsState {
  return {
    dmarc: 'v=DMARC1; p=reject; rua=mailto:dmarc-reports@reports.dmarcharbor.com',
    spf: 'v=spf1 -all',
    ...overrides,
  };
}

function fakeReader(domain: string, state: DnsState, onTxt?: (name: string) => void): DnsReader {
  return {
    async resolveTxt(name: string): Promise<LookupResult<string[][]>> {
      onTxt?.(name);
      if (state.fail) {
        throw new Error('resolver unavailable');
      }
      if (name === `_dmarc.${domain}`) {
        return state.dmarc === null ? { status: 'missing' } : { status: 'found', value: [[state.dmarc]] };
      }
      if (name === domain) {
        return state.spf === null ? { status: 'missing' } : { status: 'found', value: [[state.spf]] };
      }
      const record = state.txt?.[name];
      return record ? { status: 'found', value: [[record]] } : { status: 'missing' };
    },
    async resolveMx(): Promise<LookupResult<MxRecord[]>> {
      if (state.fail) {
        throw new Error('resolver unavailable');
      }
      if (!state.mx || state.mx.length === 0) {
        return { status: 'missing' };
      }
      return {
        status: 'found',
        value: state.mx.map((exchange, index) => ({ exchange, priority: (index + 1) * 10 })),
      };
    },
  };
}

async function registerEndpoint(
  agent: ReturnType<typeof request.agent>,
  organizationId: string,
  events: string[],
  tag: string,
): Promise<{ id: string; secret: string }> {
  const created = await agent.post(`/api/workspaces/${organizationId}/webhooks`).send({
    name: `Receiver ${tag}`,
    url: 'https://hooks.example.com/dmarc',
    events,
  });
  expect(created.status).toBe(201);

  await prisma.webhookEndpoint.update({
    where: { id: created.body.id },
    data: { url: `${receiverUrl}?tag=${tag}` },
  });

  return { id: created.body.id as string, secret: created.body.secret as string };
}

function eventPayloads(tag: string): Array<{ type: string; data: Record<string, unknown> }> {
  return received
    .filter((entry) => entry.path.includes(`tag=${tag}`))
    .map((entry) => JSON.parse(entry.body) as { type: string; data: Record<string, unknown> });
}

const dnsEmailWhere = { idempotencyKey: { startsWith: 'dns-changes:' } } as const;

async function dnsEmailCount(): Promise<number> {
  return prisma.emailDelivery.count({ where: dnsEmailWhere });
}

async function waitForEmails(expected: number): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await dnsEmailCount()).toBe(expected);
    },
    { timeout: 5_000, interval: 25 },
  );
}

async function seedChange(input: {
  organizationId: string;
  domainId: string;
  scanId: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  summary: string;
  detectedAt?: Date;
  kind?: 'DMARC_RECORD' | 'DMARC_POLICY' | 'SPF_RECORD' | 'MX';
  code?: string;
  previousScanId?: string | null;
}): Promise<{ id: string }> {
  return prisma.dnsChange.create({
    data: {
      organizationId: input.organizationId,
      domainId: input.domainId,
      scanId: input.scanId,
      previousScanId: input.previousScanId ?? null,
      kind: input.kind ?? 'DMARC_POLICY',
      severity: input.severity,
      code: input.code ?? `seeded_${input.severity.toLowerCase()}`,
      summary: input.summary,
      before: input.severity === 'INFO' ? undefined : { p: 'reject' },
      after: input.severity === 'INFO' ? { record: 'v=DMARC1; p=reject' } : { p: 'none' },
      detectedAt: input.detectedAt ?? new Date(),
    },
    select: { id: true },
  });
}

async function seedCompletedScan(input: {
  domainId: string;
  startedAt?: Date;
  trigger?: 'MANUAL' | 'SCHEDULED';
  status?: 'COMPLETED' | 'FAILED';
}): Promise<{ id: string }> {
  const startedAt = input.startedAt ?? new Date();
  return prisma.scan.create({
    data: {
      domainId: input.domainId,
      trigger: input.trigger ?? 'SCHEDULED',
      status: input.status ?? 'COMPLETED',
      startedAt,
      completedAt: startedAt,
      score: 100,
    },
    select: { id: true },
  });
}

function forensicEmail(domain: string, messageId: string): string {
  return [
    'From: noreply-dmarc-support@google.com',
    'To: dmarc-reports@reports.dmarcharbor.com',
    `Subject: DMARC failure report for ${domain}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/report; report-type=feedback-report; boundary="${forensicBoundary}"`,
    '',
    `--${forensicBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'This is a DMARC failure report.',
    `--${forensicBoundary}`,
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.google.com',
    'Source-IP: 192.0.2.10',
    'Arrival-Date: Sat, 06 Apr 2024 12:00:01 +0000',
    '',
    'Final-Recipient: rfc822; alice@example.com',
    'Action: fail',
    'Status: 5.7.1',
    'Diagnostic-Code: smtp; 550 5.7.1 Rejected due to DMARC policy for alice@example.com',
    `--${forensicBoundary}`,
    'Content-Type: application/feedback-report',
    '',
    'Feedback-Type: feedback-report',
    'Version: 1',
    'Original-Mail-From: <attacker@spammer.test>',
    'Original-Rcpt-To: <alice@example.com>',
    'Reporting-MTA: dns; mx.google.com',
    'Source-IP: 192.0.2.10',
    `Reported-Domain: ${domain}`,
    'Authentication-Results: mx.google.com; spf=fail smtp.mailfrom=spammer.test; dkim=fail header.i=@spammer.test header.s=key1 header.d=spammer.test',
    `--${forensicBoundary}`,
    'Content-Type: text/rfc822-headers',
    '',
    'From: attacker@spammer.test',
    'To: alice@example.com',
    'Subject: Wire transfer details',
    'Date: Sat, 06 Apr 2024 11:59:00 +0000',
    `Message-ID: <${messageId}>`,
    `--${forensicBoundary}--`,
    '',
  ].join('\r\n');
}

function postSignedInbound(rawEmail: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `sha256=${createHmac('sha256', env.REPORT_INGEST_SECRET ?? '')
    .update(`${timestamp}.${rawEmail}`)
    .digest('hex')}`;

  return request(app)
    .post('/api/internal/reports/inbound')
    .set('Content-Type', 'message/rfc822')
    .set('X-DMARC-Timestamp', timestamp)
    .set('X-DMARC-Signature', signature)
    .send(rawEmail);
}

beforeAll(async () => {
  await startReceiver();
});

afterAll(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

beforeEach(async () => {
  received = [];
  await resetDatabase();
});

describe('continuous DNS monitoring', () => {
  it('records the first scan as a baseline and emits both webhooks after a real change', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('baseline'));

    await registerEndpoint(workspace.agent, workspace.organizationId, ['dns.changed', 'policy.changed'], 'sub');
    await registerEndpoint(
      workspace.agent,
      workspace.organizationId,
      ['domain.verified', 'alert.triggered'],
      'default',
    );

    const ourAddress = clientAggregateAddress(client.reportToken);
    const state = dnsState({
      dmarc: `v=DMARC1; p=reject; rua=mailto:${ourAddress}`,
    });

    const firstAt = new Date();
    const baseline = await runDnsMonitorPass(firstAt, fakeReader(domain.name, state));

    expect(baseline.claimed).toBe(1);
    expect(baseline.completed).toBe(1);
    expect(baseline.changes).toBe(0);
    expect(await prisma.dnsChange.count()).toBe(0);

    await deliverDueWebhooks();
    expect(received).toHaveLength(0);

    const baselineScan = await prisma.scan.findFirstOrThrow({
      where: { domainId: domain.id },
      orderBy: { startedAt: 'desc' },
    });
    expect(baselineScan.trigger).toBe('SCHEDULED');

    state.dmarc = `v=DMARC1; p=none; rua=mailto:${ourAddress}`;
    const secondAt = new Date(
      firstAt.getTime() + (env.DNS_MONITOR_INTERVAL_MINUTES + 1) * 60 * 1000,
    );
    const changed = await runDnsMonitorPass(secondAt, fakeReader(domain.name, state));
    await waitForEmails(1);

    expect(changed.completed).toBe(1);
    // One edit, one change: with no sp= or np= the subdomain policy only
    // inherits p, so it is not reported a second time.
    expect(changed.changes).toBe(1);

    const changes = await prisma.dnsChange.findMany({
      where: { domainId: domain.id },
      orderBy: { code: 'asc' },
    });
    expect(changes).toHaveLength(1);
    expect(changes.map((change) => change.code)).toEqual(['dmarc_policy_weakened']);
    expect(changes.every((change) => change.previousScanId === baselineScan.id)).toBe(true);
    expect(changes[0]).toMatchObject({
      kind: 'DMARC_POLICY',
      severity: 'CRITICAL',
      code: 'dmarc_policy_weakened',
    });
    expect(changes[0].before).toEqual({ p: 'reject', testing: false });
    expect(changes[0].after).toEqual({ p: 'none', testing: false });

    const latestScan = await prisma.scan.findFirstOrThrow({
      where: { domainId: domain.id },
      orderBy: { startedAt: 'desc' },
    });
    const history = await workspace.agent.get(
      `/api/workspaces/${workspace.organizationId}/domains/${domain.id}/scans`,
    );
    expect(history.status).toBe(200);
    expect(history.body.rows[0]).toMatchObject({
      id: latestScan.id,
      trigger: 'SCHEDULED',
      changeCount: 1,
    });

    await deliverDueWebhooks();
    const subscribed = eventPayloads('sub');
    expect(subscribed).toHaveLength(2);
    expect(eventPayloads('default')).toHaveLength(0);

    const dnsEvent = subscribed.find((event) => event.type === 'dns.changed');
    expect(dnsEvent).toBeTruthy();
    expect(Object.keys(dnsEvent!.data).sort()).toEqual([
      'changes',
      'domainId',
      'domainName',
      'previousScanId',
      'scanId',
      'trigger',
    ]);
    expect(dnsEvent!.data.previousScanId).toBe(baselineScan.id);
    expect(dnsEvent!.data.scanId).toBe(latestScan.id);
    expect(dnsEvent!.data.trigger).toBe('SCHEDULED');
    const eventChanges = dnsEvent!.data.changes as Array<Record<string, unknown>>;
    expect(eventChanges).toHaveLength(1);
    expect(Object.keys(eventChanges[0]!).sort()).toEqual(['code', 'id', 'kind', 'severity', 'summary']);
    expect(eventChanges.map((change) => change.code)).toEqual(['dmarc_policy_weakened']);

    const policyEvent = subscribed.find((event) => event.type === 'policy.changed');
    expect(policyEvent).toBeTruthy();
    expect(policyEvent!.data).toMatchObject({
      domainId: domain.id,
      domainName: domain.name,
      scanId: latestScan.id,
      direction: 'weakened',
    });
    expect((policyEvent!.data.from as { p: string }).p).toBe('reject');
    expect((policyEvent!.data.to as { p: string }).p).toBe('none');
  });

  it('claims each due domain once across concurrent passes and waits out the interval', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const first = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('claim-a'));
    const second = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('claim-b'));
    await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('claim-pending'), {
      verified: false,
    });

    const failed = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('claim-failed'));
    await prisma.domain.update({ where: { id: failed.id }, data: { status: 'FAILED' } });

    const now = new Date();
    const [left, right] = await Promise.all([
      runDnsMonitorPass(now, fakeReader(first.name, dnsState())),
      runDnsMonitorPass(now, fakeReader(second.name, dnsState())),
    ]);

    expect(left.claimed + right.claimed).toBe(2);
    expect(left.completed + right.completed).toBe(2);

    for (const domain of [first, second]) {
      expect(await prisma.scan.count({ where: { domainId: domain.id } })).toBe(1);
    }
    expect(await prisma.scan.count({ where: { domainId: failed.id } })).toBe(0);

    const later = new Date(now.getTime() + (env.DNS_MONITOR_INTERVAL_MINUTES + 1) * 60 * 1000);
    const again = await runDnsMonitorPass(later, fakeReader(first.name, dnsState()));
    expect(again.claimed).toBe(2);
    for (const domain of [first, second]) {
      expect(await prisma.scan.count({ where: { domainId: domain.id } })).toBe(2);
    }
  });

  it('records a change once when a manual and a scheduled scan of one domain run together', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('race'));

    const ourAddress = clientAggregateAddress(client.reportToken);
    const state = dnsState({ dmarc: `v=DMARC1; p=reject; rua=mailto:${ourAddress}` });
    await runDomainScan({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      requestedById: null,
      trigger: 'MANUAL',
      reader: fakeReader(domain.name, state),
    });

    state.dmarc = `v=DMARC1; p=none; rua=mailto:${ourAddress}`;
    const [manual, scheduledPass] = await Promise.all([
      runDomainScan({
        organizationId: workspace.organizationId,
        domainId: domain.id,
        requestedById: null,
        trigger: 'MANUAL',
        reader: fakeReader(domain.name, state),
      }),
      runDnsMonitorPass(new Date(), fakeReader(domain.name, state)),
    ]);
    await waitForEmails(1);

    expect(manual.status).toBe('completed');
    expect(scheduledPass.completed).toBe(1);
    expect(await prisma.dnsChange.count({ where: { domainId: domain.id } })).toBe(1);
    expect(
      await prisma.dnsChange.count({ where: { domainId: domain.id, code: 'dmarc_policy_weakened' } }),
    ).toBe(1);

    const triggers = await prisma.scan.findMany({
      where: { domainId: domain.id },
      select: { trigger: true },
      orderBy: { startedAt: 'asc' },
    });
    expect(triggers.map((scan) => scan.trigger).sort()).toEqual(['MANUAL', 'MANUAL', 'SCHEDULED']);
  });

  it('does not use a failed scan as the baseline', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('failed-baseline'));

    const failed = await runDomainScan({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      requestedById: null,
      trigger: 'SCHEDULED',
      reader: fakeReader(domain.name, dnsState({ fail: true })),
    });
    expect(failed.status).toBe('failed');

    const ourAddress = clientAggregateAddress(client.reportToken);
    const state = dnsState({ dmarc: `v=DMARC1; p=reject; rua=mailto:${ourAddress}` });
    const baseline = await runDomainScan({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      requestedById: null,
      trigger: 'SCHEDULED',
      reader: fakeReader(domain.name, state),
    });
    expect(baseline.status).toBe('completed');
    if (baseline.status === 'completed') {
      expect(baseline.changes).toBe(0);
    }

    state.dmarc = `v=DMARC1; p=none; rua=mailto:${ourAddress}`;
    const changed = await runDomainScan({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      requestedById: null,
      trigger: 'SCHEDULED',
      reader: fakeReader(domain.name, state),
    });
    expect(changed.status).toBe('completed');
    if (changed.status === 'completed') {
      expect(changed.changes).toBe(1);
    }

    const change = await prisma.dnsChange.findFirstOrThrow({
      where: { domainId: domain.id, code: 'dmarc_policy_weakened' },
    });
    const completedScans = await prisma.scan.findMany({
      where: { domainId: domain.id, status: 'COMPLETED' },
      orderBy: { startedAt: 'asc' },
      select: { id: true },
    });
    expect(change.previousScanId).toBe(completedScans[0]!.id);
    expect(await prisma.dnsChange.count({ where: { scan: { status: 'FAILED' } } })).toBe(0);
  });

  it('fails a scan when a removed record comes back on the confirmation read', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('confirm'));

    const ourAddress = clientAggregateAddress(client.reportToken);
    const record = `v=DMARC1; p=reject; rua=mailto:${ourAddress}`;
    await runDomainScan({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      requestedById: null,
      trigger: 'MANUAL',
      reader: fakeReader(domain.name, dnsState({ dmarc: record })),
    });

    const base = fakeReader(domain.name, dnsState({ dmarc: null }));
    let dmarcReads = 0;
    const inconsistent: DnsReader = {
      async resolveTxt(name) {
        if (name === `_dmarc.${domain.name}`) {
          dmarcReads += 1;
          if (dmarcReads > 1) {
            return { status: 'found', value: [[record]] };
          }
        }
        return base.resolveTxt(name);
      },
      resolveMx: (name) => base.resolveMx(name),
    };

    const outcome = await runDomainScan({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      requestedById: null,
      trigger: 'SCHEDULED',
      reader: inconsistent,
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toBe(
        'DNS answered inconsistently; the next scheduled check will try again',
      );
      expect(outcome.scan.status).toBe('FAILED');
    }
    expect(await prisma.dnsChange.count({ where: { domainId: domain.id } })).toBe(0);
    const stored = await prisma.domain.findUniqueOrThrow({ where: { id: domain.id } });
    expect(stored.dmarcRecord).toBe(record);
  });

  it('probes selectors a previous scan stored before it starts guessing', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('known-selector'));
    await prisma.domain.update({
      where: { id: domain.id },
      data: { dkimSelectors: ['custom-known'] },
    });

    const state = dnsState({
      txt: { [`custom-known._domainkey.${domain.name}`]: 'v=DKIM1; k=rsa; p=abc123' },
    });
    const outcome = await runDomainScan({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      requestedById: null,
      trigger: 'SCHEDULED',
      reader: fakeReader(domain.name, state),
    });

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const result = outcome.scan.result as {
        dkim: { checkedSelectors: string[]; selectors: string[] };
      };
      expect(result.dkim.checkedSelectors[0]).toBe('custom-known');
      expect(result.dkim.selectors).toContain('custom-known');
    }
    const stored = await prisma.domain.findUniqueOrThrow({ where: { id: domain.id } });
    expect(stored.dkimSelectors).toEqual(['custom-known']);
  });

  it('moves a switch row on a scheduled scan', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('switch'));
    const ourAddress = clientAggregateAddress(client.reportToken);

    await prisma.domainSwitch.create({
      data: {
        domainId: domain.id,
        organizationId: workspace.organizationId,
        status: 'PLANNED',
        incumbentVendor: 'dmarcian',
        incumbentLabel: 'Dmarcian',
        incumbentAggregateTargets: [incumbentUri],
        incumbentForensicTargets: [],
        originalRecord: `v=DMARC1; p=none; rua=${incumbentUri}`,
        plannedRecord: `v=DMARC1; p=none; rua=mailto:${ourAddress},${incumbentUri}`,
      },
    });

    const state = dnsState({ dmarc: `v=DMARC1; p=none; rua=mailto:${ourAddress}` });
    const outcome = await runDnsMonitorPass(new Date(), fakeReader(domain.name, state));

    expect(outcome.completed).toBe(1);
    const row = await prisma.domainSwitch.findUniqueOrThrow({ where: { domainId: domain.id } });
    expect(row.status).toBe('CUT_OVER');
    expect(row.cutOverAt).not.toBeNull();
    const scan = await prisma.scan.findFirstOrThrow({ where: { domainId: domain.id } });
    expect(scan.trigger).toBe('SCHEDULED');
  });

  it('pages the scan history and counts each scan changes', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('scan-history'));

    const base = Date.now() - 60 * 60 * 1000;
    const scans: Array<{ id: string }> = [];
    for (let index = 0; index < 3; index += 1) {
      scans.push(
        await seedCompletedScan({
          domainId: domain.id,
          startedAt: new Date(base + index * 60 * 1000),
          trigger: index === 2 ? 'MANUAL' : 'SCHEDULED',
        }),
      );
    }
    await seedChange({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      scanId: scans[2]!.id,
      severity: 'WARNING',
      summary: 'A change on the newest scan.',
    });

    const firstPage = await workspace.agent.get(
      `/api/workspaces/${workspace.organizationId}/domains/${domain.id}/scans?limit=2`,
    );
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.rows).toHaveLength(2);
    expect(firstPage.body.rows[0].id).toBe(scans[2]!.id);
    expect(firstPage.body.rows[0].changeCount).toBe(1);
    expect(firstPage.body.rows[1].changeCount).toBe(0);
    expect(firstPage.body.nextCursor).toBe(scans[1]!.id);

    const secondPage = await workspace.agent.get(
      `/api/workspaces/${workspace.organizationId}/domains/${domain.id}/scans?limit=2&cursor=${firstPage.body.nextCursor}`,
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.rows).toHaveLength(1);
    expect(secondPage.body.rows[0].id).toBe(scans[0]!.id);
    expect(secondPage.body.nextCursor).toBeNull();

    const tooMany = await workspace.agent.get(
      `/api/workspaces/${workspace.organizationId}/domains/${domain.id}/scans?limit=101`,
    );
    expect(tooMany.status).toBe(400);
  });
});

describe('DNS change history and acknowledgement', () => {
  async function historyFixture() {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('history'));
    const scan = await seedCompletedScan({ domainId: domain.id });
    const start = Date.now() - 60 * 60 * 1000;

    const info = await seedChange({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      scanId: scan.id,
      severity: 'INFO',
      summary: 'An informational change.',
      detectedAt: new Date(start),
    });
    const critical = await seedChange({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      scanId: scan.id,
      severity: 'CRITICAL',
      summary: 'A critical change.',
      detectedAt: new Date(start + 60_000),
    });
    const warning = await seedChange({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      scanId: scan.id,
      severity: 'WARNING',
      summary: 'A warning change.',
      detectedAt: new Date(start + 120_000),
    });

    return { workspace, client, domain, scan, info, critical, warning };
  }

  it('pages, filters, scopes and validates the change history', async () => {
    const fixture = await historyFixture();

    const firstPage = await fixture.workspace.agent.get(
      `/api/workspaces/${fixture.workspace.organizationId}/domains/${fixture.domain.id}/dns-changes?limit=2`,
    );
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.rows.map((row: { id: string }) => row.id)).toEqual([
      fixture.warning.id,
      fixture.critical.id,
    ]);
    expect(firstPage.body.nextCursor).toBe(fixture.critical.id);
    expect(firstPage.body.rows[0]).toMatchObject({
      severity: 'WARNING',
      summary: 'A warning change.',
      scanId: fixture.scan.id,
      acknowledgedAt: null,
      acknowledgedBy: null,
    });

    const tail = await fixture.workspace.agent.get(
      `/api/workspaces/${fixture.workspace.organizationId}/domains/${fixture.domain.id}/dns-changes?limit=2&cursor=${firstPage.body.nextCursor}`,
    );
    expect(tail.status).toBe(200);
    expect(tail.body.rows.map((row: { id: string }) => row.id)).toEqual([fixture.info.id]);
    expect(tail.body.nextCursor).toBeNull();

    const onlyCritical = await fixture.workspace.agent.get(
      `/api/workspaces/${fixture.workspace.organizationId}/domains/${fixture.domain.id}/dns-changes?severity=CRITICAL`,
    );
    expect(onlyCritical.status).toBe(200);
    expect(onlyCritical.body.rows.map((row: { id: string }) => row.id)).toEqual([fixture.critical.id]);

    const repeated = await fixture.workspace.agent.get(
      `/api/workspaces/${fixture.workspace.organizationId}/domains/${fixture.domain.id}/dns-changes?severity=WARNING&severity=CRITICAL`,
    );
    expect(repeated.status).toBe(200);
    expect(repeated.body.rows.map((row: { id: string }) => row.id)).toEqual([
      fixture.warning.id,
      fixture.critical.id,
    ]);

    const badSeverity = await fixture.workspace.agent.get(
      `/api/workspaces/${fixture.workspace.organizationId}/domains/${fixture.domain.id}/dns-changes?severity=URGENT`,
    );
    expect(badSeverity.status).toBe(400);

    const other = await createWorkspace();
    const foreign = await other.agent.get(
      `/api/workspaces/${other.organizationId}/domains/${fixture.domain.id}/dns-changes`,
    );
    expect(foreign.status).toBe(404);
  });

  it('acknowledges once, audits once, and enforces role and workspace boundaries', async () => {
    const fixture = await historyFixture();

    const acked = await fixture.workspace.agent.post(
      `/api/workspaces/${fixture.workspace.organizationId}/domains/${fixture.domain.id}/dns-changes/${fixture.critical.id}/acknowledge`,
    );
    expect(acked.status).toBe(200);
    expect(acked.body.acknowledgedAt).toBeTruthy();
    expect(acked.body.acknowledgedBy.id).toBe(fixture.workspace.userId);

    const audits = await prisma.auditLog.findMany({
      where: {
        organizationId: fixture.workspace.organizationId,
        action: 'DNS_CHANGE_ACKNOWLEDGED',
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      domainId: fixture.domain.id,
      targetType: 'dns_change',
      targetId: fixture.critical.id,
      actorUserId: fixture.workspace.userId,
    });

    const again = await fixture.workspace.agent.post(
      `/api/workspaces/${fixture.workspace.organizationId}/domains/${fixture.domain.id}/dns-changes/${fixture.critical.id}/acknowledge`,
    );
    expect(again.status).toBe(200);
    expect(
      await prisma.auditLog.count({
        where: {
          organizationId: fixture.workspace.organizationId,
          action: 'DNS_CHANGE_ACKNOWLEDGED',
        },
      }),
    ).toBe(1);

    const viewer = await addMember(fixture.workspace.organizationId, 'viewer');
    const denied = await viewer.agent.post(
      `/api/workspaces/${fixture.workspace.organizationId}/domains/${fixture.domain.id}/dns-changes/${fixture.warning.id}/acknowledge`,
    );
    expect(denied.status).toBe(403);

    const other = await createWorkspace();
    const crossWorkspace = await other.agent.post(
      `/api/workspaces/${other.organizationId}/domains/${fixture.domain.id}/dns-changes/${fixture.warning.id}/acknowledge`,
    );
    expect(crossWorkspace.status).toBe(404);
  });
});

describe('DNS change notifications', () => {
  function at(hour = 12): Date {
    return new Date(`2026-10-25T${String(hour).padStart(2, '0')}:00:00.000Z`);
  }

  it('sends one in-app notification per change per recipient and one email per recipient per pass', async () => {
    const workspace = await createWorkspace();
    const firstClient = await createClient(workspace.agent, workspace.organizationId, 'Notify One');
    const firstDomain = await createDomain(workspace.agent, workspace.organizationId, firstClient.id, uniqueDomain('notify-a'));
    const secondClient = await createClient(workspace.agent, workspace.organizationId, 'Notify Two');
    const secondDomain = await createDomain(workspace.agent, workspace.organizationId, secondClient.id, uniqueDomain('notify-b'));
    const admin = await addMember(workspace.organizationId, 'admin');
    const viewer = await addMember(workspace.organizationId, 'viewer');

    const firstScan = await seedCompletedScan({ domainId: firstDomain.id });
    const secondScan = await seedCompletedScan({ domainId: secondDomain.id });
    await seedChange({
      organizationId: workspace.organizationId,
      domainId: firstDomain.id,
      scanId: firstScan.id,
      severity: 'WARNING',
      summary: 'The first warning.',
    });
    await seedChange({
      organizationId: workspace.organizationId,
      domainId: firstDomain.id,
      scanId: firstScan.id,
      severity: 'CRITICAL',
      summary: 'The critical change.',
    });
    const third = await seedChange({
      organizationId: workspace.organizationId,
      domainId: secondDomain.id,
      scanId: secondScan.id,
      severity: 'WARNING',
      summary: 'The second warning.',
    });

    const outcome = await deliverDnsChangeNotifications(at());

    expect(outcome.claimed).toBe(3);
    expect(outcome.notifications).toBe(6);
    expect(outcome.emails).toBe(2);
    expect(outcome.slack).toBe(0);

    const notifications = await prisma.notification.findMany({ orderBy: { createdAt: 'asc' } });
    expect(notifications).toHaveLength(6);
    expect(notifications.every((row) => row.kind === 'DNS_CHANGE')).toBe(true);
    expect(notifications.filter((row) => row.userId === workspace.userId)).toHaveLength(3);
    expect(notifications.filter((row) => row.userId === admin.userId)).toHaveLength(3);
    expect(notifications.filter((row) => row.userId === viewer.userId)).toHaveLength(0);
    expect(notifications.every((row) => row.dnsChangeId !== null)).toBe(true);
    const criticalNotification = notifications.find((row) => row.dnsChangeId === third.id);
    expect(criticalNotification).toMatchObject({
      severity: 'WARNING',
      title: `${secondDomain.name}: DNS changed`,
      body: 'The second warning.',
      link: `/domains/${secondDomain.slug}`,
    });

    await waitForEmails(2);
    const emails = await prisma.emailDelivery.findMany({
      where: dnsEmailWhere,
      orderBy: { to: 'asc' },
    });
    expect(emails.map((email) => email.to).sort()).toEqual([admin.email, workspace.email].sort());
    for (const email of emails) {
      expect(email.subject).toContain('DNS changed on 2 domains');
      expect(email.text).toContain('The first warning.');
      expect(email.text).toContain('The critical change.');
      expect(email.text).toContain('The second warning.');
      expect(email.idempotencyKey).toMatch(/^dns-changes:/);
    }
    expect(new Set(emails.map((email) => email.idempotencyKey)).size).toBe(2);

    expect(await prisma.dnsChange.count({ where: { notifiedAt: null } })).toBe(0);
  });

  it('respects onlyHighRiskAlerts and emailAlerts without suppressing in-app history', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('prefs'));
    const admin = await addMember(workspace.organizationId, 'admin');

    await prisma.notificationPreference.create({
      data: { userId: workspace.userId, onlyHighRiskAlerts: true },
    });
    await prisma.notificationPreference.create({
      data: { userId: admin.userId, emailAlerts: false },
    });

    const scan = await seedCompletedScan({ domainId: domain.id });
    await seedChange({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      scanId: scan.id,
      severity: 'WARNING',
      summary: 'The warning summary.',
    });
    await seedChange({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      scanId: scan.id,
      severity: 'CRITICAL',
      summary: 'The critical summary.',
    });

    const outcome = await deliverDnsChangeNotifications(at());

    expect(outcome.notifications).toBe(4);
    await waitForEmails(1);
    const email = await prisma.emailDelivery.findFirstOrThrow({ where: dnsEmailWhere });
    expect(email.to).toBe(workspace.email);
    expect(email.text).toContain('The critical summary.');
    expect(email.text).not.toContain('The warning summary.');
    expect(await prisma.notification.count({ where: { userId: admin.userId } })).toBe(2);
  });

  it('respects quiet hours', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('quiet'));
    await prisma.notificationPreference.create({
      data: {
        userId: workspace.userId,
        quietHoursStart: '00:00',
        quietHoursEnd: '23:59',
        timezone: 'UTC',
      },
    });

    const scan = await seedCompletedScan({ domainId: domain.id });
    await seedChange({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      scanId: scan.id,
      severity: 'CRITICAL',
      summary: 'Quiet hours change.',
    });

    const outcome = await deliverDnsChangeNotifications(at());

    expect(outcome.notifications).toBe(1);
    expect(outcome.emails).toBe(0);
    expect(await dnsEmailCount()).toBe(0);
    expect(await prisma.notification.count()).toBe(1);
  });

  it('keeps the history on a plan without email alerts but sends nothing', async () => {
    const workspace = await createWorkspace({ plan: null });
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('mooring'));

    const scan = await seedCompletedScan({ domainId: domain.id });
    await seedChange({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      scanId: scan.id,
      severity: 'CRITICAL',
      summary: 'Mooring change.',
    });

    const outcome = await deliverDnsChangeNotifications(at());

    expect(outcome.claimed).toBe(1);
    expect(outcome.notifications).toBe(0);
    expect(outcome.emails).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    expect(await dnsEmailCount()).toBe(0);
    const stored = await prisma.dnsChange.findFirstOrThrow();
    expect(stored.notifiedAt).not.toBeNull();
    const history = await workspace.agent.get(
      `/api/workspaces/${workspace.organizationId}/domains/${domain.id}/dns-changes`,
    );
    expect(history.status).toBe(200);
    expect(history.body.rows).toHaveLength(1);
  });

  it('never notifies INFO changes', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('info'));

    const scan = await seedCompletedScan({ domainId: domain.id });
    await seedChange({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      scanId: scan.id,
      severity: 'INFO',
      summary: 'Only history.',
    });

    const outcome = await deliverDnsChangeNotifications(at());

    expect(outcome.claimed).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    expect(await dnsEmailCount()).toBe(0);
    expect((await prisma.dnsChange.findFirstOrThrow()).notifiedAt).not.toBeNull();
  });

  it('claims a workspace once when two delivery calls run together', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('concurrent-notify'));

    const scan = await seedCompletedScan({ domainId: domain.id });
    await seedChange({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      scanId: scan.id,
      severity: 'CRITICAL',
      summary: 'One delivery.',
    });

    const [left, right] = await Promise.all([
      deliverDnsChangeNotifications(at()),
      deliverDnsChangeNotifications(at()),
    ]);

    expect(left.claimed + right.claimed).toBe(1);
    expect(left.notifications + right.notifications).toBe(1);
    expect(left.emails + right.emails).toBe(1);
    expect(await prisma.notification.count()).toBe(1);
    await waitForEmails(1);
  });

  it('posts one Slack message with at most ten changes and a remainder', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('slack'));

    await prisma.slackDestination.create({
      data: {
        organizationId: workspace.organizationId,
        encryptedWebhookUrl: encryptSensitive(slackWebhook),
      },
    });

    const scan = await seedCompletedScan({ domainId: domain.id });
    for (let index = 0; index < 12; index += 1) {
      await seedChange({
        organizationId: workspace.organizationId,
        domainId: domain.id,
        scanId: scan.id,
        severity: 'WARNING',
        summary: `Slack change ${index}.`,
      });
    }

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    try {
      const outcome = await deliverDnsChangeNotifications(at());
      await waitForEmails(1);
      expect(outcome.slack).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe(slackWebhook);
      const body = JSON.parse(String((init as RequestInit).body)) as {
        text: string;
        blocks: Array<{ text: { text: string } }>;
      };
      expect(body.text).toContain('DNS changed on 1 domain(s)');
      expect(body.text).toContain('Slack change 0.');
      expect(body.text).toContain('and 2 more');
      expect(body.blocks[0]!.text.text).toContain('Slack change 9.');
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('forensic.received webhook', () => {
  it('fires once when a report is created, not for a duplicate, and leaks no PII', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('forensic-hook'));
    await prisma.domain.update({
      where: { id: domain.id },
      data: {
        collectForensicReports: true,
        dmarcRecord: 'v=DMARC1; p=reject; rua=mailto:agg@reports.dmarcharbor.com; ruf=mailto:forensics@reports.dmarcharbor.com',
      },
    });
    await registerEndpoint(workspace.agent, workspace.organizationId, ['forensic.received'], 'forensic');

    const rawEmail = forensicEmail(domain.name, 'monitor-1@spammer.test');
    const signed = await postSignedInbound(rawEmail);
    expect(signed.status).toBe(200);
    expect(signed.body.results[0].status).toBe('created');

    await deliverDueWebhooks();
    let events = eventPayloads('forensic');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('forensic.received');
    expect(Object.keys(events[0]!.data).sort()).toEqual([
      'arrivedAt',
      'domainId',
      'domainName',
      'feedbackType',
      'forensicId',
      'receivedAt',
    ]);

    const duplicate = await postSignedInbound(rawEmail);
    expect(duplicate.body.results[0].status).toBe('duplicate');
    await deliverDueWebhooks();
    expect(eventPayloads('forensic')).toHaveLength(1);

    const mailbox = await ingestForensicReportByReportedDomain(
      forensicEmail(domain.name, 'monitor-2@spammer.test'),
    );
    expect(mailbox.status).toBe('created');
    await deliverDueWebhooks();
    events = eventPayloads('forensic');
    expect(events).toHaveLength(2);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('attacker@spammer.test');
    expect(serialized).not.toContain('Wire transfer details');
  });
});

describe('scheduled scan retention', () => {
  it('keeps the thirty most recent scans, manual scans and scans with changes', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('retention'));

    const base = Date.now() - 40 * 60 * 1000;
    const scans: Array<{ id: string }> = [];
    for (let index = 0; index < 40; index += 1) {
      const manual = index === 0;
      scans.push(
        await seedCompletedScan({
          domainId: domain.id,
          startedAt: new Date(base + index * 60 * 1000),
          trigger: manual ? 'MANUAL' : 'SCHEDULED',
        }),
      );
    }

    await prisma.dnsChange.create({
      data: {
        organizationId: workspace.organizationId,
        domainId: domain.id,
        scanId: scans[1]!.id,
        kind: 'DMARC_POLICY',
        severity: 'INFO',
        code: 'seeded_retention',
        summary: 'Evidence that keeps its scan.',
        detectedAt: new Date(base),
      },
    });

    const swept = await purgeExpiredData(new Date());

    expect(swept.scheduledScans).toBe(8);
    expect(await prisma.scan.findUnique({ where: { id: scans[1]!.id } })).not.toBeNull();
    expect(await prisma.scan.findUnique({ where: { id: scans[0]!.id } })).not.toBeNull();
    expect(await prisma.scan.findUnique({ where: { id: scans[2]!.id } })).toBeNull();
    expect(await prisma.scan.findUnique({ where: { id: scans[9]!.id } })).toBeNull();
    for (const kept of scans.slice(10)) {
      expect(await prisma.scan.findUnique({ where: { id: kept.id } })).not.toBeNull();
    }
  });

  it('keeps the newest completed scan as the baseline through a long run of failures', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(workspace.agent, workspace.organizationId, client.id, uniqueDomain('baseline'));

    const base = Date.now() - 40 * 60 * 1000;
    const baseline = await seedCompletedScan({ domainId: domain.id, startedAt: new Date(base) });
    for (let index = 1; index <= 32; index += 1) {
      await seedCompletedScan({
        domainId: domain.id,
        startedAt: new Date(base + index * 60 * 1000),
        status: 'FAILED',
      });
    }

    const swept = await purgeExpiredData(new Date());

    // Two failed scans are past the thirty; the completed one is too, and stays.
    expect(swept.scheduledScans).toBe(2);
    expect(await prisma.scan.findUnique({ where: { id: baseline.id } })).not.toBeNull();
  });
});

describe('webhook event catalogue', () => {
  it('adds the three opt-in events without changing the default pair', async () => {
    const workspace = await createWorkspace();

    const listed = await workspace.agent.get(`/api/workspaces/${workspace.organizationId}/webhooks`);
    expect(listed.status).toBe(200);
    expect(listed.body.events).toEqual(
      expect.arrayContaining(['dns.changed', 'policy.changed', 'forensic.received', 'tlsrpt.received']),
    );
    expect(listed.body.defaultEvents).toEqual(['domain.verified', 'alert.triggered']);

    const created = await workspace.agent.post(`/api/workspaces/${workspace.organizationId}/webhooks`).send({
      name: 'Defaults',
      url: 'https://hooks.example.com/dmarc',
    });
    expect(created.status).toBe(201);
    expect(created.body.events).toEqual(['domain.verified', 'alert.triggered']);
  });
});

describe('MTA-STS monitoring', () => {
  it('stores, re-confirms and emits an MTA-STS removal', async () => {
    const workspace = await createWorkspace();
    const client = await createClient(workspace.agent, workspace.organizationId);
    const domain = await createDomain(
      workspace.agent,
      workspace.organizationId,
      client.id,
      uniqueDomain('mta-sts'),
    );
    await registerEndpoint(workspace.agent, workspace.organizationId, ['dns.changed'], 'mta');

    const mtaUrl = `https://mta-sts.${domain.name}/.well-known/mta-sts.txt`;
    const https: HttpsGetter = {
      async get(url): Promise<HttpsGetResult> {
        expect(url).toBe(mtaUrl);
        return {
          status: 'ok',
          statusCode: 200,
          contentType: 'text/plain',
          body: Buffer.from('version: STSv1\nmode: enforce\nmx: mx1.example.test\nmax_age: 604800\n'),
        };
      },
    };

    const state = dnsState();
    state.txt = { [`_mta-sts.${domain.name}`]: 'v=STSv1; id=abc123' };
    const first = await runDomainScan({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      requestedById: null,
      trigger: 'SCHEDULED',
      reader: fakeReader(domain.name, state),
      https,
    });
    expect(first.status).toBe('completed');

    state.txt = {};
    const second = await runDomainScan({
      organizationId: workspace.organizationId,
      domainId: domain.id,
      requestedById: null,
      trigger: 'SCHEDULED',
      reader: fakeReader(domain.name, state),
      https,
    });
    expect(second.status).toBe('completed');
    if (second.status === 'completed') {
      expect(second.changes).toBe(1);
    }

    const change = await prisma.dnsChange.findFirstOrThrow({
      where: { domainId: domain.id, code: 'mta_sts_removed' },
    });
    expect(change.kind).toBe('MTA_STS');
    expect(change.severity).toBe('WARNING');

    const stored = await prisma.scan.findUniqueOrThrow({ where: { id: change.scanId } });
    expect(stored.status).toBe('COMPLETED');

    await deliverDueWebhooks();
    const event = eventPayloads('mta').find((payload) => payload.type === 'dns.changed');
    expect(event).toBeDefined();
    expect(event?.data.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'MTA_STS', code: 'mta_sts_removed' }),
      ]),
    );
  });
});
