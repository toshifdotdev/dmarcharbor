import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { createApiKey } from '../src/services/api-key.service.js';
import { grantPlan } from './helpers/plan.js';

/**
 * The basic operations an MSP runs all day on what it already has: rename a
 * client, move a domain to another client (browser and /api/v1), export the
 * client book, rename the workspace, and acknowledge alerts or revoke share
 * links in bulk.
 *
 * Each block checks the three things that go wrong with a new write route:
 * the role check (an analyst cannot rename a client or the workspace), the
 * workspace scope (another workspace's id answers 404 and changes nothing),
 * and the audit row (every mutation is in the trail).
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "policy_proposal", "domain_switch", "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function signedIn(name: string, email: string): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-up/email').send({ name, email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  return agent;
}

interface Fixture {
  agent: ReturnType<typeof request.agent>;
  organizationId: string;
  userId: string;
  clientA: string;
  clientB: string;
  domainId: string;
  domainSlug: string;
  domainName: string;
  /** A second signed-in account, added to this workspace with the given role. */
  join: (role: 'admin' | 'analyst' | 'viewer') => Promise<ReturnType<typeof request.agent>>;
}

async function workspace(): Promise<Fixture> {
  fixtureId += 1;
  const stamp = `${Date.now()}-${fixtureId}`;
  const email = `ops-${stamp}@example.com`;
  const agent = await signedIn('Ops Owner', email);

  const created = await agent.post('/api/workspaces').send({
    name: 'Wistholm IT',
    slug: `wistholm-${stamp}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status).toBe(201);
  const organizationId = created.body.id as string;
  await grantPlan(organizationId);

  const owner = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });

  const a = await agent
    .post(`/api/workspaces/${organizationId}/clients`)
    .send({ name: 'Pellowyn Dental', slug: `pellowyn-${stamp}` });
  expect(a.status).toBe(201);
  const b = await agent
    .post(`/api/workspaces/${organizationId}/clients`)
    .send({ name: 'Corriwick Cafe', slug: `corriwick-${stamp}` });
  expect(b.status).toBe(201);

  const domainName = `ops-${fixtureId}-${Date.now()}.example`;
  const domain = await agent
    .post(`/api/workspaces/${organizationId}/clients/${a.body.id}/domains`)
    .send({ name: domainName });
  expect(domain.status).toBe(201);

  const join = async (role: 'admin' | 'analyst' | 'viewer') => {
    const joinEmail = `ops-${role}-${stamp}@example.com`;
    const member = await signedIn(`Ops ${role}`, joinEmail);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: joinEmail }, select: { id: true } });
    await prisma.member.create({
      data: { id: `member-${role}-${stamp}`, organizationId, userId: user.id, role, createdAt: new Date() },
    });
    return member;
  };

  return {
    agent,
    organizationId,
    userId: owner.id,
    clientA: a.body.id as string,
    clientB: b.body.id as string,
    domainId: domain.body.id as string,
    domainSlug: domain.body.slug as string,
    domainName,
    join,
  };
}

async function audits(organizationId: string, action: string) {
  return prisma.auditLog.findMany({
    where: { organizationId, action: action as never },
    orderBy: { createdAt: 'asc' },
  });
}

describe('rename a client', () => {
  beforeAll(resetDatabase);

  it('renames a client and changes its slug, and records both values', async () => {
    const { agent, organizationId, clientA } = await workspace();
    const before = await prisma.client.findUniqueOrThrow({ where: { id: clientA } });

    const response = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clientA}/rename`)
      .send({ name: 'Pellowyn Dental Group', slug: `pellowyn-group-${fixtureId}` });
    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(true);
    expect(response.body.client.name).toBe('Pellowyn Dental Group');

    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientA } });
    expect(after.slug).toBe(`pellowyn-group-${fixtureId}`);
    // The report token is what the published rua address carries; a rename must not touch it.
    expect(after.reportToken).toBe(before.reportToken);

    const rows = await audits(organizationId, 'CLIENT_UPDATED');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({
      from: { name: 'Pellowyn Dental', slug: before.slug },
      to: { name: 'Pellowyn Dental Group' },
    });
  });

  it('answers 200 with changed false, and writes nothing, when nothing changes', async () => {
    const { agent, organizationId, clientA } = await workspace();
    const response = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clientA}/rename`)
      .send({ name: 'Pellowyn Dental' });
    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(false);
    expect(await audits(organizationId, 'CLIENT_UPDATED')).toHaveLength(0);
  });

  it('refuses a slug another client already has', async () => {
    const { agent, organizationId, clientA, clientB } = await workspace();
    const other = await prisma.client.findUniqueOrThrow({ where: { id: clientB } });
    const response = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clientA}/rename`)
      .send({ slug: other.slug });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
  });

  it('refuses an empty body and a bad slug', async () => {
    const { agent, organizationId, clientA } = await workspace();
    expect((await agent.post(`/api/workspaces/${organizationId}/clients/${clientA}/rename`).send({})).status).toBe(400);
    expect(
      (await agent.post(`/api/workspaces/${organizationId}/clients/${clientA}/rename`).send({ slug: 'Not A Slug' })).status,
    ).toBe(400);
  });

  it('answers 404 for a client in another workspace and leaves it alone', async () => {
    const first = await workspace();
    const second = await workspace();
    const response = await second.agent
      .post(`/api/workspaces/${second.organizationId}/clients/${first.clientA}/rename`)
      .send({ name: 'Taken Over' });
    expect(response.status).toBe(404);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: first.clientA } })).name).toBe('Pellowyn Dental');
  });

  it('is refused for an analyst, who cannot change clients', async () => {
    const { organizationId, clientA, join } = await workspace();
    const analyst = await join('analyst');
    const response = await analyst
      .post(`/api/workspaces/${organizationId}/clients/${clientA}/rename`)
      .send({ name: 'Analyst Rename' });
    expect(response.status).toBe(403);
  });
});

describe('move a domain to another client', () => {
  beforeAll(resetDatabase);

  it('previews what moves and what changes hands', async () => {
    const { agent, organizationId, clientB, domainId } = await workspace();
    await prisma.reportDigest.create({
      data: { organizationId, domainId, recipientEmails: ['Owner@Pellowyn.example'], frequency: 'WEEKLY' },
    });

    const response = await agent.get(
      `/api/workspaces/${organizationId}/domains/${domainId}/move-preview?clientId=${clientB}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.from.name).toBe('Pellowyn Dental');
    expect(response.body.to.name).toBe('Corriwick Cafe');
    expect(response.body.alreadyThere).toBe(false);
    expect(response.body.moves.reportDigests).toBe(1);
    expect(response.body.digestRecipients).toEqual(['owner@pellowyn.example']);
    expect(response.body.blockers).toEqual([]);
    expect(response.body.reportAddress.next).not.toBe(response.body.reportAddress.previous);
  });

  it('moves the domain with its share links, withdraws pending approval requests, and audits it', async () => {
    const { agent, organizationId, clientA, clientB, domainId, domainName } = await workspace();
    const share = await prisma.reportShare.create({
      data: {
        token: `share-${Date.now()}-${fixtureId}`,
        organizationId,
        clientId: clientA,
        domainId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const proposal = await prisma.policyProposal.create({
      data: {
        organizationId,
        domainId,
        fromPolicy: 'none',
        fromTesting: false,
        policy: 'quarantine',
        testing: false,
        recordValue: 'v=DMARC1; p=quarantine',
        applyVia: 'manual',
        evidence: {},
        blockers: [],
        expiresAt: new Date(Date.now() + 14 * 86_400_000),
      },
    });

    const response = await agent
      .post(`/api/workspaces/${organizationId}/domains/${domainId}/move`)
      .send({ clientId: clientB });
    expect(response.status).toBe(200);
    expect(response.body.moved).toBe(true);
    expect(response.body.to.id).toBe(clientB);
    expect(response.body.shareLinksMoved).toBe(1);
    expect(response.body.withdrawnProposals).toBe(1);

    expect((await prisma.domain.findUniqueOrThrow({ where: { id: domainId } })).clientId).toBe(clientB);
    expect((await prisma.reportShare.findUniqueOrThrow({ where: { id: share.id } })).clientId).toBe(clientB);
    expect((await prisma.policyProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('WITHDRAWN');

    const moved = await audits(organizationId, 'DOMAIN_MOVED');
    expect(moved).toHaveLength(1);
    expect(moved[0]!.detail).toMatchObject({
      name: domainName,
      fromClientId: clientA,
      toClientId: clientB,
    });
    const withdrawn = await audits(organizationId, 'POLICY_PROPOSAL_WITHDRAWN');
    expect(withdrawn.map((row) => row.targetId)).toEqual([proposal.id]);
  });

  it('accepts the domain slug in the path', async () => {
    const { agent, organizationId, clientB, domainId, domainSlug } = await workspace();
    const response = await agent
      .post(`/api/workspaces/${organizationId}/domains/${domainSlug}/move`)
      .send({ clientId: clientB });
    expect(response.status).toBe(200);
    expect((await prisma.domain.findUniqueOrThrow({ where: { id: domainId } })).clientId).toBe(clientB);
  });

  it('answers 200 with moved false, and writes nothing, for the client it is already under', async () => {
    const { agent, organizationId, clientA, domainId } = await workspace();
    const response = await agent
      .post(`/api/workspaces/${organizationId}/domains/${domainId}/move`)
      .send({ clientId: clientA });
    expect(response.status).toBe(200);
    expect(response.body.moved).toBe(false);
    expect(await audits(organizationId, 'DOMAIN_MOVED')).toHaveLength(0);
  });

  it('refuses while a provider switch is under way, and says why', async () => {
    const { agent, organizationId, clientA, clientB, domainId } = await workspace();
    await prisma.domainSwitch.create({
      data: {
        domainId,
        organizationId,
        status: 'DUAL_REPORTING',
        incumbentVendor: 'other',
        incumbentLabel: 'Another provider',
        incumbentAggregateTargets: [],
        incumbentForensicTargets: [],
        originalRecord: 'v=DMARC1; p=none',
        plannedRecord: 'v=DMARC1; p=none',
      },
    });

    const preview = await agent.get(
      `/api/workspaces/${organizationId}/domains/${domainId}/move-preview?clientId=${clientB}`,
    );
    expect(preview.body.blockers.map((b: { code: string }) => b.code)).toEqual(['SWITCH_IN_PROGRESS']);

    const response = await agent
      .post(`/api/workspaces/${organizationId}/domains/${domainId}/move`)
      .send({ clientId: clientB });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expect(response.body.error.blockers[0].code).toBe('SWITCH_IN_PROGRESS');
    expect((await prisma.domain.findUniqueOrThrow({ where: { id: domainId } })).clientId).toBe(clientA);
  });

  it('answers 404 for a target client or a domain in another workspace, and moves nothing', async () => {
    const first = await workspace();
    const second = await workspace();

    const toForeignClient = await first.agent
      .post(`/api/workspaces/${first.organizationId}/domains/${first.domainId}/move`)
      .send({ clientId: second.clientA });
    expect(toForeignClient.status).toBe(404);

    const foreignDomain = await second.agent
      .post(`/api/workspaces/${second.organizationId}/domains/${first.domainId}/move`)
      .send({ clientId: second.clientB });
    expect(foreignDomain.status).toBe(404);

    const foreignPreview = await second.agent.get(
      `/api/workspaces/${second.organizationId}/domains/${first.domainId}/move-preview?clientId=${second.clientB}`,
    );
    expect(foreignPreview.status).toBe(404);

    expect((await prisma.domain.findUniqueOrThrow({ where: { id: first.domainId } })).clientId).toBe(first.clientA);
  });

  it('is refused for an analyst, who can edit domains but not move them between clients', async () => {
    const { organizationId, clientB, domainId, join } = await workspace();
    const analyst = await join('analyst');
    const response = await analyst
      .post(`/api/workspaces/${organizationId}/domains/${domainId}/move`)
      .send({ clientId: clientB });
    expect(response.status).toBe(403);
  });

  it('moves through /api/v1 with an idempotency key, and names the key in the audit row', async () => {
    const { organizationId, userId, clientB, domainId } = await workspace();
    const key = await createApiKey({ organizationId, name: 'PSA sync', scopes: ['read', 'write'], createdById: userId });

    const first = await request(app)
      .post(`/api/v1/domains/${domainId}/move`)
      .set('Authorization', `Bearer ${key.key}`)
      .set('Idempotency-Key', `move-${domainId}`)
      .send({ clientId: clientB });
    expect(first.status).toBe(200);
    expect(first.body.moved).toBe(true);

    const replay = await request(app)
      .post(`/api/v1/domains/${domainId}/move`)
      .set('Authorization', `Bearer ${key.key}`)
      .set('Idempotency-Key', `move-${domainId}`)
      .send({ clientId: clientB });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body.moved).toBe(true);

    const rows = await audits(organizationId, 'DOMAIN_MOVED');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({ apiKeyId: key.id });
  });

  it('answers 404 through /api/v1 for a domain in another workspace', async () => {
    const first = await workspace();
    const second = await workspace();
    const key = await createApiKey({
      organizationId: second.organizationId,
      name: 'Other sync',
      scopes: ['read', 'write'],
      createdById: second.userId,
    });
    const response = await request(app)
      .post(`/api/v1/domains/${first.domainId}/move`)
      .set('Authorization', `Bearer ${key.key}`)
      .send({ clientId: second.clientB });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});

describe('export the client book', () => {
  beforeAll(resetDatabase);

  it('answers a CSV with one row per domain and a row for a client with none', async () => {
    const { agent, organizationId, domainName } = await workspace();
    const response = await agent.get(`/api/workspaces/${organizationId}/clients/export`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toMatch(/attachment; filename="client-book-wistholm-/);

    const lines = response.text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'client,client_slug,client_id,report_address,domain,domain_id,ownership,dmarc_policy,score,verified_at,last_scan_at,domain_added_at',
    );
    // Corriwick has no domains and still has its row; Pellowyn has the one domain.
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.startsWith('Corriwick Cafe,'))).toBe(true);
    expect(lines.some((line) => line.includes(domainName) && line.includes('awaiting ownership record'))).toBe(true);

    const rows = await audits(organizationId, 'EXPORT_DOWNLOADED');
    expect(rows.map((row) => row.targetType)).toEqual(['client_book']);
  });

  it('defuses a client name a spreadsheet would run as a formula', async () => {
    const { agent, organizationId } = await workspace();
    expect(
      (
        await agent
          .post(`/api/workspaces/${organizationId}/clients`)
          .send({ name: '=HYPERLINK("https://x.example")', slug: `formula-${fixtureId}` })
      ).status,
    ).toBe(201);
    const response = await agent.get(`/api/workspaces/${organizationId}/clients/export`);
    expect(response.text).toContain(`"'=HYPERLINK(""https://x.example"")"`);
  });

  it('is open to a viewer, who can already read the client list', async () => {
    const { organizationId, join } = await workspace();
    const viewer = await join('viewer');
    expect((await viewer.get(`/api/workspaces/${organizationId}/clients/export`)).status).toBe(200);
  });
});

describe('rename the workspace', () => {
  beforeAll(resetDatabase);

  it('renames the workspace, keeps the slug, and audits it', async () => {
    const { agent, organizationId } = await workspace();
    const before = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });

    const response = await agent.post(`/api/workspaces/${organizationId}/rename`).send({ name: 'Wistholm Managed IT' });
    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(true);

    const after = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(after.name).toBe('Wistholm Managed IT');
    expect(after.slug).toBe(before.slug);
    const rows = await audits(organizationId, 'WORKSPACE_UPDATED');
    expect(rows[0]!.detail).toMatchObject({ from: { name: 'Wistholm IT' }, to: { name: 'Wistholm Managed IT' } });
  });

  it('lets an admin rename it and refuses an analyst', async () => {
    const { organizationId, join } = await workspace();
    const admin = await join('admin');
    expect((await admin.post(`/api/workspaces/${organizationId}/rename`).send({ name: 'Admin Named' })).status).toBe(200);
    const analyst = await join('analyst');
    expect((await analyst.post(`/api/workspaces/${organizationId}/rename`).send({ name: 'Analyst Named' })).status).toBe(403);
  });

  it('refuses a name that is too short', async () => {
    const { agent, organizationId } = await workspace();
    expect((await agent.post(`/api/workspaces/${organizationId}/rename`).send({ name: 'x' })).status).toBe(400);
  });
});

describe('bulk acknowledge and bulk revoke', () => {
  beforeAll(resetDatabase);

  async function alertEvents(organizationId: string, domainId: string, count: number) {
    const rule = await prisma.alertRule.create({
      data: {
        organizationId,
        domainId,
        name: 'Failures',
        metric: 'FAILURE_COUNT',
        operator: 'GREATER_THAN',
        threshold: 0,
      },
    });
    const events = [];
    for (let i = 0; i < count; i += 1) {
      events.push(
        await prisma.alertEvent.create({
          data: {
            ruleId: rule.id,
            organizationId,
            domainId,
            metric: 'FAILURE_COUNT',
            operator: 'GREATER_THAN',
            observedValue: 10 + i,
            threshold: 0,
            windowMinutes: 1440,
            summary: `Observed ${10 + i} failing messages`,
          },
        }),
      );
    }
    return events;
  }

  it('acknowledges many alerts, answers per alert, and audits each one', async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const [one, two] = await alertEvents(mine.organizationId, mine.domainId, 2);
    const [foreign] = await alertEvents(theirs.organizationId, theirs.domainId, 1);

    const response = await mine.agent
      .post(`/api/workspaces/${mine.organizationId}/alerts/acknowledge`)
      .send({ eventIds: [one!.id, two!.id, foreign!.id] });
    expect(response.status).toBe(200);
    expect(response.body.acknowledged).toBe(2);
    expect(response.body.skipped).toEqual([{ id: foreign!.id, reason: 'not_found' }]);

    // The other workspace's alert is untouched.
    expect((await prisma.alertEvent.findUniqueOrThrow({ where: { id: foreign!.id } })).acknowledgedAt).toBeNull();
    expect(await audits(mine.organizationId, 'ALERT_ACKNOWLEDGED')).toHaveLength(2);

    const again = await mine.agent
      .post(`/api/workspaces/${mine.organizationId}/alerts/acknowledge`)
      .send({ eventIds: [one!.id] });
    expect(again.status).toBe(200);
    expect(again.body.skipped).toEqual([{ id: one!.id, reason: 'already_handled' }]);
  });

  it('answers 404 when none of the alerts is in this workspace, and 400 for an empty list', async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const [foreign] = await alertEvents(theirs.organizationId, theirs.domainId, 1);
    expect(
      (await mine.agent.post(`/api/workspaces/${mine.organizationId}/alerts/acknowledge`).send({ eventIds: [foreign!.id] }))
        .status,
    ).toBe(404);
    expect(
      (await mine.agent.post(`/api/workspaces/${mine.organizationId}/alerts/acknowledge`).send({ eventIds: [] })).status,
    ).toBe(400);
  });

  it('is refused for a viewer, who cannot acknowledge one alert either', async () => {
    const { organizationId, domainId, join } = await workspace();
    const [event] = await alertEvents(organizationId, domainId, 1);
    const viewer = await join('viewer');
    expect(
      (await viewer.post(`/api/workspaces/${organizationId}/alerts/acknowledge`).send({ eventIds: [event!.id] })).status,
    ).toBe(403);
  });

  it('revokes many share links, answers per link, and audits each one', async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const share = (organizationId: string, clientId: string, domainId: string, n: number) =>
      prisma.reportShare.create({
        data: {
          token: `bulk-${organizationId}-${n}`,
          organizationId,
          clientId,
          domainId,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    const one = await share(mine.organizationId, mine.clientA, mine.domainId, 1);
    const two = await share(mine.organizationId, mine.clientA, mine.domainId, 2);
    const foreign = await share(theirs.organizationId, theirs.clientA, theirs.domainId, 3);

    const response = await mine.agent
      .post(`/api/workspaces/${mine.organizationId}/report-shares/revoke`)
      .send({ shareIds: [one.id, two.id, foreign.id] });
    expect(response.status).toBe(200);
    expect(response.body.revoked).toBe(2);
    expect(response.body.skipped).toEqual([{ id: foreign.id, reason: 'not_found' }]);

    expect((await prisma.reportShare.findUniqueOrThrow({ where: { id: one.id } })).revokedAt).not.toBeNull();
    expect((await prisma.reportShare.findUniqueOrThrow({ where: { id: foreign.id } })).revokedAt).toBeNull();
    expect(await audits(mine.organizationId, 'REPORT_SHARE_REVOKED')).toHaveLength(2);

    const again = await mine.agent
      .post(`/api/workspaces/${mine.organizationId}/report-shares/revoke`)
      .send({ shareIds: [one.id] });
    expect(again.status).toBe(200);
    expect(again.body.skipped).toEqual([{ id: one.id, reason: 'already_revoked' }]);

    const onlyForeign = await mine.agent
      .post(`/api/workspaces/${mine.organizationId}/report-shares/revoke`)
      .send({ shareIds: [foreign.id] });
    expect(onlyForeign.status).toBe(404);
  });
});
