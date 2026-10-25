import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DnsReader, LookupResult, MxRecord } from '../src/scanner/types.js';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { env } from '../src/config/env.js';
import { buildExportPayload } from '../src/services/export/export.service.js';
import { purgeExpiredData } from '../src/services/retention.service.js';
import { buildDomainSnapshot, evaluateRule, getAlertRule } from '../src/services/alert.service.js';
import { runSenderIntelPass } from '../src/services/senders/ip-intel.service.js';
import { grantPlan } from './helpers/plan.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const now = new Date('2026-10-28T12:00:00.000Z');

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "sender_review", "source_ip_intel", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "dns_change", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

function fakeReader(state: {
  ptr?: Record<string, string[]>;
  addresses?: Record<string, string[]>;
  asn?: Record<string, { origin: string; name?: string }>;
  fail?: boolean;
  onPtr?: (ip: string) => void;
}): DnsReader {
  return {
    async resolveTxt(name: string): Promise<LookupResult<string[][]>> {
      if (state.fail) return { status: 'error', error: 'resolver unavailable' };
      if (name.endsWith('.origin.asn.cymru.com')) {
        const ip = name
          .replace(/\.origin\.asn\.cymru\.com$/, '')
          .split('.')
          .reverse()
          .join('.');
        const found = state.asn?.[ip];
        return found ? { status: 'found', value: [[found.origin]] } : { status: 'missing' };
      }
      if (name.endsWith('.origin6.asn.cymru.com')) {
        return { status: 'missing' };
      }
      if (name === 'AS15169.asn.cymru.com') {
        return { status: 'found', value: [['15169 | US | arin | 2000-03-30 | GOOGLE, US']] };
      }
      return { status: 'missing' };
    },
    async resolveMx(): Promise<LookupResult<MxRecord[]>> {
      return { status: 'missing' };
    },
    async resolvePtr(ip: string): Promise<LookupResult<string[]>> {
      state.onPtr?.(ip);
      const names = state.ptr?.[ip];
      return names ? { status: 'found', value: names } : { status: 'missing' };
    },
    async resolveAddress(name: string): Promise<LookupResult<string[]>> {
      const addresses = state.addresses?.[name];
      return addresses ? { status: 'found', value: addresses } : { status: 'missing' };
    },
  };
}

async function setup(plan: 'MOORING' | 'HARBOR' = 'HARBOR') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `sender-intel-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Sender Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Sender Intelligence Agency',
    slug: `sender-intel-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;
  if (plan !== 'MOORING') await grantPlan(organizationId, 'HARBOR');

  const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name: 'Sender Client',
    slug: `sender-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);
  const domain = await agent.post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`).send({
    name: `sender-${Date.now()}-${fixtureId}.test`,
  });
  expect(domain.status).toBe(201);
  await prisma.domain.update({
    where: { id: domain.body.id },
    data: { status: 'VERIFIED', verifiedAt: now, dmarcPolicy: 'none' },
  });

  return {
    agent,
    organizationId,
    clientId: client.body.id as string,
    domainId: domain.body.id as string,
    domainName: domain.body.name as string,
    ownerEmail: email,
  };
}

async function seedSender(input: {
  domainId: string;
  senderDomain: string;
  ip?: string;
  messages?: number;
  dkim?: string;
  spf?: string;
  dkimDomain?: string;
  spfDomain?: string;
  receivedAt?: Date;
}) {
  fixtureId += 1;
  const ip = input.ip ?? '8.8.8.8';
  const senderDomain = input.senderDomain;
  return prisma.dmarcReport.create({
    data: {
      domainId: input.domainId,
      reportType: 'AGGREGATE',
      fingerprint: `sender-intel-${fixtureId}-${Date.now()}`,
      reportingOrganization: 'Google LLC',
      dateRangeBegin: new Date('2026-10-27T00:00:00Z'),
      dateRangeEnd: new Date('2026-10-27T23:59:59Z'),
      receivedAt: input.receivedAt ?? now,
      records: {
        create: [
          {
            sourceIp: ip,
            messageCount: input.messages ?? 100,
            senderDomain,
            senderKey: senderDomain,
            dkimResult: input.dkim ?? 'pass',
            spfResult: input.spf ?? 'pass',
            authResults: {
              create: [
                {
                  type: 'DKIM',
                  domain: input.dkimDomain ?? senderDomain,
                  result: input.dkim ?? 'pass',
                },
                {
                  type: 'SPF',
                  domain: input.spfDomain ?? senderDomain,
                  result: input.spf ?? 'pass',
                },
              ],
            },
          },
        ],
      },
    },
  });
}

async function addViewer(organizationId: string) {
  const email = `sender-viewer-${Date.now()}-${fixtureId}@example.com`;
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Sender Viewer', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  await prisma.member.create({
    data: { id: `viewer-${fixtureId}-${Date.now()}`, organizationId, userId: user.id, role: 'viewer', createdAt: new Date() },
  });
  return agent;
}

describe('sender intelligence', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('fills the public-IP cache, skips private addresses, and honours the batch', async () => {
    const ctx = await setup();
    await seedSender({ domainId: ctx.domainId, senderDomain: 'sendgrid.net', ip: '8.8.8.8' });
    await seedSender({ domainId: ctx.domainId, senderDomain: 'private.example', ip: '10.0.0.7' });
    await seedSender({ domainId: ctx.domainId, senderDomain: 'second.example', ip: '1.1.1.1' });

    const onPtr = vi.fn();
    const reader = fakeReader({
      ptr: { '8.8.8.8': ['dns.google.'], '1.1.1.1': ['one.one.one.one.'] },
      addresses: { 'dns.google': ['8.8.8.8'], 'one.one.one.one': ['1.1.1.1'] },
      asn: {
        '8.8.8.8': { origin: '15169 | 8.8.8.0/24 | US | arin | 2023-12-28' },
        '1.1.1.1': { origin: '13335 | 1.1.1.0/24 | AU | apnic | 2011-08-11' },
      },
      onPtr,
    });

    const previous = env.SENDER_INTEL_BATCH;
    env.SENDER_INTEL_BATCH = 1;
    try {
      const first = await runSenderIntelPass(now, reader);
      expect(first.examined).toBeGreaterThan(0);
      expect(await prisma.sourceIpIntel.count()).toBe(1);
      expect(onPtr.mock.calls.every(([ip]) => ip !== '10.0.0.7')).toBe(true);
    } finally {
      env.SENDER_INTEL_BATCH = previous;
    }

    const result = await runSenderIntelPass(now, reader);
    expect(result.lookedUp).toBeGreaterThanOrEqual(2);
    const cached = await prisma.sourceIpIntel.findMany({ orderBy: { ip: 'asc' } });
    expect(cached.find((row) => row.ip === '8.8.8.8')?.status).toBe('OK');
    expect(cached.find((row) => row.ip === '8.8.8.8')?.ptrConfirmed).toBe(true);
    expect(cached.find((row) => row.ip === '10.0.0.7')?.status).toBe('PRIVATE');
    expect(onPtr.mock.calls.every(([ip]) => ip !== '10.0.0.7')).toBe(true);
  });

  it('looks each IP up once when two passes race', async () => {
    const ctx = await setup();
    await seedSender({ domainId: ctx.domainId, senderDomain: 'sendgrid.net', ip: '8.8.8.8' });
    const onPtr = vi.fn();
    const reader = fakeReader({
      ptr: { '8.8.8.8': ['dns.google.'] },
      addresses: { 'dns.google': ['8.8.8.8'] },
      asn: { '8.8.8.8': { origin: '15169 | 8.8.8.0/24 | US | arin | 2023-12-28' } },
      onPtr,
    });

    const [left, right] = await Promise.all([
      runSenderIntelPass(now, reader),
      runSenderIntelPass(now, reader),
    ]);

    expect(left.lookedUp + right.lookedUp).toBe(1);
    expect(onPtr).toHaveBeenCalledTimes(1);
    expect(await prisma.sourceIpIntel.count()).toBe(1);
  });

  it('returns service names, confidence and evidence from the senders endpoint', async () => {
    const ctx = await setup();
    await seedSender({ domainId: ctx.domainId, senderDomain: 'sendgrid.net' });
    await prisma.sourceIpIntel.create({
      data: {
        ip: '8.8.8.8',
        ptr: 'o1.ptr1234.sendgrid.net',
        ptrConfirmed: true,
        asn: 11377,
        asnName: 'SENDGRID',
        status: 'OK',
        lookedUpAt: now,
        expiresAt: new Date('2026-11-27T00:00:00Z'),
        lastSeenAt: now,
      },
    });

    const response = await ctx.agent.get(
      `/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders`,
    );
    expect(response.status).toBe(200);
    const row = response.body.senders[0];
    expect(row.service).toMatchObject({ id: 'sendgrid', name: 'SendGrid' });
    expect(row.confidence).toBe('confirmed');
    expect(row.review.status).toBe('UNREVIEWED');
    expect(row.owner).toBeNull();
    expect(row.evidence.some((line: string) => line.includes('sendgrid.net'))).toBe(true);
    expect(row.intelPending).toBe(false);
  });

  it('names a provider from reverse DNS when the customer uses custom DKIM', async () => {
    const ctx = await setup();
    await seedSender({
      domainId: ctx.domainId,
      senderDomain: 'customer.example',
      dkimDomain: 'customer.example',
      spfDomain: 'customer.example',
    });
    await prisma.sourceIpIntel.create({
      data: {
        ip: '8.8.8.8',
        ptr: 'o1.ptr1234.sendgrid.net',
        ptrConfirmed: true,
        asn: 11377,
        asnName: 'SENDGRID',
        status: 'OK',
        lookedUpAt: now,
        expiresAt: new Date('2026-11-27T00:00:00Z'),
        lastSeenAt: now,
      },
    });

    const response = await ctx.agent.get(
      `/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders`,
    );
    const row = response.body.senders[0];
    expect(row.service?.name).toBe('SendGrid');
    expect(row.confidence).toBe('likely');
  });

  it('enforces review permissions, tenancy and unknown senders, and keeps review available on Mooring', async () => {
    const ctx = await setup();
    await seedSender({ domainId: ctx.domainId, senderDomain: 'sendgrid.net' });

    const reviewed = await ctx.agent
      .put(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders/review`)
      .send({ senderKey: 'sendgrid.net', status: 'APPROVED', note: 'Bulk sender' });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.review.status).toBe('APPROVED');
    expect(reviewed.body.review.note).toBe('Bulk sender');

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'SENDER_REVIEWED' } });
    expect(audit.domainId).toBe(ctx.domainId);
    expect(JSON.stringify(audit.detail)).not.toContain('Bulk sender');

    const unknown = await ctx.agent
      .put(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders/review`)
      .send({ senderKey: 'never-seen.example', status: 'APPROVED' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('SENDER_NOT_FOUND');

    const viewer = await addViewer(ctx.organizationId);
    const denied = await viewer
      .put(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders/review`)
      .send({ senderKey: 'sendgrid.net', status: 'NOT_OURS' });
    expect(denied.status).toBe(403);
    const ownerDenied = await viewer
      .put(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders/owner`)
      .send({ senderKey: 'sendgrid.net', ownerUserId: null });
    expect(ownerDenied.status).toBe(403);

    const other = await setup();
    const foreign = await other.agent
      .put(`/api/workspaces/${other.organizationId}/domains/${ctx.domainId}/senders/review`)
      .send({ senderKey: 'sendgrid.net', status: 'NOT_OURS' });
    expect(foreign.status).toBe(404);
    const foreignOwner = await other.agent
      .put(`/api/workspaces/${other.organizationId}/domains/${ctx.domainId}/senders/owner`)
      .send({ senderKey: 'sendgrid.net', ownerUserId: null });
    expect(foreignOwner.status).toBe(404);

    await grantPlan(ctx.organizationId, 'MOORING');
    const stillReviewable = await ctx.agent
      .put(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders/review`)
      .send({ senderKey: 'sendgrid.net', status: 'UNREVIEWED' });
    expect(stillReviewable.status).toBe(200);
    expect(stillReviewable.body.review.status).toBe('UNREVIEWED');

    const ownerRefused = await ctx.agent
      .put(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders/owner`)
      .send({ senderKey: 'sendgrid.net', ownerUserId: null });
    expect(ownerRefused.status).toBe(402);
    expect(ownerRefused.body.error.feature).toBe('senders.owners');
  });

  it('assigns an owner, validates membership, and clears the review while keeping the owner', async () => {
    const ctx = await setup();
    await seedSender({ domainId: ctx.domainId, senderDomain: 'sendgrid.net' });
    const owner = await prisma.member.findFirstOrThrow({ where: { organizationId: ctx.organizationId } });

    const assigned = await ctx.agent
      .put(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders/owner`)
      .send({ senderKey: 'sendgrid.net', ownerUserId: owner.userId });
    expect(assigned.status).toBe(200);
    expect(assigned.body.owner.id).toBe(owner.userId);

    const reviewed = await ctx.agent
      .put(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders/review`)
      .send({ senderKey: 'sendgrid.net', status: 'NOT_OURS' });
    expect(reviewed.status).toBe(200);

    const cleared = await ctx.agent
      .put(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders/review`)
      .send({ senderKey: 'sendgrid.net', status: 'UNREVIEWED' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.review.status).toBe('UNREVIEWED');
    expect(cleared.body.owner.id).toBe(owner.userId);

    const clearedOwner = await ctx.agent
      .put(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders/owner`)
      .send({ senderKey: 'sendgrid.net', ownerUserId: null });
    expect(clearedOwner.status).toBe(200);
    expect(clearedOwner.body.owner).toBeNull();
    expect(await prisma.senderReview.count({ where: { domainId: ctx.domainId } })).toBe(0);

    const invalid = await ctx.agent
      .put(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders/owner`)
      .send({ senderKey: 'sendgrid.net', ownerUserId: 'not-a-member' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_OWNER');
  });

  it('applies a client-wide review to confirmed and likely service senders', async () => {
    const ctx = await setup();
    const secondDomain = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/clients/${ctx.clientId}/domains`)
      .send({ name: `sender-second-${Date.now()}.test` });
    expect(secondDomain.status).toBe(201);
    await prisma.domain.update({
      where: { id: secondDomain.body.id },
      data: { status: 'VERIFIED', verifiedAt: now },
    });

    await seedSender({ domainId: ctx.domainId, senderDomain: 'sendgrid.net', ip: '8.8.8.8' });
    await seedSender({ domainId: secondDomain.body.id, senderDomain: 'sendgrid.net', ip: '8.8.4.4' });

    const response = await ctx.agent
      .put(`/api/workspaces/${ctx.organizationId}/clients/${ctx.clientId}/senders/review`)
      .send({ serviceId: 'sendgrid', status: 'APPROVED' });
    expect(response.status).toBe(200);
    expect(response.body.updated).toBe(2);

    const reviews = await prisma.senderReview.findMany({ where: { organizationId: ctx.organizationId } });
    expect(reviews).toHaveLength(2);
    expect(reviews.every((row) => row.status === 'APPROVED')).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'SENDER_REVIEWED', targetType: 'sender_review_bulk' } });
    expect(audit.detail).toMatchObject({ serviceId: 'sendgrid', status: 'APPROVED', count: 2 });
  });

  it('changes spoofing and the new-source signal when a sender is reviewed', async () => {
    const ctx = await setup();
    await seedSender({
      domainId: ctx.domainId,
      senderDomain: 'unknown-sender.example',
      dkim: 'fail',
      spf: 'fail',
      messages: 100,
    });

    const before = await ctx.agent.get(
      `/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders`,
    );
    expect(before.body.possibleSpoofingSources).toHaveLength(1);
    const snapshotBefore = await buildDomainSnapshot(ctx.domainId, 7 * 24 * 60, now);
    expect(snapshotBefore.newUnauthenticatedSources).toHaveLength(1);
    const readinessBefore = await ctx.agent.get(
      `/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/policy-readiness`,
    );
    expect(
      (readinessBefore.body.blockers as string[]).some((blocker) => blocker.includes('fails DMARC')),
    ).toBe(true);

    await ctx.agent
      .put(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders/review`)
      .send({ senderKey: 'unknown-sender.example', status: 'APPROVED' });

    const after = await ctx.agent.get(
      `/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders`,
    );
    expect(after.body.possibleSpoofingSources).toHaveLength(0);
    const snapshotAfter = await buildDomainSnapshot(ctx.domainId, 7 * 24 * 60, now);
    expect(snapshotAfter.newUnauthenticatedSources).toHaveLength(0);
    const readinessApproved = await ctx.agent.get(
      `/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/policy-readiness`,
    );
    expect(
      (readinessApproved.body.blockers as string[]).some((blocker) =>
        blocker.startsWith('Approved sender unknown-sender.example fails DMARC'),
      ),
    ).toBe(true);

    // The new-source alert reads the same snapshot, so an approved sender must
    // not trigger it even though it still fails both checks.
    const owner = await prisma.member.findFirstOrThrow({ where: { organizationId: ctx.organizationId } });
    const createdRule = await ctx.agent.post(`/api/workspaces/${ctx.organizationId}/alert-rules`).send({
      domainId: ctx.domainId,
      name: 'Approved source stays quiet',
      metric: 'NEW_UNAUTHENTICATED_SOURCE',
      operator: 'GREATER_THAN_OR_EQUAL',
      threshold: 1,
      windowMinutes: 1440,
      cooldownMinutes: 1440,
      maxReminderLevel: 3,
      recipientUserIds: [owner.userId],
    });
    expect(createdRule.status).toBe(201);
    const persisted = await getAlertRule(ctx.organizationId, createdRule.body.id);
    const outcome = await evaluateRule(persisted!);
    expect(outcome.observed).toBe(0);
    expect(outcome.triggered).toBe(false);

    await ctx.agent
      .put(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders/review`)
      .send({ senderKey: 'unknown-sender.example', status: 'NOT_OURS' });
    const notOurs = await ctx.agent.get(
      `/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders`,
    );
    expect(notOurs.body.possibleSpoofingSources).toHaveLength(1);
    const readinessNotOurs = await ctx.agent.get(
      `/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/policy-readiness`,
    );
    expect(
      (readinessNotOurs.body.blockers as string[]).some((blocker) => blocker.includes('fails DMARC')),
    ).toBe(false);
  });

  it('sweeps stale IP intelligence and exports sender reviews', async () => {
    const ctx = await setup();
    await seedSender({ domainId: ctx.domainId, senderDomain: 'sendgrid.net' });
    await prisma.sourceIpIntel.create({
      data: {
        ip: '198.18.0.1',
        status: 'OK',
        lookedUpAt: new Date('2026-01-01T00:00:00Z'),
        expiresAt: new Date('2026-02-01T00:00:00Z'),
        lastSeenAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await ctx.agent
      .put(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/senders/review`)
      .send({ senderKey: 'sendgrid.net', status: 'NOT_OURS', note: 'Marketing vendor' });

    const sweep = await purgeExpiredData(now);
    expect(sweep.sourceIpIntel).toBe(1);
    expect(await prisma.sourceIpIntel.count()).toBe(0);

    const payload = await buildExportPayload({
      organizationId: ctx.organizationId,
      scope: 'CLIENT',
      targetId: ctx.clientId,
      format: 'JSON',
      scopeLabel: 'client',
    });
    const reviews = payload.data.senderReviews as Array<Record<string, unknown>>;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      domainName: ctx.domainName,
      senderKey: 'sendgrid.net',
      status: 'NOT_OURS',
      note: 'Marketing vendor',
    });
    expect(JSON.stringify(reviews)).not.toContain('bytes');
  });
});
