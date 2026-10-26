import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/database/prisma.js';
import { grantPlan } from './helpers/plan.js';
import { getOnboardingState, type PolicyReadiness } from '../src/services/onboarding.service.js';
import { runDomainScan } from '../src/services/domain-scan.service.js';
import { runHostedDnsReconcileOnce } from '../src/scheduler/hosted-dns-reconciler.js';
import {
  setHostedDmarcReadinessForTests,
  setHostedDmarcReaderForTests,
  setHostedDmarcRefreshForTests,
} from '../src/services/hosted-dns/hosted-dmarc.service.js';
import {
  setHostedDnsProviderForTests,
  type HostedDnsProvider,
  type HostedTxt,
} from '../src/services/hosted-dns/provider.js';
import type { DnsReader, LookupResult, MxRecord } from '../src/scanner/types.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const zone = 'hosted.test';

function resetDatabase(): Promise<void> {
  return prisma
    .$executeRawUnsafe(
      'TRUNCATE TABLE "hosted_dmarc_change", "hosted_dmarc_record", "rate_limit_bucket", "audit_log", "email_delivery", "session", "account", "verification", "two_factor", member, invitation, "user", "organization" CASCADE',
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
  txt = new Map<string, string>();
  multi = new Map<string, string[][]>();
  cname = new Map<string, string>();
  failTxt = false;
  cnameCalls = 0;
  throwCnameAfter: number | null = null;
  failCname = false;

  async resolveTxt(name: string): Promise<LookupResult<string[][]>> {
    if (this.failTxt) return { status: 'error', error: 'resolver unavailable' };
    const multiple = this.multi.get(name);
    if (multiple) return { status: 'found', value: multiple };
    const value = this.txt.get(name);
    return value === undefined ? { status: 'missing' } : { status: 'found', value: [[value]] };
  }

  async resolveCname(name: string): Promise<LookupResult<string[]>> {
    this.cnameCalls += 1;
    if (this.throwCnameAfter !== null && this.cnameCalls > this.throwCnameAfter) {
      throw new Error('resolver unavailable');
    }
    if (this.failCname) return { status: 'error', error: 'resolver unavailable' };
    const value = this.cname.get(name);
    return value === undefined ? { status: 'missing' } : { status: 'found', value: [value] };
  }

  /** A real resolver follows a CNAME at the name to the target's TXT. */
  followCnameTo(name: string, provider: { records: HostedTxt[] }): void {
    const target = this.cname.get(name);
    const served = provider.records.find((record) => record.name === target);
    if (served) this.txt.set(name, served.content);
  }

  async resolveMx(): Promise<LookupResult<MxRecord[]>> {
    return { status: 'found', value: [{ exchange: 'mx.example.test', priority: 10 }] };
  }
}

function readiness(blockers: string[] = []): PolicyReadiness {
  return {
    level: 'none',
    ready: blockers.length === 0,
    currentPolicy: 'none',
    testing: false,
    daysObserved: 0,
    daysAtCurrentPolicy: 0,
    dkimPassRatePercent: null,
    messagesObserved: 0,
    passRatePercent: null,
    openAlerts: 0,
    staleAlerts: 0,
    failingSenders: 0,
    observedSenders: 0,
    blockers,
  };
}

let provider: MemoryDnsProvider;
let reader: FakeDns;
let refreshes = 0;

beforeEach(async () => {
  await resetDatabase();
  env.HOSTED_DNS_ZONE = zone;
  env.HOSTED_DNS_RECORD_LIMIT = 200;
  provider = new MemoryDnsProvider();
  reader = new FakeDns();
  refreshes = 0;
  setHostedDnsProviderForTests(provider);
  setHostedDmarcReaderForTests(reader);
  setHostedDmarcRefreshForTests(async () => {
    refreshes += 1;
  });
  setHostedDmarcReadinessForTests(async () => readiness());
});

afterEach(() => {
  setHostedDnsProviderForTests(null);
  setHostedDmarcReaderForTests(null);
  setHostedDmarcRefreshForTests(null);
  setHostedDmarcReadinessForTests(null);
  env.HOSTED_DNS_RECORD_LIMIT = 200;
});

async function setup(plan: 'FAIRWAY' | 'MOORING' = 'FAIRWAY') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `hosted-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Hosted Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Hosted Agency',
    slug: `hosted-agency-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;
  if (plan === 'FAIRWAY') await grantPlan(organizationId, 'FAIRWAY');

  const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name: 'Hosted Client',
    slug: `hosted-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);
  const clientId = client.body.id as string;

  const domain = `hosted-${Date.now()}-${fixtureId}.example`;
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
    userId: (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id,
  };
}

async function addDomain(input: Awaited<ReturnType<typeof setup>>, label: string) {
  const domain = `${label}-${Date.now()}-${++fixtureId}.example`;
  const created = await input.agent
    .post(`/api/workspaces/${input.organizationId}/clients/${input.clientId}/domains`)
    .send({ name: domain });
  expect(created.status).toBe(201);
  await prisma.domain.update({ where: { id: created.body.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } });
  return { id: created.body.id as string, name: domain };
}

const base = (organizationId: string, domainId: string) =>
  `/api/workspaces/${organizationId}/domains/${domainId}/hosted-dmarc`;

async function start(agent: ReturnType<typeof request.agent>, organizationId: string, domainId: string) {
  return agent.post(base(organizationId, domainId));
}

describe('hosted DMARC records', () => {
  it('reports unavailable and refuses start when the deployment has no hosted zone', async () => {
    setHostedDnsProviderForTests(null);
    const fixture = await setup();
    const view = await fixture.agent.get(base(fixture.organizationId, fixture.domainId));
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ available: false, hosted: null });

    const refused = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('HOSTED_DNS_UNAVAILABLE');
  });

  it('refuses Mooring with the standard feature refusal', async () => {
    const fixture = await setup('MOORING');
    const refused = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
  });

  it('keeps an existing enforcing record and adds our report address', async () => {
    const fixture = await setup();
    reader.txt.set(
      `_dmarc.${fixture.domainName}`,
      'v=DMARC1; p=reject; rua=mailto:other@example.test',
    );
    const onboarding = await getOnboardingState(fixture.organizationId, fixture.domainId);
    expect(onboarding).not.toBeNull();

    const response = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    expect(response.status).toBe(201);
    const hosted = response.body.hosted;
    expect(hosted.value).toContain('p=reject');
    expect(hosted.value).toContain('other@example.test');
    expect(hosted.value).toContain(onboarding!.suggestedRecord.aggregateAddress);
    expect(hosted.cname.target).toMatch(/^[a-z2-7]{16}\.hosted\.test$/);

    const row = await prisma.hostedDmarcRecord.findUniqueOrThrow({
      where: { domainId: fixture.domainId },
    });
    expect(hosted.cname.target).toBe(`${row.token}.${zone}`);
    const providerRecords = provider.records.filter((record) => record.name === `${row.token}.${zone}`);
    expect(providerRecords).toHaveLength(1);
    expect(providerRecords[0]!.content).toBe(row.value);
    expect(providerRecords[0]!.comment).toBe(`dmarc-harbor hosted ${row.id}`);
  });

  it('uses the onboarding suggestion when nothing is published', async () => {
    const fixture = await setup();
    const onboarding = await getOnboardingState(fixture.organizationId, fixture.domainId);
    const response = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    expect(response.status).toBe(201);
    expect(response.body.hosted.value).toBe(onboarding!.suggestedRecord.value);
  });

  it('leaves no row when the provider fails, and refuses multiple records or a failed lookup', async () => {
    const fixture = await setup();
    provider.failCreate = true;
    const failed = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    expect(failed.status).toBe(502);
    expect(await prisma.hostedDmarcRecord.count({ where: { domainId: fixture.domainId } })).toBe(0);

    provider.failCreate = false;
    reader.multi.set(`_dmarc.${fixture.domainName}`, [
      ['v=DMARC1; p=none'],
      ['v=DMARC1; p=reject'],
    ]);
    const multiple = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    expect(multiple.status).toBe(409);
    expect(multiple.body.error.code).toBe('MULTIPLE_DMARC_RECORDS');
    expect(await prisma.hostedDmarcRecord.count({ where: { domainId: fixture.domainId } })).toBe(0);

    reader.multi.clear();
    reader.failTxt = true;
    const lookupFailed = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    expect(lookupFailed.status).toBe(503);
    expect(lookupFailed.body.error.code).toBe('DNS_LOOKUP_FAILED');
    expect(await prisma.hostedDmarcRecord.count({ where: { domainId: fixture.domainId } })).toBe(0);
  });

  it('moves PENDING to ACTIVE when the CNAME points at the token', async () => {
    const fixture = await setup();
    const started = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    expect(started.status).toBe(201);
    const target = started.body.hosted.cname.target as string;

    const pending = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(pending.status).toBe(200);
    expect(pending.body.hosted.status).toBe('PENDING');
    expect(pending.body.hosted.delegationCheckedAt).not.toBeNull();

    reader.cname.set(`_dmarc.${fixture.domainName}`, target);
    const active = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(active.status).toBe(200);
    expect(active.body.hosted.status).toBe('ACTIVE');
    expect(active.body.hosted.delegated).toBe(true);
    expect(active.body.hosted.activatedAt).not.toBeNull();
  });

  it('changes policy with a version, refuses a stale version, and audits the change', async () => {
    const fixture = await setup();
    const started = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    const version = started.body.hosted.version as number;

    const changed = await fixture.agent
      .put(base(fixture.organizationId, fixture.domainId))
      .send({ expectedVersion: version, policy: 'quarantine' });
    expect(changed.status).toBe(200);
    expect(changed.body.hosted.policy.p).toBe('quarantine');
    expect(changed.body.hosted.version).toBe(version + 1);
    expect(changed.body.hosted.changes[0].reason).toBe('policy');
    expect(await prisma.auditLog.count({ where: { action: 'HOSTED_DMARC_UPDATED' } })).toBe(1);
    expect(refreshes).toBe(1);

    const stale = await fixture.agent
      .put(base(fixture.organizationId, fixture.domainId))
      .send({ expectedVersion: version, policy: 'reject' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CHANGED');
    expect(stale.body.view).toBeDefined();
  });

  it('refuses a strengthening change with blockers unless overridden', async () => {
    const fixture = await setup();
    const started = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    setHostedDmarcReadinessForTests(async () => readiness(['No DMARC results have been observed yet.']));

    const refused = await fixture.agent
      .put(base(fixture.organizationId, fixture.domainId))
      .send({ expectedVersion: started.body.hosted.version, policy: 'quarantine' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('POLICY_NOT_READY');
    expect(refused.body.blockers).toEqual(['No DMARC results have been observed yet.']);

    const overridden = await fixture.agent
      .put(base(fixture.organizationId, fixture.domainId))
      .send({ expectedVersion: started.body.hosted.version, policy: 'quarantine', override: true });
    expect(overridden.status).toBe(200);
    const change = await prisma.hostedDmarcChange.findFirstOrThrow({
      where: { recordId: (await prisma.hostedDmarcRecord.findUniqueOrThrow({ where: { domainId: fixture.domainId } })).id, reason: 'policy' },
    });
    expect(change.readinessOverride).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'HOSTED_DMARC_UPDATED' } });
    expect((audit.detail as { override?: boolean }).override).toBe(true);
  });

  it('rolls the value and version back when the provider refuses a policy change', async () => {
    const fixture = await setup();
    const started = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    const original = started.body.hosted.value as string;
    provider.failUpdate = true;

    const failed = await fixture.agent
      .put(base(fixture.organizationId, fixture.domainId))
      .send({ expectedVersion: started.body.hosted.version, policy: 'quarantine' });
    expect(failed.status).toBe(502);

    const row = await prisma.hostedDmarcRecord.findUniqueOrThrow({ where: { domainId: fixture.domainId } });
    expect(row.value).toBe(original);
    expect(row.version).toBe(1);
    expect(await prisma.hostedDmarcChange.count({ where: { recordId: row.id, reason: 'policy' } })).toBe(0);
  });

  it('restores a policy change once, within the window and only while it is current', async () => {
    const fixture = await setup();
    const started = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    const original = started.body.hosted.value as string;
    const changed = await fixture.agent
      .put(base(fixture.organizationId, fixture.domainId))
      .send({ expectedVersion: 1, policy: 'quarantine' });
    const changeId = changed.body.hosted.changes[0].id as string;

    const restored = await fixture.agent
      .post(`${base(fixture.organizationId, fixture.domainId)}/changes/${changeId}/restore`)
      .send({ expectedVersion: 2 });
    expect(restored.status).toBe(200);
    expect(restored.body.hosted.value).toBe(original);
    expect(restored.body.hosted.version).toBe(3);
    const originalChange = await prisma.hostedDmarcChange.findUniqueOrThrow({ where: { id: changeId } });
    expect(originalChange.restoredAt).not.toBeNull();

    const again = await fixture.agent
      .post(`${base(fixture.organizationId, fixture.domainId)}/changes/${changeId}/restore`)
      .send({ expectedVersion: 3 });
    expect(again.status).toBe(409);

    await fixture.agent
      .put(base(fixture.organizationId, fixture.domainId))
      .send({ expectedVersion: 3, policy: 'quarantine' });
    const changedAgain = await fixture.agent
      .post(`${base(fixture.organizationId, fixture.domainId)}/changes/${changeId}/restore`)
      .send({ expectedVersion: 4 });
    expect(changedAgain.status).toBe(409);
  });

  it('pauses changes on a downgrade but still allows release', async () => {
    const fixture = await setup();
    await start(fixture.agent, fixture.organizationId, fixture.domainId);
    await grantPlan(fixture.organizationId, 'MOORING');

    const view = await fixture.agent.get(base(fixture.organizationId, fixture.domainId));
    expect(view.status).toBe(200);
    expect(view.body.hosted.paused).toBe(true);

    const refused = await fixture.agent
      .put(base(fixture.organizationId, fixture.domainId))
      .send({ expectedVersion: 1, policy: 'quarantine' });
    expect(refused.status).toBe(402);

    const released = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/release`);
    expect(released.status).toBe(200);
    expect(released.body.hosted.status).toBe('RELEASED');
  });

  it('keeps serving through RELEASING until a TXT is published and the CNAME is gone', async () => {
    const fixture = await setup();
    const started = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    reader.cname.set(`_dmarc.${fixture.domainName}`, started.body.hosted.cname.target);
    await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);

    const releasing = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/release`);
    expect(releasing.status).toBe(200);
    expect(releasing.body.hosted.status).toBe('RELEASING');
    expect(releasing.body.hosted.republish.value).toBe(started.body.hosted.value);

    const stillOurs = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(stillOurs.body.hosted.status).toBe('RELEASING');

    // The CNAME is still ours, so the TXT lookup at _dmarc returns OUR record.
    // A failed CNAME lookup must not be read as "the CNAME is gone": that would
    // delete the record the CNAME still points at.
    reader.followCnameTo(`_dmarc.${fixture.domainName}`, provider);
    reader.failCname = true;
    const cnameUnknown = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(cnameUnknown.body.hosted.status).toBe('RELEASING');
    expect(cnameUnknown.body.hosted.delegated).toBe(true);
    expect(provider.records).toHaveLength(1);
    reader.failCname = false;
    reader.txt.delete(`_dmarc.${fixture.domainName}`);

    reader.cname.delete(`_dmarc.${fixture.domainName}`);
    const noRecord = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(noRecord.body.hosted.status).toBe('RELEASING');
    expect(noRecord.body.hosted.releaseBlocked).toBe('no_record_published');

    reader.txt.set(`_dmarc.${fixture.domainName}`, 'v=DMARC1; p=none; rua=mailto:resumed@example.test');
    const released = await fixture.agent.post(`${base(fixture.organizationId, fixture.domainId)}/check`);
    expect(released.status).toBe(200);
    expect(released.body.hosted.status).toBe('RELEASED');
    expect(provider.records).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { action: 'HOSTED_DMARC_RELEASED' } })).toBe(1);
  });

  it('lists hosted records in the deletion preview and removes the provider record on delete', async () => {
    const fixture = await setup();
    const started = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    expect(provider.records).toHaveLength(1);

    const preview = await fixture.agent.get(`/api/workspaces/${fixture.organizationId}/deletion-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.hostedDmarc).toEqual([
      {
        domain: fixture.domainName,
        republish: {
          host: `_dmarc.${fixture.domainName}`,
          type: 'TXT',
          value: started.body.hosted.value,
        },
      },
    ]);

    const deleted = await fixture.agent.delete(
      `/api/workspaces/${fixture.organizationId}/domains/${fixture.domainId}`,
    );
    expect(deleted.status).toBe(200);
    expect(provider.records).toHaveLength(0);
  });

  it('removes the provider record when an erasure deletes the domain', async () => {
    const fixture = await setup();
    await start(fixture.agent, fixture.organizationId, fixture.domainId);
    expect(provider.records).toHaveLength(1);

    const request = await fixture.agent
      .post(`/api/workspaces/${fixture.organizationId}/erasures`)
      .send({ scope: 'DOMAIN', targetId: fixture.domainId });
    expect(request.status).toBe(202);

    const executed = await fixture.agent
      .post(`/api/workspaces/${fixture.organizationId}/erasures/${request.body.id}/execute`)
      .send({ confirmNamePurge: true });
    expect(executed.status).toBe(200);
    expect(provider.records).toHaveLength(0);
  });

  it('repairs a hand edit and removes only token-shaped orphans with our comment', async () => {
    const fixture = await setup();
    const started = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    const row = await prisma.hostedDmarcRecord.findUniqueOrThrow({ where: { domainId: fixture.domainId } });
    const hostedRecordId = provider.records[0]!.id;
    provider.records[0]!.content = 'v=DMARC1; p=reject';

    provider.records.push({
      id: 'orphan-1',
      name: `${'a'.repeat(16)}.${zone}`,
      content: 'v=DMARC1; p=none',
      comment: 'dmarc-harbor hosted orphan',
    });
    provider.records.push({
      id: 'other-1',
      name: 'ordinary.hosted.test',
      content: 'v=DMARC1; p=none',
      comment: 'dmarc-harbor hosted not-a-token',
    });
    provider.records.push({
      id: 'other-2',
      name: `${'b'.repeat(16)}.${zone}`,
      content: 'v=DMARC1; p=none',
      comment: 'not ours',
    });

    await runHostedDnsReconcileOnce();

    expect(provider.records.find((record) => record.id === hostedRecordId)?.content).toBe(row.value);
    expect(provider.records.some((record) => record.id === 'orphan-1')).toBe(false);
    expect(provider.records.some((record) => record.id === 'other-1')).toBe(true);
    expect(provider.records.some((record) => record.id === 'other-2')).toBe(true);
    expect(started.status).toBe(201);
  });

  it('refuses a new host once the capacity limit is reached', async () => {
    env.HOSTED_DNS_RECORD_LIMIT = 1;
    const fixture = await setup();
    const first = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    expect(first.status).toBe(201);
    const second = await addDomain(fixture, 'capacity');

    const refused = await start(fixture.agent, fixture.organizationId, second.id);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('HOSTED_DNS_FULL');
  });

  it('answers 404 for another workspace using this workspace domain id', async () => {
    const fixture = await setup();
    await start(fixture.agent, fixture.organizationId, fixture.domainId);

    fixtureId += 1;
    const second = await fixture.agent.post('/api/workspaces').send({
      name: 'Second Agency',
      slug: `second-agency-${Date.now()}-${fixtureId}`,
      tosAccepted: true,
      dpaHasRead: true,
      dpaConfirmsAuthority: true,
    });
    expect(second.status).toBe(201);
    const otherOrg = second.body.id as string;
    await grantPlan(otherOrg, 'FAIRWAY');

    for (const [method, path, body] of [
      ['get', base(otherOrg, fixture.domainId), undefined],
      ['post', base(otherOrg, fixture.domainId), undefined],
      ['post', `${base(otherOrg, fixture.domainId)}/check`, undefined],
      ['put', base(otherOrg, fixture.domainId), { expectedVersion: 1, policy: 'quarantine' }],
      ['post', `${base(otherOrg, fixture.domainId)}/release`, undefined],
    ] as const) {
      const response = await fixture.agent[method](path).send(body);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it('checks delegation at the end of a scan, and a failing check does not fail the scan', async () => {
    const fixture = await setup();
    const started = await start(fixture.agent, fixture.organizationId, fixture.domainId);
    reader.txt.set(`_dmarc.${fixture.domainName}`, 'v=DMARC1; p=none; rua=mailto:reports@example.test');
    reader.cname.set(`_dmarc.${fixture.domainName}`, started.body.hosted.cname.target);

    const scanned = await runDomainScan({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      requestedById: null,
      reader,
    });
    expect(scanned.status).toBe('completed');
    expect(
      (await prisma.hostedDmarcRecord.findUniqueOrThrow({ where: { domainId: fixture.domainId } })).status,
    ).toBe('ACTIVE');

    const failing = await setup();
    const failingStart = await start(failing.agent, failing.organizationId, failing.domainId);
    expect(failingStart.status).toBe(201);
    reader.txt.set(`_dmarc.${failing.domainName}`, 'v=DMARC1; p=none; rua=mailto:reports@example.test');
    reader.cname.set(`_dmarc.${failing.domainName}`, failingStart.body.hosted.cname.target);
    reader.cnameCalls = 0;
    reader.throwCnameAfter = 1;

    const scanSurvives = await runDomainScan({
      organizationId: failing.organizationId,
      domainId: failing.domainId,
      requestedById: null,
      reader,
    });
    expect(scanSurvives.status).toBe('completed');
    expect(
      (await prisma.hostedDmarcRecord.findUniqueOrThrow({ where: { domainId: failing.domainId } })).status,
    ).toBe('PENDING');
  });
});
