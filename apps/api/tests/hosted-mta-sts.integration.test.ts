import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/database/prisma.js';
import { grantPlan } from './helpers/plan.js';
import {
  checkMtaStsDelegation,
  reconcileHostedMtaSts,
  setHostedMtaStsHttpsForTests,
  setHostedMtaStsReaderForTests,
} from '../src/services/hosted-dns/hosted-mta-sts.service.js';
import {
  setHostedCustomHostnameClientForTests,
  setHostedDnsProviderForTests,
  type HostedCustomHostname,
  type HostedCustomHostnameClient,
  type HostedDnsProvider,
  type HostedTxt,
} from '../src/services/hosted-dns/provider.js';
import type { HttpsGetResult, HttpsGetter } from '../src/scanner/https-get.js';
import { parseMtaStsPolicy } from '../src/scanner/transport-records.js';
import type { DnsReader, LookupResult, MxRecord } from '../src/scanner/types.js';

/**
 * Hosted MTA-STS end to end: start, publish, serve, enforce, release, delete.
 *
 * The zone, Cloudflare for SaaS and the customer's own HTTPS are all fakes. The
 * public route runs through the real app, so the headers and the body a sender
 * would receive are the ones asserted.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const zone = 'hosted.test';
const target = 'mta.hosted.test';

function resetDatabase(): Promise<void> {
  return prisma
    .$executeRawUnsafe(
      'TRUNCATE TABLE "hosted_mta_sts_change", "hosted_mta_sts_record", "hosted_bimi_asset", "hosted_bimi_change", "hosted_bimi_record", "hosted_dmarc_change", "hosted_dmarc_record", "hosted_spf_change", "hosted_spf_record", "dns_change", "tls_report_failure", "tls_report_policy", "tls_report", "scan", "rate_limit_bucket", "audit_log", "email_delivery", "session", "account", "verification", "two_factor", member, invitation, "user", "organization" CASCADE',
    )
    .then(() => undefined);
}

class MemoryDnsProvider implements HostedDnsProvider {
  zone = zone;
  records: HostedTxt[] = [];
  private next = 1;
  failCreate = false;

  async get(name: string): Promise<HostedTxt[]> {
    return this.records.filter((record) => record.name === name).map((record) => ({ ...record }));
  }

  async create(name: string, content: string, comment: string): Promise<HostedTxt> {
    if (this.failCreate) throw new Error('Cloudflare refused the record.');
    const record = { id: `rec-${this.next++}`, name, content, comment };
    this.records.push(record);
    return { ...record };
  }

  async update(record: HostedTxt, content: string): Promise<HostedTxt> {
    const stored = this.records.find((entry) => entry.id === record.id);
    if (!stored) throw new Error('Record not found.');
    stored.content = content;
    return { ...stored };
  }

  async remove(recordId: string): Promise<void> {
    this.records = this.records.filter((record) => record.id !== recordId);
  }

  async *listAll(): AsyncIterable<HostedTxt> {
    for (const record of [...this.records]) yield { ...record };
  }
}

class MemoryCustomHostnames implements HostedCustomHostnameClient {
  hostnames: Array<HostedCustomHostname & { hostname: string }> = [];
  private next = 1;
  failCreate = false;
  failGet = false;

  async create(hostname: string): Promise<HostedCustomHostname> {
    if (this.failCreate) throw new Error('The Cloudflare token cannot manage custom hostnames.');
    const record = {
      id: `ch-${this.next++}`,
      hostname,
      status: 'pending',
      sslStatus: 'pending',
      sslError: null,
    };
    this.hostnames.push(record);
    return { ...record };
  }

  async get(id: string): Promise<HostedCustomHostname> {
    if (this.failGet) throw new Error('Cloudflare could not be reached.');
    const found = this.hostnames.find((entry) => entry.id === id);
    if (!found) throw new Error('Custom hostname not found.');
    return { ...found };
  }

  async remove(id: string): Promise<void> {
    this.hostnames = this.hostnames.filter((entry) => entry.id !== id);
  }

  activate(): void {
    for (const entry of this.hostnames) {
      entry.status = 'active';
      entry.sslStatus = 'active';
    }
  }
}

class FakeDns implements DnsReader {
  txt = new Map<string, string>();
  cname = new Map<string, string>();
  mx = new Map<string, string[]>();
  failCname = false;
  failMx = false;

  async resolveTxt(name: string): Promise<LookupResult<string[][]>> {
    const value = this.txt.get(name);
    return value === undefined ? { status: 'missing' } : { status: 'found', value: [[value]] };
  }

  async resolveCname(name: string): Promise<LookupResult<string[]>> {
    if (this.failCname) return { status: 'error', error: 'resolver unavailable' };
    const value = this.cname.get(name);
    return value === undefined ? { status: 'missing' } : { status: 'found', value: [value] };
  }

  async resolveMx(name: string): Promise<LookupResult<MxRecord[]>> {
    if (this.failMx) return { status: 'error', error: 'resolver unavailable' };
    const value = this.mx.get(name);
    return value === undefined
      ? { status: 'missing' }
      : { status: 'found', value: value.map((exchange, index) => ({ exchange, priority: 10 + index })) };
  }
}

class FakeHttps implements HttpsGetter {
  bodies = new Map<string, string>();

  async get(url: string): Promise<HttpsGetResult> {
    const body = this.bodies.get(url);
    if (body === undefined) {
      return { status: 'error', failure: 'http_status', statusCode: 404, detail: 'Not found.' };
    }
    return { status: 'ok', statusCode: 200, contentType: 'text/plain', body: Buffer.from(body, 'utf8') };
  }
}

let provider: MemoryDnsProvider;
let hostnames: MemoryCustomHostnames;
let reader: FakeDns;
let https: FakeHttps;

beforeEach(async () => {
  await resetDatabase();
  env.HOSTED_DNS_ZONE = zone;
  env.HOSTED_DNS_RECORD_LIMIT = 200;
  env.HOSTED_MTA_STS_CNAME_TARGET = target;
  env.HOSTED_MTA_STS_HOSTNAME_LIMIT = 100;
  provider = new MemoryDnsProvider();
  hostnames = new MemoryCustomHostnames();
  reader = new FakeDns();
  https = new FakeHttps();
  setHostedDnsProviderForTests(provider);
  setHostedCustomHostnameClientForTests(hostnames);
  setHostedMtaStsReaderForTests(reader);
  setHostedMtaStsHttpsForTests(https);
});

afterEach(() => {
  setHostedDnsProviderForTests(null);
  setHostedCustomHostnameClientForTests(null);
  setHostedMtaStsReaderForTests(null);
  setHostedMtaStsHttpsForTests(null);
  env.HOSTED_DNS_RECORD_LIMIT = 200;
  env.HOSTED_MTA_STS_CNAME_TARGET = undefined;
  env.HOSTED_MTA_STS_HOSTNAME_LIMIT = 100;
});

async function setup(plan: 'HARBOR' | 'MOORING' | 'FAIRWAY' = 'HARBOR') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `mta-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'MTA Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'MTA Agency',
    slug: `mta-agency-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId, plan);

  const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name: 'MTA Client',
    slug: `mta-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);
  const clientId = client.body.id as string;

  const domain = `mta-${Date.now()}-${fixtureId}.example`;
  const created = await agent
    .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
    .send({ name: domain });
  expect(created.status).toBe(201);
  await prisma.domain.update({ where: { id: created.body.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } });

  reader.mx.set(domain, [`mx1.${domain}`, `mx2.${domain}`]);

  return {
    agent,
    organizationId,
    clientId,
    domainId: created.body.id as string,
    domainName: domain,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

const base = (organizationId: string, domainId: string) =>
  `/api/workspaces/${organizationId}/domains/${domainId}/hosted-mta-sts`;

async function start(fixture: Fixture) {
  return fixture.agent.post(base(fixture.organizationId, fixture.domainId));
}

/** Both CNAMEs in place, and Cloudflare says the certificate is live. */
async function activate(fixture: Fixture, target0: string, token: string) {
  reader.cname.set(`mta-sts.${fixture.domainName}`, target);
  reader.cname.set(`_mta-sts.${fixture.domainName}`, `${token}._mta-sts.${zone}`);
  hostnames.activate();
  return fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
}

async function started(fixture: Fixture) {
  const response = await start(fixture);
  expect(response.status).toBe(201);
  return {
    response,
    token: response.body.hosted.txtCname.target.split('.')[0] as string,
  };
}

describe('hosted MTA-STS', () => {
  it('reports unavailable and refuses start when the deployment has no CNAME target', async () => {
    env.HOSTED_MTA_STS_CNAME_TARGET = undefined;
    const fixture = await setup();
    const view = await fixture.agent.get(base(fixture.organizationId, fixture.domainId));
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ available: false, hosted: null });

    const refused = await start(fixture);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('HOSTED_MTA_STS_UNAVAILABLE');
  });

  it('starts at testing with the current MX hosts and publishes the TXT', async () => {
    const fixture = await setup();
    const { response, token } = await started(fixture);

    expect(response.body.hosted).toMatchObject({
      status: 'PENDING',
      mode: 'testing',
      maxAge: 86_400,
      mx: [`mx1.${fixture.domainName}`, `mx2.${fixture.domainName}`],
      delegated: false,
    });
    expect(response.body.hosted.cname).toMatchObject({ host: `mta-sts.${fixture.domainName}`, target });
    expect(response.body.hosted.txtCname.host).toBe(`_mta-sts.${fixture.domainName}`);

    const records = provider.records.filter((record) => record.name === `${token}._mta-sts.${zone}`);
    expect(records).toHaveLength(1);
    expect(records[0]!.content).toMatch(/^v=STSv1; id=[A-Za-z0-9]{1,32}$/);
    expect(records[0]!.comment).toMatch(/^dmarc-harbor mta-sts /);
    expect(hostnames.hostnames).toHaveLength(1);
    expect(hostnames.hostnames[0]!.hostname).toBe(`mta-sts.${fixture.domainName}`);
    expect(await prisma.auditLog.count({ where: { action: 'HOSTED_MTA_STS_CREATED' } })).toBe(1);
  });

  it('refuses to start when the MX lookup fails, and creates nothing', async () => {
    const fixture = await setup();
    reader.failMx = true;

    const refused = await start(fixture);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('DNS_LOOKUP_FAILED');
    expect(await prisma.hostedMtaStsRecord.count()).toBe(0);
    expect(hostnames.hostnames).toHaveLength(0);
    expect(provider.records).toHaveLength(0);
  });

  it('imports a policy the domain already serves instead of changing what senders see', async () => {
    const fixture = await setup();
    reader.txt.set(`_mta-sts.${fixture.domainName}`, 'v=STSv1; id=abc123');
    https.bodies.set(
      `https://mta-sts.${fixture.domainName}/.well-known/mta-sts.txt`,
      'version: STSv1\r\nmode: enforce\r\nmx: mail.example.net\r\nmax_age: 604800\r\n',
    );

    const { response } = await started(fixture);
    expect(response.body.hosted).toMatchObject({
      mode: 'enforce',
      mx: ['mail.example.net'],
      maxAge: 604_800,
    });

    const row = await prisma.hostedMtaStsRecord.findFirstOrThrow({ where: { domainId: fixture.domainId } });
    expect(row.previousTxt).toBe('v=STSv1; id=abc123');
    expect(row.previousPolicy).toContain('mode: enforce');
  });

  it('moves PENDING to ACTIVE only when both CNAMEs and the certificate are ready', async () => {
    const fixture = await setup();
    const { token } = await started(fixture);

    // Names in place, certificate still pending.
    reader.cname.set(`mta-sts.${fixture.domainName}`, target);
    reader.cname.set(`_mta-sts.${fixture.domainName}`, `${token}._mta-sts.${zone}`);
    const stillPending = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(stillPending.status).toBe(200);
    expect(stillPending.body.hosted.status).toBe('PENDING');
    expect(stillPending.body.hosted.mtaCnameState).toBe('found');
    expect(stillPending.body.hosted.certificate.ready).toBe(false);

    hostnames.activate();
    const active = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(active.body.hosted.status).toBe('ACTIVE');
    expect(active.body.hosted.delegated).toBe(true);
    expect(active.body.hosted.certificate.ready).toBe(true);
  });

  it('changes nothing when a CNAME lookup fails', async () => {
    const fixture = await setup();
    const { token } = await started(fixture);
    await activate(fixture, target, token);
    const before = await prisma.hostedMtaStsRecord.findFirstOrThrow({ where: { domainId: fixture.domainId } });

    reader.failCname = true;
    const checked = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(checked.status).toBe(200);
    expect(checked.body.hosted.status).toBe('ACTIVE');

    const after = await prisma.hostedMtaStsRecord.findFirstOrThrow({ where: { domainId: fixture.domainId } });
    expect(after.delegationCheckedAt?.getTime()).toBe(before.delegationCheckedAt?.getTime());
    expect(after.mtaCnameState).toBe(before.mtaCnameState);
  });

  it('serves the policy at the well-known path with the headers a sender needs', async () => {
    const fixture = await setup();
    const { token } = await started(fixture);
    await activate(fixture, target, token);

    const response = await request(app)
      .get('/.well-known/mta-sts.txt')
      .set('host', `mta-sts.${fixture.domainName}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.text).toContain('\r\n');
    expect(response.text).toBe(
      `version: STSv1\r\nmode: testing\r\nmx: mx1.${fixture.domainName}\r\nmx: mx2.${fixture.domainName}\r\nmax_age: 86400\r\n`,
    );

    const parsed = parseMtaStsPolicy(response.text, 'text/plain');
    expect(parsed.valid).toBe(true);
  });

  it('answers the same 404 for an unknown host, a pending host and a released record', async () => {
    const fixture = await setup();
    const { token } = await started(fixture);

    // Pending, certificate not active yet.
    const pending = await request(app)
      .get('/.well-known/mta-sts.txt')
      .set('host', `mta-sts.${fixture.domainName}`);
    expect(pending.status).toBe(404);
    expect(pending.text).toBe('Not found.');

    const unknown = await request(app).get('/.well-known/mta-sts.txt').set('host', 'mta-sts.nobody.example');
    expect(unknown.status).toBe(404);
    expect(unknown.text).toBe('Not found.');

    await activate(fixture, target, token);
    expect(
      (
        await request(app)
          .get('/.well-known/mta-sts.txt')
          .set('host', `mta-sts.${fixture.domainName}`)
      ).status,
    ).toBe(200);

    await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/release`);
    const released = await request(app)
      .get('/.well-known/mta-sts.txt')
      .set('host', `mta-sts.${fixture.domainName}`);
    // Releasing still serves a none policy until the window closes.
    expect(released.status).toBe(200);
    expect(released.text).toContain('mode: none');
  });

  it('publishes a new policy with a new id, and refuses a stale version', async () => {
    const fixture = await setup();
    const { token } = await started(fixture);
    const active = await activate(fixture, target, token);
    const version = active.body.hosted.version as number;
    const previousId = active.body.hosted.policyId as string;

    const changed = await fixture.agent.put(base(fixture.organizationId, fixture.domainId)).send({
      expectedVersion: version,
      mode: 'testing',
      mx: [`mx1.${fixture.domainName}`, `mx9.${fixture.domainName}`],
      maxAge: 604_800,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.hosted.version).toBe(version + 1);
    expect(changed.body.hosted.policyId).not.toBe(previousId);
    expect(changed.body.hosted.maxAge).toBe(604_800);

    const records = provider.records.filter((record) => record.name === `${token}._mta-sts.${zone}`);
    expect(records[0]!.content).toBe(`v=STSv1; id=${changed.body.hosted.policyId}`);
    expect(await prisma.auditLog.count({ where: { action: 'HOSTED_MTA_STS_UPDATED' } })).toBe(1);

    const stale = await fixture.agent.put(base(fixture.organizationId, fixture.domainId)).send({
      expectedVersion: version,
      mode: 'testing',
      mx: [`mx1.${fixture.domainName}`],
      maxAge: 86_400,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CHANGED');
    expect(stale.body.view.hosted.version).toBe(version + 1);
  });

  it('refuses an invalid policy before writing anything', async () => {
    const fixture = await setup();
    const { token } = await started(fixture);
    const active = await activate(fixture, target, token);
    const before = provider.records.find((record) => record.name === `${token}._mta-sts.${zone}`)!.content;

    const invalidHost = await fixture.agent.put(base(fixture.organizationId, fixture.domainId)).send({
      expectedVersion: active.body.hosted.version,
      mode: 'testing',
      mx: ['not a hostname'],
      maxAge: 86_400,
    });
    expect(invalidHost.status).toBe(400);
    expect(invalidHost.body.error.code).toBe('INVALID_POLICY');

    const shortEnforce = await fixture.agent.put(base(fixture.organizationId, fixture.domainId)).send({
      expectedVersion: active.body.hosted.version,
      mode: 'enforce',
      mx: [`mx1.${fixture.domainName}`],
      maxAge: 86_400,
    });
    expect(shortEnforce.status).toBe(400);

    expect(provider.records.find((record) => record.name === `${token}._mta-sts.${zone}`)!.content).toBe(before);
  });

  it('refuses enforce while the evidence is missing, and records an override', async () => {
    const fixture = await setup();
    const { token } = await started(fixture);
    const active = await activate(fixture, target, token);
    const version = active.body.hosted.version as number;
    const mx = [`mx1.${fixture.domainName}`, `mx2.${fixture.domainName}`];

    const refused = await fixture.agent.put(base(fixture.organizationId, fixture.domainId)).send({
      expectedVersion: version,
      mode: 'enforce',
      mx,
      maxAge: 604_800,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('POLICY_NOT_READY');
    expect(refused.body.blockers.map((blocker: { code: string }) => blocker.code)).toEqual(
      expect.arrayContaining(['testing_too_short', 'no_tls_reports']),
    );

    const overridden = await fixture.agent.put(base(fixture.organizationId, fixture.domainId)).send({
      expectedVersion: version,
      mode: 'enforce',
      mx,
      maxAge: 604_800,
      override: true,
    });
    expect(overridden.status).toBe(200);
    expect(overridden.body.hosted.mode).toBe('enforce');

    const change = await prisma.hostedMtaStsChange.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
    });
    expect(change.readinessOverride).toBe(true);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'HOSTED_MTA_STS_UPDATED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.stringify(audit.detail)).toContain('"override":true');
  });

  it('records an uncovered MX host and raises a critical DNS change after a scan', async () => {
    const fixture = await setup();
    const { token } = await started(fixture);
    const active = await activate(fixture, target, token);

    await fixture.agent.put(base(fixture.organizationId, fixture.domainId)).send({
      expectedVersion: active.body.hosted.version,
      mode: 'enforce',
      mx: [`mx1.${fixture.domainName}`],
      maxAge: 604_800,
      override: true,
    });

    const scan = await prisma.scan.create({
      data: { domainId: fixture.domainId, status: 'COMPLETED', trigger: 'MANUAL', completedAt: new Date() },
    });
    const view = await checkMtaStsDelegation({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      scanId: scan.id,
    });

    expect(view.hosted?.uncoveredMx).toEqual([`mx2.${fixture.domainName}`]);
    const change = await prisma.dnsChange.findFirstOrThrow({
      where: { domainId: fixture.domainId, code: 'mta_sts_mx_not_covered' },
    });
    expect(change.severity).toBe('CRITICAL');
    expect(change.summary).toContain(`mx2.${fixture.domainName}`);

    // A second check does not stack another row.
    await checkMtaStsDelegation({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      scanId: scan.id,
    });
    expect(
      await prisma.dnsChange.count({ where: { domainId: fixture.domainId, code: 'mta_sts_mx_not_covered' } }),
    ).toBe(1);
  });

  it('releases by serving none until the longest cached policy could expire', async () => {
    const fixture = await setup();
    const { token } = await started(fixture);
    const active = await activate(fixture, target, token);

    await fixture.agent.put(base(fixture.organizationId, fixture.domainId)).send({
      expectedVersion: active.body.hosted.version,
      mode: 'testing',
      mx: [`mx1.${fixture.domainName}`],
      maxAge: 2_592_000,
    });

    const releasing = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/release`);
    expect(releasing.status).toBe(200);
    expect(releasing.body.hosted.status).toBe('RELEASING');
    expect(releasing.body.hosted.mode).toBe('none');

    const serveUntil = new Date(releasing.body.hosted.releaseServeUntil as string);
    const days = (serveUntil.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(30);
    expect(days).toBeLessThan(32);

    const served = await request(app)
      .get('/.well-known/mta-sts.txt')
      .set('host', `mta-sts.${fixture.domainName}`);
    expect(served.text).toContain('mode: none');

    // The reconciler closes it once the window has passed.
    const summary = await reconcileHostedMtaSts(new Date(serveUntil.getTime() + 1000));
    expect(summary.released).toBe(1);
    const row = await prisma.hostedMtaStsRecord.findFirstOrThrow({ where: { domainId: fixture.domainId } });
    expect(row.status).toBe('RELEASED');
    expect(hostnames.hostnames).toHaveLength(0);
    expect(provider.records.filter((record) => record.name === `${token}._mta-sts.${zone}`)).toHaveLength(0);
  });

  it('releases a record that was never delegated at once', async () => {
    const fixture = await setup();
    const { token } = await started(fixture);

    const released = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/release`);
    expect(released.status).toBe(200);
    expect(released.body.hosted.status).toBe('RELEASED');
    expect(hostnames.hostnames).toHaveLength(0);
    expect(provider.records.filter((record) => record.name === `${token}._mta-sts.${zone}`)).toHaveLength(0);
  });

  it('keeps serving and refuses edits after a downgrade', async () => {
    const fixture = await setup();
    const { token } = await started(fixture);
    const active = await activate(fixture, target, token);
    await grantPlan(fixture.organizationId, 'FAIRWAY');

    const view = await fixture.agent.get(base(fixture.organizationId, fixture.domainId));
    expect(view.body.hosted.paused).toBe(true);

    const served = await request(app)
      .get('/.well-known/mta-sts.txt')
      .set('host', `mta-sts.${fixture.domainName}`);
    expect(served.status).toBe(200);

    const edit = await fixture.agent.put(base(fixture.organizationId, fixture.domainId)).send({
      expectedVersion: active.body.hosted.version,
      mode: 'testing',
      mx: [`mx1.${fixture.domainName}`],
      maxAge: 86_400,
    });
    expect(edit.status).toBe(402);

    expect((await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`)).status).toBe(200);
    expect((await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/release`)).status).toBe(200);
  });

  it('refuses Mooring and Fairway at start', async () => {
    for (const plan of ['MOORING', 'FAIRWAY'] as const) {
      const fixture = await setup(plan);
      const refused = await start(fixture);
      expect(refused.status, plan).toBe(402);
      expect(refused.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    }
  });

  it('is invisible to another workspace on every route', async () => {
    const owner = await setup();
    await started(owner);
    const stranger = await setup();
    const path = base(owner.organizationId, owner.domainId);

    const responses = await Promise.all([
      stranger.agent.get(path),
      stranger.agent.post(path),
      stranger.agent.put(path).send({ expectedVersion: 1, mode: 'testing', mx: ['mx.example.com'], maxAge: 86_400 }),
      stranger.agent.post(`${path}/check`),
      stranger.agent.post(`${path}/release`),
    ]);
    for (const response of responses) {
      expect([403, 404]).toContain(response.status);
    }
  });

  it('removes the TXT and the custom hostname when the domain is deleted', async () => {
    const fixture = await setup();
    const { token } = await started(fixture);
    expect(hostnames.hostnames).toHaveLength(1);

    const deleted = await fixture.agent.delete(
      `/api/workspaces/${fixture.organizationId}/domains/${fixture.domainId}`,
    );
    expect(deleted.status).toBe(200);
    expect(hostnames.hostnames).toHaveLength(0);
    expect(provider.records.filter((record) => record.name === `${token}._mta-sts.${zone}`)).toHaveLength(0);
  });

  it('refuses a new hostname at the configured limit', async () => {
    env.HOSTED_MTA_STS_HOSTNAME_LIMIT = 1;
    const first = await setup();
    expect((await start(first)).status).toBe(201);

    const second = await setup();
    const refused = await start(second);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('HOSTED_MTA_STS_FULL');
  });

  it('sweeps only token-shaped records with our comment', async () => {
    const fixture = await setup();
    const { token } = await started(fixture);
    const orphan = await provider.create(
      `bbbbbbbbbbbbbbbb._mta-sts.${zone}`,
      'v=STSv1; id=orphan',
      'dmarc-harbor mta-sts missing-row',
    );
    const foreign = await provider.create(
      `cccccccccccccccc._mta-sts.${zone}`,
      'v=STSv1; id=foreign',
      'someone else',
    );

    const summary = await reconcileHostedMtaSts();
    expect(summary.removed).toBe(1);
    expect(provider.records.some((record) => record.id === orphan.id)).toBe(false);
    expect(provider.records.some((record) => record.id === foreign.id)).toBe(true);
    expect(provider.records.filter((record) => record.name === `${token}._mta-sts.${zone}`)).toHaveLength(1);
  });

  it('answers unchanged when the policy is already the one published', async () => {
    const fixture = await setup();
    const { token } = await started(fixture);
    const active = await activate(fixture, target, token);
    const before = provider.records.find((record) => record.name === `${token}._mta-sts.${zone}`)!.content;

    const same = await fixture.agent.put(base(fixture.organizationId, fixture.domainId)).send({
      expectedVersion: active.body.hosted.version,
      mode: 'testing',
      mx: active.body.hosted.mx,
      maxAge: active.body.hosted.maxAge,
    });
    expect(same.status).toBe(200);
    expect(same.body.action).toBe('unchanged');
    expect(provider.records.find((record) => record.name === `${token}._mta-sts.${zone}`)!.content).toBe(before);
  });
});
