import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import type { PlanTier } from '@prisma/client';
import { setSpfUsageReaderForTests } from '../src/services/spf-usage.service.js';
import type { DnsReader, LookupResult, MxRecord } from '../src/scanner/types.js';
import { grantPlan } from './helpers/plan.js';

/**
 * Which SPF sources carried mail.
 *
 * Each source of the record is resolved to networks and matched against the
 * sending addresses in the domain's reports. Unused is only said with enough
 * reports behind it; a source whose networks cannot be known is unresolved;
 * a managed domain is answered from what is stored, with no DNS.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const day = 24 * 60 * 60 * 1000;

class FakeDns implements DnsReader {
  txt = new Map<string, string[]>();
  txtErrors = new Set<string>();
  calls = 0;

  async resolveTxt(name: string): Promise<LookupResult<string[][]>> {
    this.calls += 1;
    if (this.txtErrors.has(name)) return { status: 'error', error: 'resolver unavailable' };
    const records = this.txt.get(name);
    return records === undefined ? { status: 'missing' } : { status: 'found', value: records.map((record) => [record]) };
  }

  async resolveAddress(): Promise<LookupResult<string[]>> {
    this.calls += 1;
    return { status: 'missing' };
  }

  async resolveMx(): Promise<LookupResult<MxRecord[]>> {
    this.calls += 1;
    return { status: 'missing' };
  }
}

let reader: FakeDns;

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "hosted_spf_change", "hosted_spf_record", "rate_limit_bucket", "entitlement_override", "subscription", "audit_log", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

beforeEach(async () => {
  await resetDatabase();
  reader = new FakeDns();
  setSpfUsageReaderForTests(reader);
});

afterEach(() => setSpfUsageReaderForTests(null));

/** Fairway by default: the first plan with the check. null leaves the free plan. */
async function workspace(label: string, plan: PlanTier | null = 'FAIRWAY') {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const created = await agent.post('/api/workspaces').send({
    name: `${label} Agency`,
    slug: `${label}-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status).toBe(201);
  const organizationId = created.body.id as string;
  if (plan) await grantPlan(organizationId, plan);
  return { agent, organizationId };
}

async function domainIn(organizationId: string) {
  fixtureId += 1;
  const client = await prisma.client.create({
    data: { organizationId, name: `Client ${fixtureId}`, slug: `c-${fixtureId}-${Date.now()}` },
  });
  return prisma.domain.create({
    data: {
      clientId: client.id,
      name: `spf-${fixtureId}-${Date.now()}.test`,
      slug: `spf-${fixtureId}-${Date.now()}`,
      status: 'VERIFIED',
      verifiedAt: new Date(),
    },
  });
}

/** One report per day for `days` days, each carrying the same records. */
async function reportsOver(
  domainId: string,
  days: number,
  records: Array<{ ip: string; count: number; spfPass: boolean }>,
) {
  for (let index = 0; index < days; index += 1) {
    fixtureId += 1;
    const begin = new Date(Date.now() - (index + 1) * day);
    await prisma.dmarcReport.create({
      data: {
        domainId,
        reportType: 'AGGREGATE',
        fingerprint: `spf-usage-${fixtureId}-${Date.now()}`,
        dateRangeBegin: begin,
        dateRangeEnd: new Date(begin.getTime() + day - 1),
        records: {
          create: records.map((record) => ({
            sourceIp: record.ip,
            messageCount: record.count,
            dkimResult: 'fail',
            spfResult: record.spfPass ? 'pass' : 'fail',
          })),
        },
      },
    });
  }
}

function publish(domain: string): void {
  reader.txt.set(domain, [
    'v=spf1 include:_spf.mail.test include:oldesp.test include:dynamic.test ip4:8.8.8.0/24 ~all',
  ]);
  reader.txt.set('_spf.mail.test', ['v=spf1 ip4:198.51.100.0/24 -all']);
  reader.txt.set('oldesp.test', ['v=spf1 include:inner.oldesp.test -all']);
  reader.txt.set('inner.oldesp.test', ['v=spf1 ip4:203.0.113.0/24 -all']);
  reader.txt.set('dynamic.test', ['v=spf1 exists:%{i}.dyn.test -all']);
}

const traffic = [
  { ip: '198.51.100.7', count: 10, spfPass: true },
  { ip: '8.8.8.8', count: 1, spfPass: false },
  { ip: '192.0.2.1', count: 2, spfPass: false },
];

describe('SPF source usage', () => {
  it('marks each published source used, unused or unresolved, with the lookups it costs', async () => {
    const owner = await workspace('spf-used');
    const domain = await domainIn(owner.organizationId);
    publish(domain.name);
    await reportsOver(domain.id, 14, traffic);

    const response = await owner.agent.get(`/api/workspaces/${owner.organizationId}/domains/${domain.slug}/spf-usage`);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.body;
    expect(body.origin).toBe('published');
    expect(body.problem).toBeNull();
    expect(body.windowDays).toBe(90);
    expect(body.evidence).toEqual({ reportDays: 14, messages: 14 * 13, ips: 3, enough: true });
    expect(body.lookupCount).toBe(5);

    const byTerm = Object.fromEntries(body.sources.map((source: { term: string }) => [source.term, source]));
    expect(byTerm['include:_spf.mail.test']).toMatchObject({
      status: 'used',
      messages: 140,
      spfPassMessages: 140,
      matchedIps: 1,
      lookups: 1,
    });
    expect(byTerm['include:oldesp.test']).toMatchObject({ status: 'unused', messages: 0, lookups: 2, networkCount: 1 });
    expect(byTerm['include:dynamic.test'].status).toBe('unresolved');
    expect(byTerm['include:dynamic.test'].reason).toEqual(expect.any(String));
    expect(byTerm['ip4:8.8.8.0/24']).toMatchObject({ status: 'used', messages: 14, lookups: 0 });
    expect(body.uncovered).toEqual({ messages: 28, ips: 1 });
  });

  it('does not call anything unused on too few days of reports', async () => {
    const owner = await workspace('spf-early');
    const domain = await domainIn(owner.organizationId);
    publish(domain.name);
    await reportsOver(domain.id, 3, traffic);

    const body = (await owner.agent.get(`/api/workspaces/${owner.organizationId}/domains/${domain.id}/spf-usage`)).body;
    expect(body.evidence.enough).toBe(false);
    const statuses = body.sources.map((source: { status: string }) => source.status);
    expect(statuses).not.toContain('unused');
    expect(statuses).toContain('insufficient_data');
    expect(statuses).toContain('used');
  });

  it('says why when there is nothing to analyse', async () => {
    const owner = await workspace('spf-none');
    const missing = await domainIn(owner.organizationId);
    const none = (await owner.agent.get(`/api/workspaces/${owner.organizationId}/domains/${missing.id}/spf-usage`)).body;
    expect(none).toMatchObject({ origin: null, record: null, sources: [] });
    expect(none.problem).toContain('publishes no SPF record');

    const broken = await domainIn(owner.organizationId);
    reader.txtErrors.add(broken.name);
    const failed = (await owner.agent.get(`/api/workspaces/${owner.organizationId}/domains/${broken.id}/spf-usage`)).body;
    expect(failed.problem).toContain('DNS error');
  });

  it('reads a managed domain from its stored sources, with no DNS', async () => {
    const owner = await workspace('spf-managed');
    const domain = await domainIn(owner.organizationId);
    await prisma.hostedSpfRecord.create({
      data: {
        organizationId: owner.organizationId,
        domainId: domain.id,
        token: `tok-${Date.now()}-${fixtureId}`,
        status: 'ACTIVE',
        sources: [
          { kind: 'include', value: '_spf.mail.test' },
          { kind: 'include', value: 'oldesp.test' },
        ],
        allQualifier: '-all',
        sourceState: {
          'include:_spf.mail.test': { networks: ['198.51.100.0/24'], mode: 'flattened', lookups: 0, reason: null },
          'include:oldesp.test': { networks: ['203.0.113.0/24'], mode: 'flattened', lookups: 0, reason: null },
        },
        parts: [],
        lookupCount: 1,
      },
    });
    await reportsOver(domain.id, 14, [{ ip: '198.51.100.9', count: 4, spfPass: true }]);

    const body = (await owner.agent.get(`/api/workspaces/${owner.organizationId}/domains/${domain.id}/spf-usage`)).body;
    expect(body.origin).toBe('managed');
    expect(body.record).toBe('v=spf1 include:_spf.mail.test include:oldesp.test -all');
    expect(body.lookupCount).toBeNull();
    expect(body.sources.map((source: { term: string; status: string }) => [source.term, source.status])).toEqual([
      ['include:_spf.mail.test', 'used'],
      ['include:oldesp.test', 'unused'],
    ]);
    expect(reader.calls).toBe(0);
  });

  it('is refused on the free plan before any DNS is read', async () => {
    const free = await workspace('spf-free', null);
    const domain = await domainIn(free.organizationId);
    publish(domain.name);

    const refused = await free.agent.get(`/api/workspaces/${free.organizationId}/domains/${domain.id}/spf-usage`);
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    expect(refused.body.error.feature).toBe('dns.spfUsage');
    expect(refused.body.error.requiredIn).toBe('FAIRWAY');
    expect(reader.calls).toBe(0);
  });

  it('stays inside the workspace', async () => {
    const owner = await workspace('spf-mine');
    const other = await workspace('spf-other');
    const domain = await domainIn(owner.organizationId);
    expect((await other.agent.get(`/api/workspaces/${owner.organizationId}/domains/${domain.id}/spf-usage`)).status).toBe(403);
    expect((await other.agent.get(`/api/workspaces/${other.organizationId}/domains/${domain.id}/spf-usage`)).status).toBe(404);
  });
});
