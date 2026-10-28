import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { createApiKey, hashApiKey, verifyApiKey } from '../src/services/api-key.service.js';
import { grantPlan } from './helpers/plan.js';
import { setOverride } from '../src/services/entitlements/entitlement.service.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup(plan: 'MOORING' | 'FAIRWAY' | 'HARBOR' | 'ADMIRALTY' = 'HARBOR') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `api-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'API Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({ name: 'API Agency', slug: `api-${Date.now()}-${fixtureId}`, tosAccepted: true, dpaHasRead: true, dpaConfirmsAuthority: true});
  const organizationId = workspace.body.id as string;
  if (plan !== 'MOORING') {
    await grantPlan(organizationId, plan);
  }

  const user = await prisma.user.findFirstOrThrow({ where: { members: { some: { organizationId } } }, select: { id: true } });
  const key = await createApiKey({ organizationId, name: 'Integration', scopes: ['read', 'write'], createdById: user.id });

  return { agent, organizationId, userId: user.id, key: key.key, keyId: key.id };
}

describe('api keys', () => {
  beforeAll(resetDatabase);

  it('issues a key that is only ever shown once and stored as a hash', async () => {
    const { agent, organizationId, key } = await setup();

    const stored = await prisma.apiKey.findUniqueOrThrow({ where: { id: (await prisma.apiKey.findFirstOrThrow({ where: { organizationId } })).id } });
    expect(stored.keyHash).toBe(hashApiKey(key));
    expect(stored.keyHash).not.toBe(key);

    const list = await agent.get(`/api/workspaces/${organizationId}/api-keys`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect(list.body.apiKeys[0].prefix).toBe(stored.prefix);
  });

  it('only the owner may create or revoke a key', async () => {
    const { organizationId, userId } = await setup();
    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'admin' } });
    await prisma.session.deleteMany({ where: { userId } });

    const email = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email;
    const admin = request.agent(app);
    expect((await admin.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

    expect(
      (await admin.post(`/api/workspaces/${organizationId}/api-keys`).send({ name: 'Sneaky key', scopes: ['read'] })).status,
    ).toBe(403);
  });

  it('refuses a revoked key immediately', async () => {
    const { agent, organizationId, key, keyId } = await setup();

    expect((await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${key}`)).status).toBe(200);

    const revoked = await agent.delete(`/api/workspaces/${organizationId}/api-keys/${keyId}`);
    expect(revoked.status).toBe(204);

    expect((await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${key}`)).status).toBe(401);
  });

  it('refuses a missing, malformed or unknown key', async () => {
    expect((await request(app).get('/api/v1/clients')).status).toBe(401);
    expect((await request(app).get('/api/v1/clients').set('Authorization', 'Bearer not-a-key')).status).toBe(401);
    expect(
      (await request(app).get('/api/v1/clients').set('Authorization', 'Basic something')).status,
    ).toBe(401);
  });

  it('keeps a read scoped key away from writes', async () => {
    const { organizationId, userId } = await setup();
    const readOnly = await createApiKey({ organizationId, name: 'Read only', scopes: ['read'], createdById: userId });

    expect((await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${readOnly.key}`)).status).toBe(200);
    expect(
      (
        await request(app)
          .post('/api/v1/clients')
          .set('Authorization', `Bearer ${readOnly.key}`)
          .send({ name: 'Should not exist' })
      ).status,
    ).toBe(403);

    expect(await prisma.client.count({ where: { organizationId } })).toBe(0);
  });

  it('records use of a key and can resolve it directly', async () => {
    const { key } = await setup();
    await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${key}`);

    const resolved = await verifyApiKey(key);
    expect(resolved).toBeTruthy();
    expect(resolved?.scopes).toEqual(['read', 'write']);
  });

  it('never exposes one workspace through another workspace key', async () => {
    const first = await setup();
    const second = await setup();

    await request(app).post('/api/v1/clients').set('Authorization', `Bearer ${first.key}`).send({ name: 'First only' });

    const seenBySecond = await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${second.key}`);
    expect(seenBySecond.status, JSON.stringify(seenBySecond.body)).toBe(200);
    expect(seenBySecond.body.clients).toHaveLength(0);

    const seenByFirst = await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${first.key}`);
    expect(seenByFirst.body.clients).toHaveLength(1);
  });
});

describe('bulk onboarding', () => {
  beforeAll(resetDatabase);

  it('imports many clients with their domains in one call', async () => {
    const { key, organizationId } = await setup();

    const response = await request(app)
      .post('/api/v1/clients/bulk')
      .set('Authorization', `Bearer ${key}`)
      .send({
        clients: [
          { name: 'Acme Corp', domains: ['acme.com', 'acme.co.uk'] },
          { name: 'Beta Ltd', domains: ['beta.com'] },
          { name: 'Gamma Inc', domains: ['gamma.com', 'gamma.io', 'gamma.net'] },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.created).toBe(3);
    expect(response.body.failed).toBe(0);
    expect(response.body.planBlocked).toBe(0);

    const acme = response.body.clients[0];
    expect(acme.slug).toBe('acme-corp');
    expect(acme.domains).toHaveLength(2);

    for (const domain of acme.domains) {
      expect(domain.verificationHost).toBe(`_dmarc-harbor-verification.${domain.name}`);
      expect(domain.verificationValue).toMatch(/^dmarc-harbor-verification=/);
    }

    expect(await prisma.domain.count({ where: { client: { organizationId } } })).toBe(6);
  });

  it('skips a bad row and still creates the rest', async () => {
    const { key } = await setup();

    const response = await request(app)
      .post('/api/v1/clients/bulk')
      .set('Authorization', `Bearer ${key}`)
      .send({
        clients: [
          { name: 'Valid One', domains: ['valid1.test'] },
          { name: '', domains: [] },
          { name: 'Bad Domain', domains: ['not a domain'] },
          { name: 'Valid Two', domains: ['valid2.test'] },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.created).toBe(2);
    expect(response.body.failed).toBe(2);
    expect(response.body.failures.map((entry: { reason: string }) => entry.reason).join(' ')).toContain('required');
    expect(response.body.failures.some((entry: { reason: string }) => entry.reason.includes('not a usable domain'))).toBe(true);
  });

  it('reports plan limits rather than silently truncating', async () => {
    const { key, organizationId } = await setup('MOORING');
    // The API itself is not on Mooring, so the test grants just that feature.
    // The one client quota that makes this test meaningful is untouched.
    await setOverride(organizationId, { entitlement: 'api.access', enabled: true, reason: 'Test grants API access on a quota-limited plan.' });

    const response = await request(app)
      .post('/api/v1/clients/bulk')
      .set('Authorization', `Bearer ${key}`)
      .send({
        clients: [
          { name: 'First', domains: ['one.test'] },
          { name: 'Second', domains: ['two.test'] },
          { name: 'Third', domains: ['three.test'] },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.created).toBe(1);
    expect(response.body.planBlocked).toBe(2);
    expect(response.body.planLimitRejections[0].reason).toContain('Mooring');
  });

  it('rejects a batch larger than the hard cap', async () => {
    const { key } = await setup('ADMIRALTY');
    const clients = Array.from({ length: 201 }, (_, index) => ({ name: `Client ${index}` }));

    const response = await request(app)
      .post('/api/v1/clients/bulk')
      .set('Authorization', `Bearer ${key}`)
      .send({ clients });

    expect(response.status).toBe(402);
    expect(response.body.error.limit).toBe(200);
  });

  it('adds many domains to one client', async () => {
    const { key, organizationId } = await setup();
    const client = await prisma.client.create({
      data: { organizationId, name: 'Bulk Client', slug: 'bulk-client' },
      select: { id: true },
    });

    const response = await request(app)
      .post('/api/v1/domains/bulk')
      .set('Authorization', `Bearer ${key}`)
      .send({ clientId: client.id, domains: ['a.test', 'b.test', 'c.test', 'a.test'] });

    expect(response.status).toBe(201);
    expect(response.body.created).toBe(3);
    expect(response.body.failed).toBe(1);
    expect(response.body.failures[0].reason).toContain('already in this workspace');
  });

  it('refuses a client id from another workspace', async () => {
    const first = await setup();
    const second = await setup();

    const client = await prisma.client.create({
      data: { organizationId: first.organizationId, name: 'Foreign', slug: 'foreign' },
      select: { id: true },
    });

    const response = await request(app)
      .post('/api/v1/domains/bulk')
      .set('Authorization', `Bearer ${second.key}`)
      .send({ clientId: client.id, domains: ['x.test'] });

    expect(response.status).toBe(402);
    expect(await prisma.domain.count({ where: { name: 'x.test' } })).toBe(0);
  });

  it('replays a retried request instead of creating duplicates', async () => {
    const { key, organizationId } = await setup();
    const payload = { clients: [{ name: 'Idempotent Co', domains: ['idem.test'] }] };

    const first = await request(app)
      .post('/api/v1/clients/bulk')
      .set('Authorization', `Bearer ${key}`)
      .set('Idempotency-Key', 'ticket-4711')
      .send(payload);

    expect(first.status).toBe(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();

    const retry = await request(app)
      .post('/api/v1/clients/bulk')
      .set('Authorization', `Bearer ${key}`)
      .set('Idempotency-Key', 'ticket-4711')
      .send(payload);

    expect(retry.status).toBe(201);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect(retry.body.created).toBe(1);

    expect(await prisma.client.count({ where: { organizationId } })).toBe(1);
    expect(await prisma.domain.count({ where: { name: 'idem.test' } })).toBe(1);
  });

  it('records bulk imports in the audit trail', async () => {
    const { key, organizationId } = await setup();

    await request(app)
      .post('/api/v1/clients/bulk')
      .set('Authorization', `Bearer ${key}`)
      .send({ clients: [{ name: 'Audited Co', domains: ['audited.test'] }] });

    const events = await prisma.auditLog.findMany({ where: { organizationId, action: 'CLIENTS_BULK_IMPORTED' } });
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ created: 1, failed: 0, domains: 1 });
  });

  it('normalises a domain that was pasted with a scheme or a path', async () => {
    const { key, organizationId } = await setup();
    const client = await prisma.client.create({
      data: { organizationId, name: 'Normalise', slug: 'normalise' },
      select: { id: true },
    });

    const response = await request(app)
      .post('/api/v1/domains/bulk')
      .set('Authorization', `Bearer ${key}`)
      .send({ clientId: client.id, domains: ['https://HTTPS.Example.COM/mail', 'other.test'] });

    expect(response.body.created).toBe(2);
    expect(response.body.domains.map((entry: { name: string }) => entry.name)).toEqual([
      'https.example.com',
      'other.test',
    ]);
  });
});

// ─── Item 16: the wider v1 surface ───────────────────────────────────────────

/**
 * A verified domain with one scan, one report, one open alert and one DNS
 * change, so each new route has something to return.
 *
 * Built directly through Prisma rather than through the browser routes: the
 * point of these tests is the public API's answers, and driving four browser
 * endpoints to set up each case would make a failure here ambiguous.
 */
async function setupDomainWithEvidence(plan: 'MOORING' | 'HARBOR' = 'HARBOR') {
  const base = await setup(plan);
  fixtureId += 1;

  const client = await prisma.client.create({
    data: { organizationId: base.organizationId, name: 'Evidence Client', slug: `evidence-${fixtureId}` },
    select: { id: true },
  });

  const domain = await prisma.domain.create({
    data: {
      clientId: client.id,
      name: `evidence-${fixtureId}.test`,
      slug: `evidence-${fixtureId}-abc`,
      status: 'VERIFIED',
      verifiedAt: new Date(),
      dmarcPolicy: 'none',
      dmarcRecord: 'v=DMARC1; p=none',
      spfRecord: 'v=spf1 -all',
      mxRecords: ['mx1.example.test'],
      dkimSelectors: ['default'],
      score: 72,
      lastScanAt: new Date(),
    },
    select: { id: true, name: true, slug: true },
  });

  const scan = await prisma.scan.create({
    data: {
      domainId: domain.id,
      status: 'COMPLETED',
      trigger: 'MANUAL',
      score: 72,
      startedAt: new Date(Date.now() - 60_000),
      completedAt: new Date(),
    },
    select: { id: true },
  });

  const report = await prisma.dmarcReport.create({
    data: {
      domainId: domain.id,
      reportType: 'AGGREGATE',
      fingerprint: `fp-${fixtureId}-${Date.now()}`,
      reportId: `google-${fixtureId}`,
      reportingOrganization: 'google.com',
      dateRangeBegin: new Date(Date.now() - 86_400_000),
      dateRangeEnd: new Date(),
      recordCount: 2,
      records: {
        create: [
          { sourceIp: '203.0.113.7', messageCount: 90, dkimResult: 'pass', spfResult: 'fail' },
          { sourceIp: '203.0.113.8', messageCount: 10, dkimResult: 'fail', spfResult: 'fail' },
        ],
      },
    },
    select: { id: true },
  });

  const rule = await prisma.alertRule.create({
    data: {
      organizationId: base.organizationId,
      domainId: domain.id,
      name: 'Failures above 100',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 100,
      windowMinutes: 1440,
      cooldownMinutes: 60,
      maxReminderLevel: 3,
    },
    select: { id: true },
  });

  const alert = await prisma.alertEvent.create({
    data: {
      ruleId: rule.id,
      organizationId: base.organizationId,
      domainId: domain.id,
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      observedValue: 500,
      threshold: 100,
      windowMinutes: 1440,
      summary: '500 messages failed DMARC in the last 1440 minutes',
    },
    select: { id: true },
  });

  const change = await prisma.dnsChange.create({
    data: {
      organizationId: base.organizationId,
      domainId: domain.id,
      scanId: scan.id,
      kind: 'SPF_RECORD',
      severity: 'CRITICAL',
      code: 'SPF_REMOVED',
      summary: 'SPF record removed',
    },
    select: { id: true },
  });

  return { ...base, clientId: client.id, domainId: domain.id, domainName: domain.name, domainSlug: domain.slug, scanId: scan.id, reportId: report.id, alertId: alert.id, changeId: change.id };
}

describe('v1: /me', () => {
  beforeAll(resetDatabase);

  it('answers with the workspace, the plan and this key', async () => {
    const { key, organizationId, keyId } = await setup();

    const response = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${key}`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.workspace.id).toBe(organizationId);
    expect(response.body.plan.tier).toBe('HARBOR');
    expect(response.body.plan.label).toBeTruthy();
    expect(response.body.features['api.access']).toBe(true);
    expect(response.body.key.id).toBe(keyId);
    expect(response.body.key.scopes).toEqual(['read', 'write']);
    // The key itself is never in a response, not even hashed.
    expect(JSON.stringify(response.body)).not.toContain(key);
  });

  it('works for a key even when the workspace requires MFA and has an outdated agreement', async () => {
    const { key, organizationId } = await setup();

    /**
     * The three middlewares that run for every /api request — the workspace MFA
     * requirement, the workspace rate limiter and the DPA gate — were written
     * for session routes. A bearer key has no session and no workspace in its
     * path, and none of them may turn that into a refusal: an integration cannot
     * complete a second factor, and it never agreed to the DPA in a browser.
     */
    await prisma.organization.update({
      where: { id: organizationId },
      data: {
        requireMfa: true,
        dpaAcceptedAt: new Date('2020-01-01T00:00:00Z'),
        dpaVersion: '0.1-outdated',
      },
    });

    const response = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${key}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    // And the same key can still write, not merely read its own identity.
    const write = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${key}`)
      .send({ name: 'MFA Workspace Client' });
    expect(write.status, JSON.stringify(write.body)).toBe(201);
  });

  it('refuses a missing key and a key without the api.access feature', async () => {
    expect((await request(app).get('/api/v1/me')).status).toBe(401);

    const { key, organizationId } = await setup('MOORING');
    // Mooring does not carry the API at all.
    expect((await request(app).get('/api/v1/me').set('Authorization', `Bearer ${key}`)).status).toBe(402);
    expect(organizationId).toBeTruthy();
  });
});

describe('v1: one domain and its evidence', () => {
  beforeAll(resetDatabase);

  it('returns a domain by id and by slug', async () => {
    const fixture = await setupDomainWithEvidence();

    const byId = await request(app)
      .get(`/api/v1/domains/${fixture.domainId}`)
      .set('Authorization', `Bearer ${fixture.key}`);
    expect(byId.status, JSON.stringify(byId.body)).toBe(200);
    expect(byId.body.domain.name).toBe(fixture.domainName);
    expect(byId.body.domain.mxRecords).toEqual(['mx1.example.test']);
    expect(byId.body.domain.dkimSelectors).toEqual(['default']);
    expect(byId.body.domain.lastScanAt).toBeTruthy();

    const bySlug = await request(app)
      .get(`/api/v1/domains/${fixture.domainSlug}`)
      .set('Authorization', `Bearer ${fixture.key}`);
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.domain.id).toBe(fixture.domainId);
  });

  it('answers 404 for another workspace domain, identically to one that does not exist', async () => {
    const mine = await setupDomainWithEvidence();
    const theirs = await setupDomainWithEvidence();

    const foreign = await request(app)
      .get(`/api/v1/domains/${mine.domainId}`)
      .set('Authorization', `Bearer ${theirs.key}`);
    const missing = await request(app)
      .get('/api/v1/domains/does-not-exist')
      .set('Authorization', `Bearer ${theirs.key}`);

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    // The same body, so the response cannot be used to discover what exists.
    expect(foreign.body.error.code).toBe(missing.body.error.code);
    expect(foreign.body.error.message).toBe(missing.body.error.message);
  });

  it('pages the scan history with a cursor', async () => {
    const fixture = await setupDomainWithEvidence();
    // Older than the fixture's scan, so the first page is the one that recorded
    // a DNS change and `changeCount` is a real assertion rather than a zero.
    await prisma.scan.create({
      data: {
        domainId: fixture.domainId,
        status: 'COMPLETED',
        trigger: 'SCHEDULED',
        startedAt: new Date(Date.now() - 3_600_000),
      },
    });

    const first = await request(app)
      .get(`/api/v1/domains/${fixture.domainId}/scans?limit=1`)
      .set('Authorization', `Bearer ${fixture.key}`);

    expect(first.status).toBe(200);
    expect(first.body.scans).toHaveLength(1);
    expect(first.body.nextCursor).toBeTruthy();
    expect(first.body.scans[0].changeCount).toBe(1);

    const second = await request(app)
      .get(`/api/v1/domains/${fixture.domainId}/scans?limit=1&cursor=${first.body.nextCursor}`)
      .set('Authorization', `Bearer ${fixture.key}`);

    expect(second.status).toBe(200);
    expect(second.body.scans).toHaveLength(1);
    expect(second.body.scans[0].id).not.toBe(first.body.scans[0].id);
    expect(second.body.nextCursor).toBeNull();
  });

  it('starts a scan and replays the same one for a repeated idempotency key', async () => {
    const fixture = await setupDomainWithEvidence();

    const first = await request(app)
      .post(`/api/v1/domains/${fixture.domainId}/scans`)
      .set('Authorization', `Bearer ${fixture.key}`)
      .set('Idempotency-Key', 'scan-once');

    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body.scan.id).toBeTruthy();

    const replay = await request(app)
      .post(`/api/v1/domains/${fixture.domainId}/scans`)
      .set('Authorization', `Bearer ${fixture.key}`)
      .set('Idempotency-Key', 'scan-once');

    expect(replay.status).toBe(202);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body.scan.id).toBe(first.body.scan.id);
  });

  it('reports the report headers with counts and no source addresses', async () => {
    const fixture = await setupDomainWithEvidence();

    const response = await request(app)
      .get(`/api/v1/domains/${fixture.domainId}/reports`)
      .set('Authorization', `Bearer ${fixture.key}`);

    expect(response.status).toBe(200);
    expect(response.body.reports).toHaveLength(1);
    const report = response.body.reports[0];
    expect(report.reportingOrganization).toBe('google.com');
    expect(report.messageCount).toBe(100);
    expect(report.passedMessages).toBe(90);
    expect(report.failedMessages).toBe(10);
    // The list is deliberately free of row-level data.
    expect(JSON.stringify(response.body)).not.toContain('203.0.113');
  });

  it('returns the sender breakdown', async () => {
    const fixture = await setupDomainWithEvidence();

    const response = await request(app)
      .get(`/api/v1/domains/${fixture.domainId}/senders`)
      .set('Authorization', `Bearer ${fixture.key}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.senders)).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('203.0.113');
  });

  it('returns policy readiness', async () => {
    const fixture = await setupDomainWithEvidence();

    const response = await request(app)
      .get(`/api/v1/domains/${fixture.domainId}/policy-readiness`)
      .set('Authorization', `Bearer ${fixture.key}`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toBeTruthy();
  });

  it('returns the TLS summary, and 402 without the feature', async () => {
    const fixture = await setupDomainWithEvidence();

    const response = await request(app)
      .get(`/api/v1/domains/${fixture.domainId}/tls-reports/summary`)
      .set('Authorization', `Bearer ${fixture.key}`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.days).toBe(30);
    expect(typeof response.body.reportCount).toBe('number');

    // Mooring has no TLS-RPT licence. Grant only the API itself, so the refusal
    // is provably about the feature and not about access to the API.
    const limited = await setupDomainWithEvidence('MOORING');
    await setOverride(limited.organizationId, {
      entitlement: 'api.access',
      enabled: true,
      reason: 'Test grants API access so the TLS-RPT refusal is the one being measured.',
    });

    const refused = await request(app)
      .get(`/api/v1/domains/${limited.domainId}/tls-reports/summary`)
      .set('Authorization', `Bearer ${limited.key}`);
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
  });
});

describe('v1: alerts and DNS changes', () => {
  beforeAll(resetDatabase);

  it('lists open alerts and filters by state', async () => {
    const fixture = await setupDomainWithEvidence();

    const open = await request(app)
      .get('/api/v1/alerts?state=open')
      .set('Authorization', `Bearer ${fixture.key}`);

    expect(open.status).toBe(200);
    expect(open.body.alerts).toHaveLength(1);
    expect(open.body.alerts[0].state).toBe('open');
    expect(open.body.alerts[0].domain.id).toBe(fixture.domainId);

    const resolved = await request(app)
      .get('/api/v1/alerts?state=resolved')
      .set('Authorization', `Bearer ${fixture.key}`);
    expect(resolved.body.alerts).toHaveLength(0);

    const bad = await request(app)
      .get('/api/v1/alerts?state=nonsense')
      .set('Authorization', `Bearer ${fixture.key}`);
    expect(bad.status).toBe(400);

    // A domain filter that matches nothing here is a 404, never every alert.
    const typo = await request(app)
      .get('/api/v1/alerts?domain=no-such-domain.example')
      .set('Authorization', `Bearer ${fixture.key}`);
    expect(typo.status).toBe(404);

    const filtered = await request(app)
      .get(`/api/v1/alerts?domain=${fixture.domainId}`)
      .set('Authorization', `Bearer ${fixture.key}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.alerts).toHaveLength(1);
  });

  it('acknowledges an alert as the key, records the key, and refuses a second time', async () => {
    const fixture = await setupDomainWithEvidence();

    // A PSA connection and a queued ticket, so the note has somewhere to go.
    const connection = await prisma.psaConnection.create({
      data: {
        organizationId: fixture.organizationId,
        provider: 'HALOPSA',
        encryptedCredentials: 'not-a-real-credential',
        credentialHint: 'halo.example.test …abcd',
        baseUrl: 'https://halo.example.test',
      },
      select: { id: true },
    });
    await prisma.psaTicketJob.create({
      data: {
        organizationId: fixture.organizationId,
        connectionId: connection.id,
        kind: 'OPEN',
        dedupeKey: `alert:${fixture.alertId}:open`,
        linkReference: 'ref00001',
        payload: { title: 'DMARC Harbor: evidence.test' },
        status: 'DONE',
      },
    });

    const response = await request(app)
      .post(`/api/v1/alerts/${fixture.alertId}/acknowledge`)
      .set('Authorization', `Bearer ${fixture.key}`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.alert.state).toBe('acknowledged');
    expect(response.body.alert.acknowledgedAt).toBeTruthy();

    // The actor is the key, and the audit says which one.
    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: fixture.organizationId, action: 'ALERT_ACKNOWLEDGED' },
    });
    expect(audit).toBeTruthy();
    expect(audit?.detail).toMatchObject({ apiKeyId: fixture.keyId });
    expect(audit?.actorUserId).toBeNull();

    // The PSA ticket learns about it, in words that do not invent a person.
    const note = await prisma.psaTicketJob.findUnique({
      where: { dedupeKey: `alert:${fixture.alertId}:note:ack` },
    });
    expect(note).toBeTruthy();
    expect(JSON.stringify(note?.payload)).toContain('through the API');

    const again = await request(app)
      .post(`/api/v1/alerts/${fixture.alertId}/acknowledge`)
      .set('Authorization', `Bearer ${fixture.key}`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
  });

  it('refuses an alert from another workspace as not found', async () => {
    const mine = await setupDomainWithEvidence();
    const theirs = await setupDomainWithEvidence();

    const response = await request(app)
      .post(`/api/v1/alerts/${mine.alertId}/acknowledge`)
      .set('Authorization', `Bearer ${theirs.key}`);

    expect(response.status).toBe(404);
    const untouched = await prisma.alertEvent.findUniqueOrThrow({ where: { id: mine.alertId } });
    expect(untouched.acknowledgedAt).toBeNull();
  });

  it('lists DNS changes with severity and acknowledgement filters, and pages them', async () => {
    const fixture = await setupDomainWithEvidence();
    await prisma.dnsChange.create({
      data: {
        organizationId: fixture.organizationId,
        domainId: fixture.domainId,
        scanId: fixture.scanId,
        kind: 'DMARC_RECORD',
        severity: 'WARNING',
        code: 'DMARC_CHANGED',
        summary: 'DMARC record changed',
      },
    });

    const critical = await request(app)
      .get('/api/v1/dns-changes?severity=CRITICAL')
      .set('Authorization', `Bearer ${fixture.key}`);
    expect(critical.status).toBe(200);
    expect(critical.body.changes).toHaveLength(1);
    expect(critical.body.changes[0].severity).toBe('CRITICAL');

    const unacknowledged = await request(app)
      .get('/api/v1/dns-changes?acknowledged=false&limit=1')
      .set('Authorization', `Bearer ${fixture.key}`);
    expect(unacknowledged.body.changes).toHaveLength(1);
    expect(unacknowledged.body.nextCursor).toBeTruthy();

    const page2 = await request(app)
      .get(`/api/v1/dns-changes?acknowledged=false&limit=1&cursor=${unacknowledged.body.nextCursor}`)
      .set('Authorization', `Bearer ${fixture.key}`);
    expect(page2.body.changes).toHaveLength(1);
    expect(page2.body.changes[0].id).not.toBe(unacknowledged.body.changes[0].id);

    const bad = await request(app)
      .get('/api/v1/dns-changes?acknowledged=maybe')
      .set('Authorization', `Bearer ${fixture.key}`);
    expect(bad.status).toBe(400);
  });

  it('acknowledges a DNS change as the key and records which key', async () => {
    const fixture = await setupDomainWithEvidence();

    const response = await request(app)
      .post(`/api/v1/dns-changes/${fixture.changeId}/acknowledge`)
      .set('Authorization', `Bearer ${fixture.key}`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.change.acknowledgedAt).toBeTruthy();
    // No person did this, so the field is null rather than a made-up member.
    expect(response.body.change.acknowledgedBy).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: fixture.organizationId, action: 'DNS_CHANGE_ACKNOWLEDGED' },
    });
    expect(audit?.detail).toMatchObject({ apiKeyId: fixture.keyId });
  });

  it('keeps a read-scoped key away from the acknowledging routes', async () => {
    const fixture = await setupDomainWithEvidence();
    const readOnly = await createApiKey({
      organizationId: fixture.organizationId,
      name: 'Read only',
      scopes: ['read'],
      createdById: fixture.userId,
    });

    expect(
      (
        await request(app)
          .post(`/api/v1/alerts/${fixture.alertId}/acknowledge`)
          .set('Authorization', `Bearer ${readOnly.key}`)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/v1/dns-changes/${fixture.changeId}/acknowledge`)
          .set('Authorization', `Bearer ${readOnly.key}`)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/v1/domains/${fixture.domainId}/scans`)
          .set('Authorization', `Bearer ${readOnly.key}`)
      ).status,
    ).toBe(403);
  });

  it('requires a key on every new route', async () => {
    const fixture = await setupDomainWithEvidence();

    for (const path of [
      '/api/v1/me',
      '/api/v1/domains/x',
      '/api/v1/domains/x/scans',
      '/api/v1/domains/x/reports',
      '/api/v1/domains/x/senders',
      '/api/v1/domains/x/policy-readiness',
      '/api/v1/domains/x/tls-reports/summary',
      '/api/v1/alerts',
      '/api/v1/dns-changes',
    ]) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(401);
    }

    expect(
      (await request(app).post(`/api/v1/domains/${fixture.domainId}/scans`)).status,
    ).toBe(401);
    expect((await request(app).post(`/api/v1/alerts/${fixture.alertId}/acknowledge`)).status).toBe(401);
    expect((await request(app).post(`/api/v1/dns-changes/${fixture.changeId}/acknowledge`)).status).toBe(401);
  });
});

describe('v1: idempotency on the single-write routes', () => {
  beforeAll(resetDatabase);

  it('replays POST /clients and refuses the same key with a different body', async () => {
    const { key, organizationId } = await setup();

    const first = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${key}`)
      .set('Idempotency-Key', 'client-once')
      .send({ name: 'Once Only' });

    expect(first.status).toBe(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();

    const replay = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${key}`)
      .set('Idempotency-Key', 'client-once')
      .send({ name: 'Once Only' });

    expect(replay.status).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    expect(await prisma.client.count({ where: { organizationId } })).toBe(1);

    const different = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${key}`)
      .set('Idempotency-Key', 'client-once')
      .send({ name: 'Something Else' });

    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await prisma.client.count({ where: { organizationId } })).toBe(1);
  });
});
