import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { symmetricEncrypt } from 'better-auth/crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { auth } from '../src/auth/auth.config.js';
import { prisma } from '../src/database/prisma.js';
import { memberAllowance } from '../src/services/entitlements/entitlement.service.js';
import { hotp, totpKey } from '../src/auth/totp-check.js';
import { grantPlan } from './helpers/plan.js';

/**
 * Session 2 of the manual test plan, made permanent.
 *
 * Every membership change writes an audit entry; a workspace has exactly one
 * owner and ownership moves only through the transfer; an expired invitation
 * is resent as a new one and holds no seat; and the seat refusal says what it
 * counted.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "rate_limit_bucket", "email_delivery", "entitlement_override", "subscription", "audit_log", "domain", "client", "organization", invitation, member, session, account, verification, "two_factor", "user" CASCADE',
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

type Agent = ReturnType<typeof request.agent>;

function invite(agent: Agent, organizationId: string, email: string, role = 'analyst', resend = false) {
  return agent
    .post('/api/auth/organization/invite-member')
    .send({ email, role, organizationId, ...(resend ? { resend: true } : {}) });
}

/** Invites `label` and has them accept, returning their member row. */
async function joined(owner: { agent: Agent; organizationId: string }, label: string, role = 'analyst') {
  const someone = await person(label);
  const invited = await invite(owner.agent, owner.organizationId, someone.email, role);
  expect(invited.status).toBe(200);
  const accepted = await someone.agent.post('/api/auth/organization/accept-invitation').send({ invitationId: invited.body.id });
  expect(accepted.status).toBe(200);
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: owner.organizationId, userId: someone.userId } });
  return { ...someone, memberId: member.id };
}

async function auditRows(organizationId: string, action: string) {
  return prisma.auditLog.findMany({ where: { organizationId, action: action as never }, orderBy: { createdAt: 'asc' } });
}

describe('membership audit trail', () => {
  beforeEach(resetDatabase);

  it('records invite, resend, withdraw, accept, decline, role change, removal and leaving', async () => {
    const owner = await workspace('audit-owner');
    await grantPlan(owner.organizationId, 'HARBOR');

    // Invite and resend.
    const target = `withdrawn-${fixtureId}@example.com`;
    const first = await invite(owner.agent, owner.organizationId, target, 'viewer');
    expect(first.status).toBe(200);
    expect((await invite(owner.agent, owner.organizationId, target, 'viewer', true)).status).toBe(200);
    // Withdraw.
    expect(
      (await owner.agent.post('/api/auth/organization/cancel-invitation').send({ invitationId: first.body.id })).status,
    ).toBe(200);

    const invited = await auditRows(owner.organizationId, 'MEMBER_INVITED');
    expect(invited).toHaveLength(1);
    expect(invited[0]).toMatchObject({ actorUserId: owner.userId, targetType: 'invitation', targetId: first.body.id });
    expect(invited[0]!.detail).toMatchObject({ email: target, role: 'viewer' });
    expect(await auditRows(owner.organizationId, 'INVITATION_RESENT')).toHaveLength(1);
    expect((await auditRows(owner.organizationId, 'INVITATION_CANCELED'))[0]).toMatchObject({ actorUserId: owner.userId, targetId: first.body.id });

    // Accept, under the invited person's own account.
    const analyst = await joined(owner, 'audit-analyst');
    const accepted = await auditRows(owner.organizationId, 'INVITATION_ACCEPTED');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.actorUserId).toBe(analyst.userId);

    // Decline.
    const decliner = await person('audit-decliner');
    const declined = await invite(owner.agent, owner.organizationId, decliner.email);
    expect(
      (await decliner.agent.post('/api/auth/organization/reject-invitation').send({ invitationId: declined.body.id })).status,
    ).toBe(200);
    const rejected = await auditRows(owner.organizationId, 'INVITATION_REJECTED');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ actorUserId: decliner.userId, targetId: declined.body.id });

    // Role change, with the role before and after.
    expect(
      (
        await owner.agent
          .post('/api/auth/organization/update-member-role')
          .send({ organizationId: owner.organizationId, memberId: analyst.memberId, role: 'viewer' })
      ).status,
    ).toBe(200);
    const changed = await auditRows(owner.organizationId, 'MEMBER_ROLE_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ actorUserId: owner.userId, targetType: 'member', targetId: analyst.memberId });
    expect(changed[0]!.detail).toMatchObject({ email: analyst.email, role: 'viewer', previousRole: 'analyst' });

    // Removal.
    expect(
      (
        await owner.agent
          .post('/api/auth/organization/remove-member')
          .send({ organizationId: owner.organizationId, memberIdOrEmail: analyst.memberId })
      ).status,
    ).toBe(200);
    const removed = await auditRows(owner.organizationId, 'MEMBER_REMOVED');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ actorUserId: owner.userId, targetId: analyst.memberId });
    expect(removed[0]!.detail).toMatchObject({ email: analyst.email });

    // Leaving.
    const leaver = await joined(owner, 'audit-leaver', 'viewer');
    expect((await leaver.agent.post('/api/auth/organization/leave').send({ organizationId: owner.organizationId })).status).toBe(200);
    const left = await auditRows(owner.organizationId, 'MEMBER_LEFT');
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ actorUserId: leaver.userId, targetId: leaver.memberId });
  });

  it('writes nothing for a request that changed nothing', async () => {
    const owner = await workspace('audit-refused');
    const viewer = await joined(owner, 'audit-refused-viewer', 'viewer');

    // A viewer may not invite: refused, and no entry.
    expect((await invite(viewer.agent, owner.organizationId, `nobody-${fixtureId}@example.com`)).status).not.toBe(200);
    expect(await auditRows(owner.organizationId, 'MEMBER_INVITED')).toHaveLength(1);
  });

  it('switches off the plugin session revocations, which wrote no audit entry', async () => {
    const owner = await person('audit-sessions');
    for (const path of ['/api/auth/revoke-session', '/api/auth/revoke-sessions', '/api/auth/revoke-other-sessions']) {
      expect((await owner.agent.post(path).send({ token: 'x' })).status, path).toBe(404);
    }
  });
});

describe('one owner per workspace', () => {
  beforeEach(resetDatabase);

  it('refuses making anyone an owner, by role change or by invitation', async () => {
    const owner = await workspace('one-owner');
    await grantPlan(owner.organizationId, 'HARBOR');
    const admin = await joined(owner, 'one-owner-admin', 'admin');

    const promoted = await owner.agent
      .post('/api/auth/organization/update-member-role')
      .send({ organizationId: owner.organizationId, memberId: admin.memberId, role: 'owner' });
    expect(promoted.status).toBe(403);
    expect(promoted.body.code).toBe('OWNERSHIP_TRANSFER_REQUIRED');

    const invited = await invite(owner.agent, owner.organizationId, `second-owner-${fixtureId}@example.com`, 'owner');
    expect(invited.status).toBe(403);
    expect(invited.body.code).toBe('OWNERSHIP_TRANSFER_REQUIRED');

    expect(await prisma.member.count({ where: { organizationId: owner.organizationId, role: 'owner' } })).toBe(1);
    expect(await prisma.invitation.count({ where: { organizationId: owner.organizationId } })).toBe(0);
  });

  it('the data fix keeps the earliest owner and makes the others admins', async () => {
    const owner = await workspace('two-owners');
    const second = await joined(owner, 'two-owners-second', 'admin');
    // The state the plugin used to allow.
    await prisma.member.update({ where: { id: second.memberId }, data: { role: 'owner' } });
    const single = await workspace('single-owner');

    const sql = readFileSync(
      join(process.cwd(), 'prisma', 'migrations', '20261207120100_one_owner_per_workspace', 'migration.sql'),
      'utf8',
    );
    const statement = sql
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n')
      .replace(/;\s*--.*$/m, ';')
      .trim();
    await prisma.$executeRawUnsafe(statement);

    const roles = await prisma.member.findMany({ where: { organizationId: owner.organizationId }, select: { userId: true, role: true } });
    expect(roles.find((row) => row.userId === owner.userId)?.role).toBe('owner');
    expect(roles.find((row) => row.userId === second.userId)?.role).toBe('admin');
    expect((await prisma.member.findFirstOrThrow({ where: { organizationId: single.organizationId } })).role).toBe('owner');
  });
});

describe('expired invitations', () => {
  beforeEach(resetDatabase);

  it('hold no seat, and resending one replaces it with a fresh invitation', async () => {
    const owner = await workspace('expired-invite');
    const email = `lapsed-${fixtureId}@example.com`;
    const sent = await invite(owner.agent, owner.organizationId, email);
    expect(sent.status).toBe(200);
    await prisma.invitation.update({ where: { id: sent.body.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    // Mooring has two seats: the owner, and the expired invitation does not count.
    expect(await memberAllowance(owner.organizationId)).toMatchObject({ members: 1, pending: 0, limit: 2 });

    const resent = await invite(owner.agent, owner.organizationId, email, 'analyst', true);
    expect(resent.status).toBe(200);
    expect(resent.body.id).not.toBe(sent.body.id);
    expect(new Date(resent.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const rows = await prisma.invitation.findMany({ where: { organizationId: owner.organizationId }, select: { id: true, status: true } });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === sent.body.id)?.status).toBe('canceled');
    expect(rows.find((row) => row.id === resent.body.id)?.status).toBe('pending');
    expect(await auditRows(owner.organizationId, 'INVITATION_RESENT')).toHaveLength(1);
  });
});

describe('transferring ownership', () => {
  beforeEach(resetDatabase);

  function transfer(agent: Agent, organizationId: string, body: Record<string, unknown>) {
    return agent.post(`/api/workspaces/${organizationId}/ownership/transfer`).send(body);
  }

  it('makes the member owner and the owner admin, emails both and audits it', async () => {
    const owner = await workspace('transfer-owner');
    await grantPlan(owner.organizationId, 'FAIRWAY');
    const admin = await joined(owner, 'transfer-admin', 'admin');

    const moved = await transfer(owner.agent, owner.organizationId, { newOwnerMemberId: admin.memberId, password });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ newOwner: { memberId: admin.memberId }, previousOwner: { role: 'admin' }, plan: 'MOORING' });

    const roles = await prisma.member.findMany({ where: { organizationId: owner.organizationId }, select: { userId: true, role: true } });
    expect(roles.filter((row) => row.role === 'owner').map((row) => row.userId)).toEqual([admin.userId]);
    expect(roles.find((row) => row.userId === owner.userId)?.role).toBe('admin');
    // The workspace's shadow plan follows the new owner's account.
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: owner.organizationId } })).plan).toBe('MOORING');

    const audited = await auditRows(owner.organizationId, 'OWNERSHIP_TRANSFERRED');
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ actorUserId: owner.userId, targetId: admin.memberId });
    expect(audited[0]!.detail).toMatchObject({ from: { email: owner.email }, to: { email: admin.email, previousRole: 'admin' } });

    await expect.poll(() => prisma.emailDelivery.count({ where: { idempotencyKey: { startsWith: `ownership:${owner.organizationId}:` } } })).toBe(2);
    const mails = await prisma.emailDelivery.findMany({ where: { idempotencyKey: { startsWith: `ownership:${owner.organizationId}:` } } });
    expect(mails.map((mail) => mail.to).sort()).toEqual([owner.email, admin.email].sort());

    // The old owner is an admin now and cannot move it again.
    const again = await transfer(owner.agent, owner.organizationId, { newOwnerMemberId: admin.memberId, password });
    expect(again.status).toBe(403);
  });

  it('accepts a two-step code instead of the password, once', async () => {
    const owner = await workspace('transfer-totp');
    const admin = await joined(owner, 'transfer-totp-admin', 'admin');
    const secret = 'transfer-test-secret-0123456789';
    const context = await auth.$context;
    await prisma.twoFactor.create({
      data: {
        id: `tf-${fixtureId}`,
        userId: owner.userId,
        secret: await symmetricEncrypt({ key: context.secretConfig, data: secret }),
        backupCodes: await symmetricEncrypt({ key: context.secretConfig, data: '[]' }),
        verified: true,
      },
    });
    await prisma.user.update({ where: { id: owner.userId }, data: { twoFactorEnabled: true } });

    const step = Math.floor(Date.now() / 30_000);
    const live = new Set([-2, -1, 0, 1, 2].map((offset) => hotp(totpKey(secret), step + offset)));
    const notLive = ['000000', '111111', '222222', '333333', '444444', '555555'].find((candidate) => !live.has(candidate))!;
    const wrong = await transfer(owner.agent, owner.organizationId, { newOwnerMemberId: admin.memberId, code: notLive });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('CONFIRMATION_FAILED');

    const code = hotp(totpKey(secret), Math.floor(Date.now() / 30_000));
    expect((await transfer(owner.agent, owner.organizationId, { newOwnerMemberId: admin.memberId, code })).status).toBe(200);
    expect((await prisma.member.findUniqueOrThrow({ where: { id: admin.memberId } })).role).toBe('owner');
  });

  it('refuses a wrong password, a missing confirmation, and the owner themself', async () => {
    const owner = await workspace('transfer-refused');
    const admin = await joined(owner, 'transfer-refused-admin', 'admin');
    const ownerMember = await prisma.member.findFirstOrThrow({ where: { organizationId: owner.organizationId, userId: owner.userId } });

    const wrong = await transfer(owner.agent, owner.organizationId, { newOwnerMemberId: admin.memberId, password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('CONFIRMATION_FAILED');

    const missing = await transfer(owner.agent, owner.organizationId, { newOwnerMemberId: admin.memberId });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('CONFIRMATION_REQUIRED');

    const self = await transfer(owner.agent, owner.organizationId, { newOwnerMemberId: ownerMember.id, password });
    expect(self.status).toBe(400);

    // An admin holds no organization delete, so the route refuses them.
    expect((await transfer(admin.agent, owner.organizationId, { newOwnerMemberId: admin.memberId, password })).status).toBe(403);

    expect((await prisma.member.findUniqueOrThrow({ where: { id: ownerMember.id } })).role).toBe('owner');
    expect(await auditRows(owner.organizationId, 'OWNERSHIP_TRANSFERRED')).toHaveLength(0);
  });

  it("refuses when the new owner's account has no room for another workspace", async () => {
    const owner = await workspace('transfer-full');
    // Mooring allows one workspace, and this person already owns one.
    const busy = await workspace('transfer-full-target');
    const someone = await prisma.member.create({
      data: { id: `m-${fixtureId}-busy`, organizationId: owner.organizationId, userId: busy.userId, role: 'admin', createdAt: new Date() },
    });

    const refused = await transfer(owner.agent, owner.organizationId, { newOwnerMemberId: someone.id, password });
    expect(refused.status).toBe(402);
    expect(refused.body.error).toMatchObject({ code: 'NEW_OWNER_LIMIT_REACHED', quota: 'workspace', limit: 1, wouldHave: 2 });
    expect((await prisma.member.findUniqueOrThrow({ where: { id: someone.id } })).role).toBe('admin');
  });

  it("refuses when the workspace's clients would put the new owner's account over its limit", async () => {
    const owner = await workspace('transfer-clients');
    await grantPlan(owner.organizationId, 'HARBOR');
    const target = await workspace('transfer-clients-target');
    // Fairway: two workspaces, five clients. They own one workspace with four.
    await grantPlan(target.organizationId, 'FAIRWAY');
    for (let index = 0; index < 4; index += 1) {
      await prisma.client.create({ data: { organizationId: target.organizationId, name: `Own ${index}`, slug: `own-${index}-${fixtureId}` } });
    }
    for (let index = 0; index < 2; index += 1) {
      await prisma.client.create({ data: { organizationId: owner.organizationId, name: `Moving ${index}`, slug: `moving-${index}-${fixtureId}` } });
    }
    const member = await prisma.member.create({
      data: { id: `m-${fixtureId}-clients`, organizationId: owner.organizationId, userId: target.userId, role: 'admin', createdAt: new Date() },
    });

    const refused = await transfer(owner.agent, owner.organizationId, { newOwnerMemberId: member.id, password });
    expect(refused.status).toBe(402);
    expect(refused.body.error).toMatchObject({ code: 'NEW_OWNER_LIMIT_REACHED', quota: 'client', limit: 5, wouldHave: 6 });
  });

  it('refuses while the workspace carries a billed subscription', async () => {
    const owner = await workspace('transfer-billed');
    const admin = await joined(owner, 'transfer-billed-admin', 'admin');
    await prisma.subscription.upsert({
      where: { organizationId: owner.organizationId },
      create: { organizationId: owner.organizationId, userId: owner.userId, plan: 'FAIRWAY', status: 'ACTIVE', provider: 'PADDLE' },
      update: { status: 'ACTIVE', provider: 'PADDLE' },
    });

    const refused = await transfer(owner.agent, owner.organizationId, { newOwnerMemberId: admin.memberId, password });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SUBSCRIPTION_STILL_ACTIVE');
  });
});

describe('the seat refusal', () => {
  beforeEach(resetDatabase);

  it('names what it counted: members, then open invitations', async () => {
    const owner = await workspace('seat-sentence');
    expect((await invite(owner.agent, owner.organizationId, `seat-one-${fixtureId}@example.com`)).status).toBe(200);
    const refused = await invite(owner.agent, owner.organizationId, `seat-two-${fixtureId}@example.com`);
    expect(refused.status).toBe(402);
    expect(refused.body.message).toMatch(/^Mooring includes 2 team members and this workspace has 1 member and 1 open invitation\. /);
  });
});
