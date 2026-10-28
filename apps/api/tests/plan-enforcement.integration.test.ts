import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { evaluateAlertRules } from '../src/services/alert.service.js';
import { runReportDigests } from '../src/services/report-digest.service.js';
import { runInboxPollOnce } from '../src/scheduler/inbox-scheduler.js';
import { grantPlan } from './helpers/plan.js';

/**
 * The plan limits the pricing page publishes, checked where they apply.
 *
 * Each of these was published and not enforced: the team size on every plan, the
 * workspace allowance through Better Auth's own create route, and the features a
 * downgrade removes, which kept running on rows made before it. Every downgrade
 * case is checked twice, once on the lower plan and once after moving back up,
 * so a pass shows the plan is what stopped the work rather than something else.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "job_lease", "report_inbox", "entitlement_override", "subscription", "audit_log", "notification", "report_digest", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function person(label: string) {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: label, email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const userId = (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
  return { email, agent, userId };
}

async function workspace(label: string) {
  const owner = await person(label);
  const created = await owner.agent.post('/api/workspaces').send({
    name: `${label} Agency`,
    slug: `${label}-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status).toBe(201);
  return { ...owner, organizationId: created.body.id as string };
}

async function verifiedDomain(organizationId: string) {
  const client = await prisma.client.create({
    data: { organizationId, name: `Client ${fixtureId}`, slug: `c-${Date.now()}-${fixtureId}` },
  });
  return prisma.domain.create({
    data: {
      clientId: client.id,
      slug: `dom-${Math.random().toString(36).slice(2, 10)}`,
      name: `plan-${fixtureId}-${Date.now()}.test`,
      status: 'VERIFIED',
      verifiedAt: new Date(),
      dmarcPolicy: 'none',
      dmarcRecord: 'v=DMARC1; p=none; rua=mailto:agg@reports.dmarcharbor.com',
    },
  });
}

function invite(agent: ReturnType<typeof request.agent>, organizationId: string, email: string) {
  return agent.post('/api/auth/organization/invite-member').send({ email, role: 'analyst', organizationId });
}

describe('team size', () => {
  beforeEach(resetDatabase);

  it('lets Fairway invite up to its three members and refuses the next', async () => {
    const owner = await workspace('fairway-team');
    await grantPlan(owner.organizationId, 'FAIRWAY');

    expect((await invite(owner.agent, owner.organizationId, `one-${fixtureId}@example.com`)).status).toBe(200);
    expect((await invite(owner.agent, owner.organizationId, `two-${fixtureId}@example.com`)).status).toBe(200);

    // The owner and two open invitations fill three seats. A fourth person
    // would be a member the plan does not include.
    const refused = await invite(owner.agent, owner.organizationId, `three-${fixtureId}@example.com`);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('PLAN_LIMIT_REACHED');
    expect(String(refused.body.message)).toContain('includes 3 team members');
    expect(String(refused.body.message)).toContain('2 open invitations');

    expect(await prisma.invitation.count({ where: { organizationId: owner.organizationId, status: 'pending' } })).toBe(2);
  });

  it('refuses any invitation on the free plan, whose one seat is the owner', async () => {
    const owner = await workspace('mooring-team');

    const refused = await invite(owner.agent, owner.organizationId, `helper-${fixtureId}@example.com`);
    expect(refused.status).toBe(403);
    expect(String(refused.body.message)).toContain('Mooring includes 1 team member');
    expect(await prisma.invitation.count({ where: { organizationId: owner.organizationId } })).toBe(0);
  });

  it('refuses to accept an invitation once the plan has no seat for it', async () => {
    const owner = await workspace('accept-team');
    await grantPlan(owner.organizationId, 'FAIRWAY');

    const invitee = await person('invitee');
    const invited = await invite(owner.agent, owner.organizationId, invitee.email);
    expect(invited.status).toBe(200);

    // A downgrade between the invitation and the answer to it.
    await grantPlan(owner.organizationId, 'MOORING');

    const accepted = await invitee.agent
      .post('/api/auth/organization/accept-invitation')
      .send({ invitationId: invited.body.id as string });
    expect(accepted.status).toBe(403);
    expect(await prisma.member.count({ where: { organizationId: owner.organizationId } })).toBe(1);
  });
});

describe('workspace creation', () => {
  beforeEach(resetDatabase);

  /**
   * Better Auth's own endpoint skipped the workspace allowance and the DPA and
   * Terms acceptance that POST /api/workspaces records. It is switched off for
   * HTTP; the route still creates workspaces through the server-side call.
   */
  it('closes the plugin route and keeps the app route working', async () => {
    const owner = await person('create-route');

    const direct = await owner.agent
      .post('/api/auth/organization/create')
      .send({ name: 'Side Door', slug: `side-door-${Date.now()}` });
    expect(direct.status).toBe(404);
    expect(await prisma.organization.count({ where: { name: 'Side Door' } })).toBe(0);

    const created = await owner.agent.post('/api/workspaces').send({
      name: 'Front Door',
      slug: `front-door-${Date.now()}`,
      tosAccepted: true,
      dpaHasRead: true,
      dpaConfirmsAuthority: true,
    });
    expect(created.status).toBe(201);
  });
});

describe('client allowance under concurrent requests', () => {
  beforeEach(resetDatabase);

  it('lets one of two simultaneous creates take the last client slot', async () => {
    const owner = await workspace('client-race');

    // Mooring includes one client. Both requests pass the route's own check,
    // which reads before either inserts; the count under the lock decides.
    const [a, b] = await Promise.all([
      owner.agent.post(`/api/workspaces/${owner.organizationId}/clients`).send({ name: 'First', slug: `first-${fixtureId}` }),
      owner.agent.post(`/api/workspaces/${owner.organizationId}/clients`).send({ name: 'Second', slug: `second-${fixtureId}` }),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 402]);
    expect(await prisma.client.count({ where: { organizationId: owner.organizationId } })).toBe(1);
  });
});

describe('after a downgrade', () => {
  beforeEach(resetDatabase);

  it('keeps an alert rule but does not evaluate it', async () => {
    const owner = await workspace('alert-downgrade');
    await grantPlan(owner.organizationId, 'HARBOR');
    const domain = await verifiedDomain(owner.organizationId);

    const rule = await prisma.alertRule.create({
      data: {
        organizationId: owner.organizationId,
        domainId: domain.id,
        createdById: owner.userId,
        name: 'Failure rate',
        metric: 'FAILURE_RATE',
        operator: 'GREATER_THAN',
        threshold: 10,
        windowMinutes: 1440,
        recipients: { create: { userId: owner.userId } },
      },
    });

    await grantPlan(owner.organizationId, 'MOORING');
    const downgraded = (await evaluateAlertRules()).find((result) => result.ruleId === rule.id);
    expect(downgraded?.outcome).toBe('not_in_plan');
    expect(await prisma.alertRule.count({ where: { id: rule.id, enabled: true } })).toBe(1);

    await grantPlan(owner.organizationId, 'HARBOR');
    const restored = (await evaluateAlertRules()).find((result) => result.ruleId === rule.id);
    expect(restored?.outcome).not.toBe('not_in_plan');
  });

  it('keeps a spoofing rule from running on Mooring and runs it on Fairway', async () => {
    const owner = await workspace('spoof-downgrade');
    await grantPlan(owner.organizationId, 'HARBOR');
    const domain = await verifiedDomain(owner.organizationId);

    const rule = await prisma.alertRule.create({
      data: {
        organizationId: owner.organizationId,
        domainId: domain.id,
        createdById: owner.userId,
        name: 'New source',
        metric: 'NEW_UNAUTHENTICATED_SOURCE',
        operator: 'GREATER_THAN_OR_EQUAL',
        threshold: 1,
        windowMinutes: 1440,
        recipients: { create: { userId: owner.userId } },
      },
    });

    await grantPlan(owner.organizationId, 'MOORING');
    expect((await evaluateAlertRules()).find((result) => result.ruleId === rule.id)?.outcome).toBe('not_in_plan');

    await grantPlan(owner.organizationId, 'FAIRWAY');
    expect((await evaluateAlertRules()).find((result) => result.ruleId === rule.id)?.outcome).not.toBe('not_in_plan');
  });

  it('keeps a digest but neither schedules nor sends it', async () => {
    const owner = await workspace('digest-downgrade');
    await grantPlan(owner.organizationId, 'HARBOR');
    const domain = await verifiedDomain(owner.organizationId);

    const digest = await prisma.reportDigest.create({
      data: {
        organizationId: owner.organizationId,
        domainId: domain.id,
        createdById: owner.userId,
        frequency: 'WEEKLY',
        sendHourUtc: new Date().getUTCHours(),
        weekday: new Date().getUTCDay(),
        recipientEmails: ['client@example.com'],
        enabled: true,
      },
    });

    await grantPlan(owner.organizationId, 'FAIRWAY');

    const scheduled = (await runReportDigests()).find((result) => result.digestId === digest.id);
    expect(scheduled?.sent).toBe(false);
    expect((await prisma.reportDigest.findUniqueOrThrow({ where: { id: digest.id } })).lastSentAt).toBeNull();

    const sendNow = await owner.agent.post(`/api/workspaces/${owner.organizationId}/report-digests/${digest.id}/send`);
    expect(sendNow.status).toBe(402);
    const runNow = await owner.agent.post(`/api/workspaces/${owner.organizationId}/report-digests/run`);
    expect(runNow.status).toBe(402);

    // Still listed, so it can be edited, removed, or simply resumes on upgrade.
    const listed = await owner.agent.get(`/api/workspaces/${owner.organizationId}/report-digests`);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain(digest.id);

    await grantPlan(owner.organizationId, 'HARBOR');
    expect((await runReportDigests()).find((result) => result.digestId === digest.id)?.sent).toBe(true);
  });

  it('keeps the mailbox but does not log in to it', async () => {
    const owner = await workspace('inbox-downgrade');
    await grantPlan(owner.organizationId, 'FAIRWAY');

    await prisma.reportInbox.create({
      data: {
        organizationId: owner.organizationId,
        host: 'imap.example.test',
        port: 993,
        secure: true,
        username: 'agg@example.test',
        // Not a real mailbox. A login attempt fails, which is what makes an
        // attempt visible in the summary.
        encryptedPassword: 'irrelevant',
        enabled: true,
      },
    });

    const skipped = await runInboxPollOnce();
    expect(skipped.polled + skipped.failed).toBe(0);
    expect(await prisma.reportInbox.count({ where: { organizationId: owner.organizationId, enabled: true } })).toBe(1);

    await grantPlan(owner.organizationId, 'HARBOR');
    const attempted = await runInboxPollOnce();
    expect(attempted.polled + attempted.failed).toBe(1);
  });
});
