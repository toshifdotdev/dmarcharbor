import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/database/prisma.js';
import { grantPlan } from './helpers/plan.js';
import { runDomainScan } from '../src/services/domain-scan.service.js';
import { runHostedDnsReconcileOnce } from '../src/scheduler/hosted-dns-reconciler.js';
import {
  setManagedSpfNetworkCheckForTests,
  setManagedSpfReaderForTests,
} from '../src/services/hosted-dns/managed-spf.service.js';
import { usedHostedRecords } from '../src/services/hosted-dns/hosted-dmarc.service.js';
import {
  setHostedDnsProviderForTests,
  type HostedDnsProvider,
  type HostedTxt,
} from '../src/services/hosted-dns/provider.js';
import type { DnsReader, LookupResult, MxRecord } from '../src/scanner/types.js';

const zone = 'hosted.test';
const password = 'correct-horse-battery-staple';
const google = 'v=spf1 ip4:203.0.113.10 ip4:198.51.100.0/24 -all';
const sendgrid = 'v=spf1 ip4:198.51.100.128/25 -all';
let fixtureId = 0;

function resetDatabase(): Promise<void> {
  return prisma
    .$executeRawUnsafe(
      'TRUNCATE TABLE "hosted_spf_change", "hosted_spf_record", "hosted_dmarc_change", "hosted_dmarc_record", "rate_limit_bucket", "audit_log", "email_delivery", "session", "account", "verification", "two_factor", member, invitation, "user", "organization" CASCADE',
    )
    .then(() => undefined);
}

class MemoryDnsProvider implements HostedDnsProvider {
  zone = zone;
  records: HostedTxt[] = [];
  failCreate = false;
  failUpdate = false;
  private next = 1;

  async get(name: string): Promise<HostedTxt[]> {
    return this.records.filter((record) => record.name === name).map((record) => ({ ...record }));
  }

  async create(name: string, content: string, comment: string): Promise<HostedTxt> {
    if (this.failCreate) throw new Error('Cloudflare refused the record.');
    const record = { id: `spf-rec-${this.next++}`, name, content, comment };
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
  txt = new Map<string, string[]>();
  txtErrors = new Set<string>();
  addresses = new Map<string, string[]>();
  mx = new Map<string, MxRecord[]>();
  txtCalls = new Map<string, number>();
  throwTxt = new Map<string, number>();

  async resolveTxt(name: string): Promise<LookupResult<string[][]>> {
    const calls = (this.txtCalls.get(name) ?? 0) + 1;
    this.txtCalls.set(name, calls);
    const throwAfter = this.throwTxt.get(name);
    if (throwAfter !== undefined && calls > throwAfter) {
      throw new Error('resolver unavailable');
    }
    if (this.txtErrors.has(name)) return { status: 'error', error: 'resolver unavailable' };
    const records = this.txt.get(name);
    return records === undefined
      ? { status: 'missing' }
      : { status: 'found', value: records.map((record) => [record]) };
  }

  async resolveAddress(name: string): Promise<LookupResult<string[]>> {
    const records = this.addresses.get(name);
    return records === undefined ? { status: 'missing' } : { status: 'found', value: records };
  }

  async resolveMx(name: string): Promise<LookupResult<MxRecord[]>> {
    const records = this.mx.get(name);
    return records === undefined ? { status: 'missing' } : { status: 'found', value: records };
  }
}

let provider: MemoryDnsProvider;
let reader: FakeDns;

beforeEach(async () => {
  await resetDatabase();
  env.HOSTED_DNS_ZONE = zone;
  env.HOSTED_DNS_RECORD_LIMIT = 200;
  provider = new MemoryDnsProvider();
  reader = new FakeDns();
  setHostedDnsProviderForTests(provider);
  setManagedSpfReaderForTests(reader);
  setManagedSpfNetworkCheckForTests(() => false);
});

afterEach(() => {
  setHostedDnsProviderForTests(null);
  setManagedSpfReaderForTests(null);
  setManagedSpfNetworkCheckForTests(null);
  env.HOSTED_DNS_RECORD_LIMIT = 200;
});

function seedStandard(domain: string): void {
  reader.txt.set(
    domain,
    ['v=spf1 include:_spf.google.com include:sendgrid.net ip4:203.0.113.5 ~all'],
  );
  reader.txt.set('_spf.google.com', [google]);
  reader.txt.set('sendgrid.net', [sendgrid]);
}

async function setup(plan: 'HARBOR' | 'FAIRWAY' | 'MOORING' = 'HARBOR') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `managed-spf-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'SPF Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'SPF Agency',
    slug: `spf-agency-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;
  if (plan !== 'MOORING') await grantPlan(organizationId, plan);

  const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name: 'SPF Client',
    slug: `spf-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);
  const clientId = client.body.id as string;

  const domainName = `spf-${Date.now()}-${fixtureId}.example`;
  const created = await agent
    .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
    .send({ name: domainName });
  expect(created.status).toBe(201);
  await prisma.domain.update({
    where: { id: created.body.id },
    data: { status: 'VERIFIED', verifiedAt: new Date() },
  });

  return {
    agent,
    organizationId,
    clientId,
    domainId: created.body.id as string,
    domainName,
  };
}

async function addDomain(fixture: Awaited<ReturnType<typeof setup>>, label: string) {
  const domainName = `${label}-${Date.now()}-${++fixtureId}.example`;
  const created = await fixture.agent
    .post(`/api/workspaces/${fixture.organizationId}/clients/${fixture.clientId}/domains`)
    .send({ name: domainName });
  expect(created.status).toBe(201);
  await prisma.domain.update({
    where: { id: created.body.id },
    data: { status: 'VERIFIED', verifiedAt: new Date() },
  });
  return { id: created.body.id as string, name: domainName };
}

const base = (organizationId: string, domainId: string) =>
  `/api/workspaces/${organizationId}/domains/${domainId}/managed-spf`;

async function startSpf(fixture: Awaited<ReturnType<typeof setup>>) {
  seedStandard(fixture.domainName);
  return fixture.agent.post(base(fixture.organizationId, fixture.domainId));
}

describe('managed SPF', () => {
  it('reports unavailable and refuses start when the deployment has no hosted zone', async () => {
    setHostedDnsProviderForTests(null);
    const fixture = await setup();
    const view = await fixture.agent.get(base(fixture.organizationId, fixture.domainId));
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ available: false, managed: null });

    const refused = await startSpf(fixture);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('HOSTED_DNS_UNAVAILABLE');
  });

  it('refuses Fairway with the standard feature refusal and works on Harbor', async () => {
    const fairway = await setup('FAIRWAY');
    seedStandard(fairway.domainName);
    const refused = await fairway.agent.post(base(fairway.organizationId, fairway.domainId));
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('FEATURE_NOT_IN_PLAN');

    const harbor = await setup('HARBOR');
    const started = await startSpf(harbor);
    expect(started.status).toBe(201);
  });

  it('imports the apex record and publishes the flattened ranges under the lookup limit', async () => {
    const fixture = await setup();
    const started = await startSpf(fixture);
    expect(started.status).toBe(201);
    const managed = started.body.managed;
    expect(managed.apex.value).toMatch(/^v=spf1 redirect=[a-z2-7]{16}\.spf\.hosted\.test$/);
    expect(managed.status).toBe('PENDING');
    expect(managed.lookupCount).toBe(1);

    const row = await prisma.hostedSpfRecord.findUniqueOrThrow({ where: { domainId: fixture.domainId } });
    expect(row.token).toMatch(/^[a-z2-7]{16}$/);
    expect(row.sources).toEqual([
      { kind: 'include', value: '_spf.google.com' },
      { kind: 'include', value: 'sendgrid.net' },
      { kind: 'ip4', value: '203.0.113.5' },
    ]);
    expect(row.allQualifier).toBe('~all');
    const parts = row.parts as unknown as Array<{ name: string; content: string; providerRecordId: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.name).toBe(`${row.token}.spf.${zone}`);
    expect(parts[0]!.content).toContain('203.0.113.5');
    expect(parts[0]!.content).toContain('203.0.113.10');
    expect(parts[0]!.content).toContain('198.51.100.0/24');
    expect(parts[0]!.content).not.toContain('198.51.100.128/25');
    expect(parts[0]!.content.endsWith('~all')).toBe(true);
    expect(provider.records).toHaveLength(1);
    expect(provider.records[0]!.comment).toBe(`dmarc-harbor hosted-spf ${row.id}`);
  });

  it('refuses a start with an unresolvable source and leaves no row', async () => {
    const fixture = await setup();
    reader.txt.set(fixture.domainName, ['v=spf1 include:missing.test -all']);
    const refused = await fixture.agent.post(base(fixture.organizationId, fixture.domainId));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SOURCE_NOT_USABLE');
    expect(await prisma.hostedSpfRecord.count({ where: { domainId: fixture.domainId } })).toBe(0);
    expect(provider.records).toHaveLength(0);
  });

  it('previews without saving', async () => {
    const fixture = await setup();
    seedStandard(fixture.domainName);
    const preview = await fixture.agent
      .post(`${base(fixture.organizationId, fixture.domainId)}/preview`)
      .send({
        sources: [{ kind: 'include', value: 'sendgrid.net' }],
        allQualifier: '-all',
      });
    expect(preview.status).toBe(200);
    expect(preview.body.lookupCount).toBe(1);
    expect(preview.body.parts.length).toBeGreaterThan(0);
    expect(preview.body.ip4Count).toBeGreaterThan(0);
    expect(preview.body.ip6Count).toBe(0);
    expect(await prisma.hostedSpfRecord.count({ where: { domainId: fixture.domainId } })).toBe(0);
    expect(provider.records).toHaveLength(0);
  });

  it('updates sources, refuses a stale version and rolls back a provider failure', async () => {
    const fixture = await setup();
    const started = await startSpf(fixture);
    expect(started.status).toBe(201);
    const sources = started.body.managed.sources as Array<{ kind: string; value: string }>;

    reader.txt.set('mailgun.org', ['v=spf1 ip4:8.8.8.0/24 -all']);
    const updated = await fixture.agent
      .put(base(fixture.organizationId, fixture.domainId))
      .send({
        expectedVersion: 1,
        sources: [...sources, { kind: 'include', value: 'mailgun.org' }],
        allQualifier: '~all',
      });
    expect(updated.status).toBe(200);
    expect(updated.body.managed.version).toBe(2);
    expect(updated.body.managed.parts[0].content).toContain('8.8.8.0/24');
    expect(updated.body.managed.changes[0].reason).toBe('sources');
    expect(await prisma.auditLog.count({ where: { action: 'MANAGED_SPF_UPDATED' } })).toBe(1);

    const stale = await fixture.agent
      .put(base(fixture.organizationId, fixture.domainId))
      .send({ expectedVersion: 1, sources, allQualifier: '~all' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CHANGED');
    expect(stale.body.view).toBeDefined();

    reader.txt.set('postmarkapp.com', ['v=spf1 ip4:8.8.4.0/24 -all']);
    provider.failUpdate = true;
    const failed = await fixture.agent
      .put(base(fixture.organizationId, fixture.domainId))
      .send({
        expectedVersion: 2,
        sources: [...sources, { kind: 'include', value: 'mailgun.org' }, { kind: 'include', value: 'postmarkapp.com' }],
        allQualifier: '~all',
      });
    expect(failed.status).toBe(502);
    const row = await prisma.hostedSpfRecord.findUniqueOrThrow({ where: { domainId: fixture.domainId } });
    expect(row.version).toBe(2);
    const parts = row.parts as unknown as Array<{ content: string }>;
    expect(parts[0]!.content).toContain('8.8.8.0/24');
    expect(parts[0]!.content).not.toContain('8.8.4.0/24');
  });

  it('splits a large source set into continuation parts and publishes exactly those names', async () => {
    const fixture = await setup();
    const terms = Array.from({ length: 40 }, (_, index) => `ip4:203.0.${index}.0/24`).join(' ');
    reader.txt.set(fixture.domainName, [`v=spf1 ${terms} -all`]);
    const started = await fixture.agent.post(base(fixture.organizationId, fixture.domainId));
    expect(started.status).toBe(201);
    const row = await prisma.hostedSpfRecord.findUniqueOrThrow({ where: { domainId: fixture.domainId } });
    const parts = row.parts as unknown as Array<{ name: string; content: string }>;
    expect(parts.length).toBeGreaterThan(1);
    expect(provider.records).toHaveLength(parts.length);
    expect(provider.records.map((record) => record.name).sort()).toEqual(parts.map((part) => part.name).sort());
    for (const part of parts) {
      expect(part.content.length).toBeLessThanOrEqual(450);
    }
  });

  it('refreshes changed ranges, ignores an unchanged refresh and keeps last good addresses on failure', async () => {
    const fixture = await setup();
    const started = await startSpf(fixture);
    expect(started.status).toBe(201);

    reader.txt.set('_spf.google.com', ['v=spf1 ip4:8.8.8.0/24 -all']);
    await runHostedDnsReconcileOnce();
    let row = await prisma.hostedSpfRecord.findUniqueOrThrow({ where: { domainId: fixture.domainId } });
    let parts = row.parts as unknown as Array<{ content: string }>;
    expect(parts[0]!.content).toContain('8.8.8.0/24');
    expect(await prisma.hostedSpfChange.count({ where: { recordId: row.id, reason: 'refresh' } })).toBe(1);

    await runHostedDnsReconcileOnce();
    expect(await prisma.hostedSpfChange.count({ where: { recordId: row.id, reason: 'refresh' } })).toBe(1);

    const before = parts[0]!.content;
    reader.txtErrors.add('_spf.google.com');
    await runHostedDnsReconcileOnce();
    row = await prisma.hostedSpfRecord.findUniqueOrThrow({ where: { domainId: fixture.domainId } });
    parts = row.parts as unknown as Array<{ content: string }>;
    expect(parts[0]!.content).toBe(before);
    const state = row.sourceState as Record<string, { failingSince: string | null }>;
    expect(state['include:_spf.google.com']?.failingSince).toBeTruthy();
  });

  it('keeps the published parts when a new layout does not fit capacity', async () => {
    const fixture = await setup();
    const started = await startSpf(fixture);
    expect(started.status).toBe(201);
    env.HOSTED_DNS_RECORD_LIMIT = 1;
    reader.txt.set(
      '_spf.google.com',
      [`v=spf1 ${Array.from({ length: 40 }, (_, index) => `ip4:8.0.${index}.0/24`).join(' ')} -all`],
    );
    await runHostedDnsReconcileOnce();
    const row = await prisma.hostedSpfRecord.findUniqueOrThrow({ where: { domainId: fixture.domainId } });
    const parts = row.parts as unknown as Array<{ content: string }>;
    expect(row.capacityBlocked).toBe(true);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.content).not.toContain('8.0.0.0/24');
  });

  it('pauses edits on Fairway but still refreshes the addresses', async () => {
    const fixture = await setup();
    const started = await startSpf(fixture);
    expect(started.status).toBe(201);
    await grantPlan(fixture.organizationId, 'FAIRWAY');

    const paused = await fixture.agent.get(base(fixture.organizationId, fixture.domainId));
    expect(paused.body.managed.paused).toBe(true);
    const refused = await fixture.agent
      .put(base(fixture.organizationId, fixture.domainId))
      .send({ expectedVersion: 1, sources: started.body.managed.sources, allQualifier: '~all' });
    expect(refused.status).toBe(402);

    reader.txt.set('_spf.google.com', ['v=spf1 ip4:8.8.8.0/24 -all']);
    await runHostedDnsReconcileOnce();
    const row = await prisma.hostedSpfRecord.findUniqueOrThrow({ where: { domainId: fixture.domainId } });
    const parts = row.parts as unknown as Array<{ content: string }>;
    expect(parts[0]!.content).toContain('8.8.8.0/24');
  });

  it('moves PENDING to ACTIVE and releases only after a clean foreign record', async () => {
    const fixture = await setup();
    const started = await startSpf(fixture);
    expect(started.status).toBe(201);
    const entry = started.body.managed.apex.value.replace('v=spf1 redirect=', '');

    const pending = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(pending.body.managed.status).toBe('PENDING');

    reader.txt.set(fixture.domainName, [`v=spf1 redirect=${entry}`]);
    const active = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(active.body.managed.status).toBe('ACTIVE');
    expect(active.body.managed.delegated).toBe(true);

    const release = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/release`);
    expect(release.status).toBe(200);
    expect(release.body.managed.status).toBe('RELEASING');
    expect(release.body.managed.republish.value).toBe(
      'v=spf1 include:_spf.google.com include:sendgrid.net ip4:203.0.113.5 ~all',
    );
    expect(release.body.managed.republish.overLimit).toBe(false);

    reader.txtErrors.add(fixture.domainName);
    const error = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(error.body.managed.status).toBe('RELEASING');
    expect(error.body.managed.delegated).toBe(true);

    reader.txtErrors.delete(fixture.domainName);
    reader.txt.set(fixture.domainName, [
      `v=spf1 redirect=${entry}`,
      'v=spf1 ip4:8.8.8.8 -all',
    ]);
    const multiple = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(multiple.body.managed.status).toBe('RELEASING');

    reader.txt.set(fixture.domainName, ['v=spf1 ip4:8.8.8.8 -all']);
    const released = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(released.body.managed.status).toBe('RELEASED');
    expect(provider.records).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { action: 'MANAGED_SPF_RELEASED' } })).toBe(1);
  });

  it('releases a PENDING record at once and reports an over-limit republish', async () => {
    const pendingFixture = await setup();
    const pendingStart = await startSpf(pendingFixture);
    expect(pendingStart.status).toBe(201);
    const released = await pendingFixture.agent.post(
      base(pendingFixture.organizationId, pendingFixture.domainId) + '/release',
    );
    expect(released.status).toBe(200);
    expect(released.body.managed.status).toBe('RELEASED');
    expect(provider.records).toHaveLength(0);

    const over = await setup();
    const includes = Array.from({ length: 11 }, (_, index) => `include:i${index}.test`);
    reader.txt.set(over.domainName, [`v=spf1 ${includes.join(' ')} -all`]);
    for (let index = 0; index < 11; index += 1) {
      reader.txt.set(`i${index}.test`, [`v=spf1 ip4:203.0.113.${index + 1} -all`]);
    }
    const started = await over.agent.post(base(over.organizationId, over.domainId));
    expect(started.status).toBe(201);
    const entry = started.body.managed.apex.value.replace('v=spf1 redirect=', '');
    reader.txt.set(over.domainName, [`v=spf1 redirect=${entry}`]);
    await over.agent.post(`${base(over.organizationId, over.domainId)}/check`);
    const releasing = await over.agent.post(`${base(over.organizationId, over.domainId)}/release`);
    expect(releasing.status).toBe(200);
    expect(releasing.body.managed.republish.lookupCount).toBe(11);
    expect(releasing.body.managed.republish.overLimit).toBe(true);
  });

  it('lists the unflattened record in the deletion preview and removes parts on delete and erasure', async () => {
    const fixture = await setup();
    await startSpf(fixture);
    const preview = await fixture.agent.get(`/api/workspaces/${fixture.organizationId}/deletion-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.managedSpf).toEqual([
      {
        domain: fixture.domainName,
        republish: {
          host: fixture.domainName,
          type: 'TXT',
          value: 'v=spf1 include:_spf.google.com include:sendgrid.net ip4:203.0.113.5 ~all',
        },
      },
    ]);

    const deleted = await fixture.agent.delete(
      `/api/workspaces/${fixture.organizationId}/domains/${fixture.domainId}`,
    );
    expect(deleted.status).toBe(200);
    expect(provider.records).toHaveLength(0);

    const erased = await setup();
    await startSpf(erased);
    expect(provider.records.length).toBeGreaterThan(0);
    const requestErasure = await erased.agent
      .post(`/api/workspaces/${erased.organizationId}/erasures`)
      .send({ scope: 'DOMAIN', targetId: erased.domainId });
    expect(requestErasure.status).toBe(202);
    const executed = await erased.agent
      .post(`/api/workspaces/${erased.organizationId}/erasures/${requestErasure.body.id}/execute`)
      .send({ confirmNamePurge: true });
    expect(executed.status).toBe(200);
    expect(provider.records).toHaveLength(0);
  });

  it('removes only SPF-shaped orphans with our comment and leaves DMARC and unrelated records alone', async () => {
    const fixture = await setup();
    await startSpf(fixture);

    const dmarcDomain = await addDomain(fixture, 'dmarc-live');
    const dmarcRow = await prisma.hostedDmarcRecord.create({
      data: {
        organizationId: fixture.organizationId,
        domainId: dmarcDomain.id,
        token: 'b'.repeat(16),
        value: 'v=DMARC1; p=none',
      },
    });
    provider.records.push({
      id: 'dmarc-live-1',
      name: `${dmarcRow.token}.${zone}`,
      content: dmarcRow.value,
      comment: `dmarc-harbor hosted ${dmarcRow.id}`,
    });
    provider.records.push({
      id: 'spf-orphan-1',
      name: `${'a'.repeat(16)}-2.spf.${zone}`,
      content: 'v=spf1 ip4:8.8.8.8 -all',
      comment: 'dmarc-harbor hosted-spf no-such-row',
    });
    provider.records.push({
      id: 'ordinary-1',
      name: `ordinary.${zone}`,
      content: 'hello',
      comment: null,
    });

    await runHostedDnsReconcileOnce();

    expect(provider.records.some((record) => record.id === 'spf-orphan-1')).toBe(false);
    expect(provider.records.some((record) => record.id === 'dmarc-live-1')).toBe(true);
    expect(provider.records.some((record) => record.id === 'ordinary-1')).toBe(true);
  });

  it('counts every SPF part against capacity and refuses a start that does not fit', async () => {
    env.HOSTED_DNS_RECORD_LIMIT = 2;
    const fixture = await setup();
    const first = await startSpf(fixture);
    expect(first.status).toBe(201);
    expect(await usedHostedRecords()).toBe(1);

    const second = await addDomain(fixture, 'capacity');
    const terms = Array.from({ length: 40 }, (_, index) => `ip4:203.0.${index}.0/24`).join(' ');
    reader.txt.set(second.name, [`v=spf1 ${terms} -all`]);
    const refused = await fixture.agent.post(base(fixture.organizationId, second.id));
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('HOSTED_DNS_FULL');
    expect(await prisma.hostedSpfRecord.count({ where: { domainId: second.id } })).toBe(0);
  });

  it('answers 404 for another workspace using this workspace domain id', async () => {
    const fixture = await setup();
    await startSpf(fixture);

    fixtureId += 1;
    const second = await fixture.agent.post('/api/workspaces').send({
      name: 'Second SPF Agency',
      slug: `second-spf-agency-${Date.now()}-${fixtureId}`,
      tosAccepted: true,
      dpaHasRead: true,
      dpaConfirmsAuthority: true,
    });
    expect(second.status).toBe(201);
    const otherOrg = second.body.id as string;
    await grantPlan(otherOrg, 'HARBOR');

    for (const [method, path, body] of [
      ['get', base(otherOrg, fixture.domainId), undefined],
      ['post', base(otherOrg, fixture.domainId), undefined],
      [
        'post',
        `${base(otherOrg, fixture.domainId)}/preview`,
        { sources: [], allQualifier: '~all' },
      ],
      [
        'put',
        base(otherOrg, fixture.domainId),
        { expectedVersion: 1, sources: [], allQualifier: '~all' },
      ],
      ['post', `${base(otherOrg, fixture.domainId)}/check`, undefined],
      ['post', `${base(otherOrg, fixture.domainId)}/release`, undefined],
    ] as const) {
      const response = await fixture.agent[method](path).send(body);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it('checks delegation during a scan, and a failing check does not fail the scan', async () => {
    const fixture = await setup();
    const started = await startSpf(fixture);
    expect(started.status).toBe(201);
    const entry = started.body.managed.apex.value.replace('v=spf1 redirect=', '');
    const row = await prisma.hostedSpfRecord.findUniqueOrThrow({ where: { domainId: fixture.domainId } });
    const parts = row.parts as unknown as Array<{ name: string; content: string }>;
    reader.txt.set(entry, [parts[0]!.content]);
    reader.txt.set(fixture.domainName, [`v=spf1 redirect=${entry}`]);

    const scanned = await runDomainScan({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      requestedById: null,
      reader,
    });
    expect(scanned.status).toBe('completed');
    expect(
      (await prisma.hostedSpfRecord.findUniqueOrThrow({ where: { domainId: fixture.domainId } })).status,
    ).toBe('ACTIVE');

    const failing = await setup();
    const failingStart = await startSpf(failing);
    expect(failingStart.status).toBe(201);
    const failingEntry = failingStart.body.managed.apex.value.replace('v=spf1 redirect=', '');
    const failingRow = await prisma.hostedSpfRecord.findUniqueOrThrow({ where: { domainId: failing.domainId } });
    const failingParts = failingRow.parts as unknown as Array<{ name: string; content: string }>;
    reader.txt.set(failingEntry, [failingParts[0]!.content]);
    reader.txt.set(failing.domainName, [`v=spf1 redirect=${failingEntry}`]);
    reader.txtCalls.clear();
    reader.throwTxt.set(failing.domainName, 1);

    const survived = await runDomainScan({
      organizationId: failing.organizationId,
      domainId: failing.domainId,
      requestedById: null,
      reader,
    });
    expect(survived.status).toBe('completed');
    expect(
      (await prisma.hostedSpfRecord.findUniqueOrThrow({ where: { domainId: failing.domainId } })).status,
    ).toBe('PENDING');
  });
});
