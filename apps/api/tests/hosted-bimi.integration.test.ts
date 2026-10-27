import request from 'supertest';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/database/prisma.js';
import { grantPlan } from './helpers/plan.js';
import { certificateFor } from './helpers/certificate.js';
import { reconcileHostedBimi } from '../src/services/hosted-dns/hosted-bimi.service.js';
import { setHostedBimiReaderForTests } from '../src/services/hosted-dns/hosted-bimi.service.js';
import { usedHostedRecords } from '../src/services/hosted-dns/hosted-dmarc.service.js';
import {
  setHostedDnsProviderForTests,
  type HostedDnsProvider,
  type HostedTxt,
} from '../src/services/hosted-dns/provider.js';
import type { DnsReader, LookupResult, MxRecord } from '../src/scanner/types.js';

/**
 * Hosted BIMI end to end: start, upload, publish, serve, replace, release,
 * downgrade, delete.
 *
 * The zone is an in-memory provider and DNS is a fake reader, exactly as in
 * hosted-dmarc.integration.test.ts. The public route is exercised through the
 * real app, so the headers and the uniform 404 are the ones a mailbox provider
 * would receive.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const zone = 'hosted.test';
const origin = 'https://bimi.test';

/** Passes all seven checks `inspectBimiSvg` makes. */
const validSvg = (label: string): Buffer =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 64 64"><title>${label}</title><rect width="64" height="64" fill="#101010"/></svg>`,
    'utf8',
  );

function resetDatabase(): Promise<void> {
  return prisma
    .$executeRawUnsafe(
      'TRUNCATE TABLE "hosted_bimi_asset", "hosted_bimi_change", "hosted_bimi_record", "hosted_dmarc_change", "hosted_dmarc_record", "hosted_spf_change", "hosted_spf_record", "rate_limit_bucket", "audit_log", "email_delivery", "session", "account", "verification", "two_factor", member, invitation, "user", "organization" CASCADE',
    )
    .then(() => undefined);
}

class MemoryDnsProvider implements HostedDnsProvider {
  zone = zone;
  records: HostedTxt[] = [];
  private next = 1;
  failCreate = false;
  failUpdate = false;

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
    if (this.failUpdate) throw new Error('Cloudflare refused the change.');
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

class FakeDns implements DnsReader {
  cname = new Map<string, string>();
  failCname = false;
  cnameCalls = 0;

  async resolveTxt(): Promise<LookupResult<string[][]>> {
    return { status: 'missing' };
  }

  async resolveCname(name: string): Promise<LookupResult<string[]>> {
    this.cnameCalls += 1;
    if (this.failCname) return { status: 'error', error: 'resolver unavailable' };
    const value = this.cname.get(name);
    return value === undefined ? { status: 'missing' } : { status: 'found', value: [value] };
  }

  async resolveMx(): Promise<LookupResult<MxRecord[]>> {
    return { status: 'found', value: [{ exchange: 'mx.example.test', priority: 10 }] };
  }
}

let provider: MemoryDnsProvider;
let reader: FakeDns;

beforeEach(async () => {
  await resetDatabase();
  env.HOSTED_DNS_ZONE = zone;
  env.HOSTED_DNS_RECORD_LIMIT = 200;
  env.HOSTED_BIMI_ORIGIN = origin;
  provider = new MemoryDnsProvider();
  reader = new FakeDns();
  setHostedDnsProviderForTests(provider);
  setHostedBimiReaderForTests(reader);
});

afterEach(() => {
  setHostedDnsProviderForTests(null);
  setHostedBimiReaderForTests(null);
  env.HOSTED_DNS_RECORD_LIMIT = 200;
  env.HOSTED_BIMI_ORIGIN = undefined;
});

async function setup(plan: 'HARBOR' | 'MOORING' | 'FAIRWAY' = 'HARBOR') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `bimi-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'BIMI Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'BIMI Agency',
    slug: `bimi-agency-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId, plan);

  const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name: 'BIMI Client',
    slug: `bimi-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);
  const clientId = client.body.id as string;

  const domain = `bimi-${Date.now()}-${fixtureId}.example`;
  const created = await agent
    .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
    .send({ name: domain });
  expect(created.status).toBe(201);
  await prisma.domain.update({ where: { id: created.body.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } });

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
  `/api/workspaces/${organizationId}/domains/${domainId}/hosted-bimi`;

async function start(fixture: Fixture) {
  return fixture.agent.post(base(fixture.organizationId, fixture.domainId));
}

async function uploadLogo(fixture: Fixture, bytes: Buffer) {
  return fixture.agent
    .put(`${base(fixture.organizationId, fixture.domainId)}/logo`)
    .set('content-type', 'image/svg+xml')
    .send(bytes);
}

async function startedWithLogo(fixture: Fixture) {
  const started = await start(fixture);
  expect(started.status).toBe(201);
  const uploaded = await uploadLogo(fixture, validSvg('Example'));
  expect(uploaded.status).toBe(200);
  return { started, uploaded, token: started.body.hosted.cname.target.split('.')[0] as string };
}

function sha12(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

/**
 * A GET that keeps the response as bytes.
 *
 * superagent has no parser for image/svg+xml, so without this the body arrives
 * as an empty object and a byte comparison would pass against anything.
 */
function getBytes(path: string) {
  return request(app)
    .get(path)
    .buffer(true)
    .parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });
}

describe('hosted BIMI', () => {
  it('reports unavailable and refuses start when the deployment has no BIMI origin', async () => {
    env.HOSTED_BIMI_ORIGIN = undefined;
    const fixture = await setup();
    const view = await fixture.agent.get(base(fixture.organizationId, fixture.domainId));
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ available: false, hosted: null });

    const refused = await start(fixture);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('HOSTED_BIMI_UNAVAILABLE');
  });

  it('starts a record with no TXT until a logo exists', async () => {
    const fixture = await setup();
    const response = await start(fixture);

    expect(response.status).toBe(201);
    expect(response.body.hosted).toMatchObject({
      status: 'PENDING',
      value: null,
      logo: null,
      certificate: null,
    });
    expect(response.body.hosted.cname.host).toBe(`default._bimi.${fixture.domainName}`);
    expect(response.body.hosted.cname.target).toMatch(/^[a-z2-7]{16}\.bimi\.hosted\.test$/);
    expect(provider.records).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { action: 'HOSTED_BIMI_CREATED' } })).toBe(1);
  });

  it('publishes the TXT with the logo URL once a valid SVG is uploaded', async () => {
    const fixture = await setup();
    const { token } = await startedWithLogo(fixture);

    const records = provider.records.filter((record) => record.name === `${token}.bimi.${zone}`);
    expect(records).toHaveLength(1);
    expect(records[0]!.content).toBe(
      `v=BIMI1; l=${origin}/bimi/${token}/${sha12(validSvg('Example'))}.svg; a=`,
    );
    expect(records[0]!.comment).toMatch(/^dmarc-harbor bimi /);

    const view = await fixture.agent.get(base(fixture.organizationId, fixture.domainId));
    expect(view.body.hosted.logo.sha256).toHaveLength(64);
    expect(view.body.hosted.logo.url).toBe(`${origin}/bimi/${token}/${sha12(validSvg('Example'))}.svg`);
    expect(view.body.hosted.changes.map((change: { reason: string }) => change.reason)).toContain('logo');
  });

  it('refuses an SVG that fails the checks and names every failure', async () => {
    const fixture = await setup();
    expect((await start(fixture)).status).toBe(201);

    const refused = await uploadLogo(fixture, Buffer.from('<svg><script>x</script></svg>', 'utf8'));
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BIMI_LOGO_INVALID');
    expect(refused.body.error.failed).toEqual(
      expect.arrayContaining(['baseProfile="tiny-ps"', 'version="1.2"', 'Non-empty title']),
    );
    expect(await prisma.hostedBimiAsset.count()).toBe(0);
  });

  it('refuses a document with an ENTITY declaration', async () => {
    const fixture = await setup();
    expect((await start(fixture)).status).toBe(201);

    const refused = await uploadLogo(
      fixture,
      Buffer.from(
        '<!DOCTYPE svg [<!ENTITY x "y">]><svg version="1.2" baseProfile="tiny-ps"><title>t</title></svg>',
        'utf8',
      ),
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BIMI_LOGO_INVALID');
    expect(refused.body.error.failed).toContain('No DOCTYPE or ENTITY declarations');
  });

  it('answers unchanged for the same bytes, with no new asset and no history row', async () => {
    const fixture = await setup();
    await startedWithLogo(fixture);
    const before = await prisma.hostedBimiChange.count();

    const again = await uploadLogo(fixture, validSvg('Example'));
    expect(again.status).toBe(200);
    expect(again.body.action).toBe('unchanged');
    expect(await prisma.hostedBimiAsset.count()).toBe(1);
    expect(await prisma.hostedBimiChange.count()).toBe(before);
  });

  it('serves the exact bytes with every required header, and HEAD works', async () => {
    const fixture = await setup();
    const { token } = await startedWithLogo(fixture);
    const path = `/bimi/${token}/${sha12(validSvg('Example'))}.svg`;

    const response = await getBytes(path);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/svg+xml');
    expect(response.headers['content-length']).toBe(String(validSvg('Example').length));
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(response.headers['cache-control']).toBe('public, max-age=3600');
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(Buffer.compare(response.body as Buffer, validSvg('Example'))).toBe(0);

    const head = await request(app).head(path);
    expect(head.status).toBe(200);
    expect(head.headers['content-type']).toBe('image/svg+xml');
    expect(head.headers['content-length']).toBe(String(validSvg('Example').length));
  });

  it('answers the same 404 for an unknown hash, an unknown token and a released record', async () => {
    const fixture = await setup();
    const { token } = await startedWithLogo(fixture);

    const unknownHash = await request(app).get(`/bimi/${token}/0123456789ab.svg`);
    expect(unknownHash.status).toBe(404);
    expect(unknownHash.text).toBe('Not found.');

    const unknownToken = await request(app).get(`/bimi/aaaaaaaaaaaaaaaa/${sha12(validSvg('Example'))}.svg`);
    expect(unknownToken.status).toBe(404);
    expect(unknownToken.text).toBe('Not found.');

    const wrongExtension = await request(app).get(`/bimi/${token}/${sha12(validSvg('Example'))}.png`);
    expect(wrongExtension.status).toBe(404);

    expect(
      (await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/release`).send({ removeNow: true }))
        .status,
    ).toBe(200);
    const released = await request(app).get(`/bimi/${token}/${sha12(validSvg('Example'))}.svg`);
    expect(released.status).toBe(404);
    expect(released.text).toBe('Not found.');
  });

  it('keeps the replaced logo URL servable and retires it', async () => {
    const fixture = await setup();
    const { token } = await startedWithLogo(fixture);
    const firstPath = `/bimi/${token}/${sha12(validSvg('Example'))}.svg`;

    const replacement = await uploadLogo(fixture, validSvg('Replacement'));
    expect(replacement.status).toBe(200);
    expect(replacement.body.action).toBe('updated');
    expect(replacement.body.hosted.logo.sha256).toBe(
      createHash('sha256').update(validSvg('Replacement')).digest('hex'),
    );

    const old = await getBytes(firstPath);
    expect(old.status).toBe(200);
    expect(Buffer.compare(old.body as Buffer, validSvg('Example'))).toBe(0);

    const retired = await prisma.hostedBimiAsset.findFirstOrThrow({
      where: { sha256: createHash('sha256').update(validSvg('Example')).digest('hex') },
    });
    expect(retired.retiredAt).not.toBeNull();

    const records = provider.records.filter((record) => record.name === `${token}.bimi.${zone}`);
    expect(records).toHaveLength(1);
    expect(records[0]!.content).toContain(`${sha12(validSvg('Replacement'))}.svg`);
  });

  it('does not change status when the CNAME lookup errors', async () => {
    const fixture = await setup();
    const { token } = await startedWithLogo(fixture);
    reader.cname.set(`default._bimi.${fixture.domainName}`, `${token}.bimi.${zone}`);

    const active = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(active.status).toBe(200);
    expect(active.body.hosted.status).toBe('ACTIVE');
    const checkedAt = active.body.hosted.delegationCheckedAt;

    reader.failCname = true;
    const failed = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(failed.status).toBe(200);
    expect(failed.body.hosted.status).toBe('ACTIVE');
    expect(failed.body.hosted.delegationCheckedAt).toBe(checkedAt);
  });

  it('stays ACTIVE with delegated false when the CNAME disappears', async () => {
    const fixture = await setup();
    const { token } = await startedWithLogo(fixture);
    reader.cname.set(`default._bimi.${fixture.domainName}`, `${token}.bimi.${zone}`);
    await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);

    reader.cname.delete(`default._bimi.${fixture.domainName}`);
    const missing = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(missing.status).toBe(200);
    expect(missing.body.hosted.status).toBe('ACTIVE');
    expect(missing.body.hosted.delegated).toBe(false);
    expect(provider.records).toHaveLength(1);
  });

  it('releases through RELEASING and removes the TXT when the CNAME is gone', async () => {
    const fixture = await setup();
    const { token } = await startedWithLogo(fixture);
    reader.cname.set(`default._bimi.${fixture.domainName}`, `${token}.bimi.${zone}`);
    await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);

    const releasing = await fixture.agent
      .post(`${base(fixture.organizationId, fixture.domainId)}/release`)
      .send({});
    expect(releasing.status).toBe(200);
    expect(releasing.body.hosted.status).toBe('RELEASING');
    expect(releasing.body.hosted.republish.value).toContain(`l=${origin}/bimi/${token}/`);
    expect(provider.records).toHaveLength(1);

    reader.cname.delete(`default._bimi.${fixture.domainName}`);
    const released = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(released.status).toBe(200);
    expect(released.body.hosted.status).toBe('RELEASED');
    expect(provider.records).toHaveLength(0);
    expect(await prisma.hostedBimiAsset.count({ where: { retiredAt: null } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'HOSTED_BIMI_RELEASED' } })).toBe(1);
  });

  it('releases when the CNAME moves to another BIMI host, not only when it is removed', async () => {
    const fixture = await setup();
    const { token } = await startedWithLogo(fixture);
    reader.cname.set(`default._bimi.${fixture.domainName}`, `${token}.bimi.${zone}`);
    await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/release`).send({});

    reader.cname.set(`default._bimi.${fixture.domainName}`, 'bimi.other-provider.example');
    const released = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(released.body.hosted.status).toBe('RELEASED');
    expect(provider.records).toHaveLength(0);
  });

  it('applies the zone limit at the first logo, since starting publishes nothing', async () => {
    const fixture = await setup();
    expect((await start(fixture)).status).toBe(201);
    const limit = env.HOSTED_DNS_RECORD_LIMIT;
    env.HOSTED_DNS_RECORD_LIMIT = await usedHostedRecords();
    try {
      const refused = await uploadLogo(fixture, validSvg('Full'));
      expect(refused.status).toBe(503);
      expect(refused.body.error.code).toBe('HOSTED_DNS_FULL');
      expect(provider.records).toHaveLength(0);
    } finally {
      env.HOSTED_DNS_RECORD_LIMIT = limit;
    }
  });

  it('releases immediately with removeNow', async () => {
    const fixture = await setup();
    const { token } = await startedWithLogo(fixture);
    reader.cname.set(`default._bimi.${fixture.domainName}`, `${token}.bimi.${zone}`);
    await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);

    const released = await fixture.agent
      .post(`${base(fixture.organizationId, fixture.domainId)}/release`)
      .send({ removeNow: true });
    expect(released.status).toBe(200);
    expect(released.body.hosted.status).toBe('RELEASED');
    expect(provider.records).toHaveLength(0);
  });

  it('keeps serving and refuses uploads with 402 after a downgrade', async () => {
    const fixture = await setup();
    const { token } = await startedWithLogo(fixture);
    await grantPlan(fixture.organizationId, 'FAIRWAY');

    const view = await fixture.agent.get(base(fixture.organizationId, fixture.domainId));
    expect(view.status).toBe(200);
    expect(view.body.hosted.paused).toBe(true);
    expect(view.body.hosted.value).toContain(`${origin}/bimi/${token}/`);

    const served = await request(app).get(`/bimi/${token}/${sha12(validSvg('Example'))}.svg`);
    expect(served.status).toBe(200);

    const upload = await uploadLogo(fixture, validSvg('After downgrade'));
    expect(upload.status).toBe(402);

    const removal = await fixture.agent.delete(`${base(fixture.organizationId, fixture.domainId)}/certificate`);
    expect(removal.status).toBe(402);

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

  it('publishes a= with the certificate URL, then empties it on removal', async () => {
    const fixture = await setup();
    const { token } = await startedWithLogo(fixture);
    const pem = Buffer.from(certificateFor({ names: [fixture.domainName] }), 'utf8');

    const uploaded = await fixture.agent
      .put(`${base(fixture.organizationId, fixture.domainId)}/certificate`)
      .set('content-type', 'application/x-pem-file')
      .send(pem);
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.hosted.certificate.sha256).toBe(createHash('sha256').update(pem).digest('hex'));
    expect(uploaded.body.hosted.certificate.expired).toBe(false);
    expect(uploaded.body.hosted.value).toContain(`a=${origin}/bimi/${token}/`);

    const certPath = `/bimi/${token}/${createHash('sha256').update(pem).digest('hex').slice(0, 12)}.pem`;
    const served = await getBytes(certPath);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('application/pem-certificate-chain');
    expect(Buffer.compare(served.body as Buffer, pem)).toBe(0);

    const removed = await fixture.agent.delete(`${base(fixture.organizationId, fixture.domainId)}/certificate`);
    expect(removed.status).toBe(200);
    expect(removed.body.hosted.certificate).toBeNull();
    expect(removed.body.hosted.value.endsWith('a=')).toBe(true);
    expect((await getBytes(certPath)).status).toBe(200); // still inside the grace period
  });

  it('refuses a certificate file that contains a private key', async () => {
    const fixture = await setup();
    await startedWithLogo(fixture);
    const pem = `${['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')}\nAAAA\n`;

    const refused = await fixture.agent
      .put(`${base(fixture.organizationId, fixture.domainId)}/certificate`)
      .set('content-type', 'text/plain')
      .send(Buffer.from(pem, 'utf8'));

    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('BIMI_CERT_HAS_PRIVATE_KEY');
    expect(await prisma.hostedBimiAsset.count({ where: { kind: 'CERTIFICATE' } })).toBe(0);
  });

  it('is invisible to another workspace on every route', async () => {
    const owner = await setup();
    await startedWithLogo(owner);
    const stranger = await setup();
    const path = base(owner.organizationId, owner.domainId);

    const responses = await Promise.all([
      stranger.agent.get(path),
      stranger.agent.post(path),
      stranger.agent.put(`${path}/logo`).set('content-type', 'image/svg+xml'),
      stranger.agent.put(`${path}/certificate`).set('content-type', 'text/plain'),
      stranger.agent.delete(`${path}/certificate`),
      stranger.agent.post(`${path}/check`),
      stranger.agent.post(`${path}/release`),
    ]);

    for (const response of responses) {
      // 403 is the workspace permission middleware refusing a non-member
      // before the service is reached; 404 is the service refusing a domain
      // that is not in the caller's workspace. Both are the same answer as
      // every other workspace route, and neither leaks whether the row exists.
      expect([403, 404]).toContain(response.status);
    }
    expect(
      await prisma.hostedBimiAsset.count({
        where: { record: { domainId: owner.domainId } },
      }),
    ).toBe(1);
  });

  it('removes the TXT when the domain is deleted', async () => {
    const fixture = await setup();
    const { token } = await startedWithLogo(fixture);
    expect(provider.records).toHaveLength(1);

    const deleted = await fixture.agent.delete(
      `/api/workspaces/${fixture.organizationId}/domains/${fixture.domainId}`,
    );
    expect(deleted.status).toBe(200);
    expect(provider.records.filter((record) => record.name === `${token}.bimi.${zone}`)).toHaveLength(0);
  });

  it('lists the record in the deletion preview with the note that the logo stops', async () => {
    const fixture = await setup();
    await startedWithLogo(fixture);

    const preview = await fixture.agent.get(
      `/api/workspaces/${fixture.organizationId}/deletion-preview`,
    );
    expect(preview.status).toBe(200);
    expect(preview.body.hostedBimi).toHaveLength(1);
    expect(preview.body.hostedBimi[0].domain).toBe(fixture.domainName);
    expect(preview.body.hostedBimi[0].note).toContain('logo stops showing');
  });

  it('purges assets retired beyond the grace period and removes only our orphans', async () => {
    const fixture = await setup();
    const { token } = await startedWithLogo(fixture);
    // A replacement retires the first logo; backdate that one past the grace.
    expect((await uploadLogo(fixture, validSvg('Second'))).status).toBe(200);
    const retired = await prisma.hostedBimiAsset.findFirstOrThrow({
      where: { sha256: createHash('sha256').update(validSvg('Example')).digest('hex') },
    });
    await prisma.hostedBimiAsset.update({
      where: { id: retired.id },
      data: { retiredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });

    // An orphan with our comment, and one that is not ours.
    const orphan = await provider.create(
      `bbbbbbbbbbbbbbbb.bimi.${zone}`,
      'v=BIMI1; l=https://example.test/logo.svg; a=',
      'dmarc-harbor bimi missing-row',
    );
    const foreign = await provider.create(
      `cccccccccccccccc.bimi.${zone}`,
      'v=BIMI1; l=https://example.test/logo.svg; a=',
      'someone else',
    );

    const summary = await reconcileHostedBimi();
    expect(summary.purged).toBe(1);
    expect(
      await prisma.hostedBimiAsset.count({
        where: { sha256: createHash('sha256').update(validSvg('Example')).digest('hex') },
      }),
    ).toBe(0);
    expect(provider.records.some((record) => record.id === orphan.id)).toBe(false);
    expect(provider.records.some((record) => record.id === foreign.id)).toBe(true);
    // The live record's TXT is still there.
    expect(provider.records.filter((record) => record.name === `${token}.bimi.${zone}`)).toHaveLength(1);
  });

  it('records a failed provider write on the row instead of throwing', async () => {
    const fixture = await setup();
    const { token } = await startedWithLogo(fixture);
    provider.failUpdate = true;

    const replacement = await uploadLogo(fixture, validSvg('Second'));
    expect(replacement.status).toBe(200);
    expect(replacement.body.hosted.lastSyncError).toContain('Cloudflare refused');

    provider.failUpdate = false;
    const summary = await reconcileHostedBimi();
    expect(summary.synced).toBeGreaterThanOrEqual(1);
    const records = provider.records.filter((record) => record.name === `${token}.bimi.${zone}`);
    expect(records[0]!.content).toContain(`${sha12(validSvg('Second'))}.svg`);
  });
});
