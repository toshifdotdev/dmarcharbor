import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { signJWT } from 'better-auth/crypto';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { env } from '../src/config/env.js';
import { mfaSessionGuard } from '../src/auth/auth.config.js';
import {
  createSessionForUser,
  ssoSessionCookie,
} from '../src/services/sso/sso-flow.service.js';
import { totpFromUri } from './helpers/totp.js';

const password = 'correct-horse-battery-staple';
let fixtureId = 0;

// A test-only deployment key, so the staff recovery route can be exercised.
// It is not a provider credential and matches no real secret format.
env.STAFF_API_KEY = 'test-staff-key-for-two-step-recovery';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "rate_limit_bucket", "audit_log", "email_delivery", "session", "account", "verification", "two_factor", member, invitation, "user", "organization" CASCADE',
  );
}

async function userWithAgent(): Promise<{
  agent: ReturnType<typeof request.agent>;
  email: string;
  userId: string;
}> {
  fixtureId += 1;
  const email = `mfa-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await request(app).post('/api/auth/sign-up/email').send({
    name: 'MFA Test',
    email,
    password,
  });
  expect(signUp.status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });

  const agent = request.agent(app);
  const signedIn = await agent.post('/api/auth/sign-in/email').send({ email, password });
  expect(signedIn.status).toBe(200);
  expect(signedIn.body.twoFactorRedirect).toBeUndefined();

  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  return { agent, email, userId: user.id };
}

async function createWorkspace(owner: ReturnType<typeof request.agent>, label: string): Promise<string> {
  fixtureId += 1;
  const slugLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const created = await owner.post('/api/workspaces').send({
    name: `${label} Agency ${fixtureId}`,
    slug: `${slugLabel}-agency-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.id as string;
}

async function addMember(
  organizationId: string,
  role: 'admin' | 'viewer' | 'portal',
): Promise<{
  agent: ReturnType<typeof request.agent>;
  email: string;
  userId: string;
  memberId: string;
}> {
  const user = await userWithAgent();
  const member = await prisma.member.create({
    data: {
      id: randomUUID(),
      organizationId,
      userId: user.userId,
      role,
      createdAt: new Date(),
    },
  });
  return { ...user, memberId: member.id };
}

async function enableMfaFor(
  agent: ReturnType<typeof request.agent>,
): Promise<{ totpURI: string; backupCodes: string[] }> {
  const enabled = await agent.post('/api/auth/two-factor/enable').send({ password });
  expect(enabled.status).toBe(200);
  expect(enabled.body.backupCodes).toHaveLength(10);
  const code = totpFromUri(enabled.body.totpURI as string);
  const confirmed = await agent.post('/api/auth/two-factor/verify-totp').send({ code });
  expect(confirmed.status).toBe(200);
  return { totpURI: enabled.body.totpURI as string, backupCodes: enabled.body.backupCodes as string[] };
}

async function challengeSignIn(email: string): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/sign-in/email').send({ email, password });
  expect(response.status).toBe(200);
  expect(response.body.twoFactorRedirect).toBe(true);
  expect((await agent.get('/api/me')).status).toBe(401);
  return agent;
}

function setCookies(response: request.Response): string {
  const raw = response.headers['set-cookie'] as unknown as string[] | string | undefined;
  return Array.isArray(raw) ? raw.join('\n') : raw ?? '';
}

async function emailFor(to: string, subjectPart: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const row = await prisma.emailDelivery.findFirst({
      where: { to, subject: { contains: subjectPart } },
    });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

describe('two-step verification', () => {
  beforeEach(resetDatabase);

  it('enables with a password and a code, revokes an earlier session and records one MFA_ENABLED', async () => {
    const { agent, email, userId } = await userWithAgent();
    const otherDevice = request.agent(app);
    expect((await otherDevice.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

    const wrongPassword = await agent.post('/api/auth/two-factor/enable').send({ password: 'not-the-password' });
    expect(wrongPassword.status).toBe(400);

    const enabled = await agent.post('/api/auth/two-factor/enable').send({ password });
    expect(enabled.status).toBe(200);
    expect(String(enabled.body.totpURI)).toContain('otpauth://');
    expect(enabled.body.backupCodes).toHaveLength(10);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).twoFactorEnabled).toBe(false);

    const right = totpFromUri(enabled.body.totpURI as string);
    const wrongCode = await agent.post('/api/auth/two-factor/verify-totp').send({
      code: right === '000000' ? '000001' : '000000',
    });
    expect(wrongCode.status).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).twoFactorEnabled).toBe(false);

    const confirmed = await agent.post('/api/auth/two-factor/verify-totp').send({ code: right });
    expect(confirmed.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).twoFactorEnabled).toBe(true);

    // The session opened before enrolment must not survive it.
    expect((await otherDevice.get('/api/me')).status).toBe(401);

    expect(await prisma.auditLog.count({ where: { action: 'MFA_ENABLED' } })).toBe(1);
    expect(await emailFor(email, 'Two-step verification was turned on')).not.toBeNull();
  });

  it('asks for a code at sign-in and does not record a second MFA_ENABLED', async () => {
    const { agent, email } = await userWithAgent();
    const { totpURI } = await enableMfaFor(agent);

    const challenge = await challengeSignIn(email);
    const verified = await challenge
      .post('/api/auth/two-factor/verify-totp')
      .send({ code: totpFromUri(totpURI) });
    expect(verified.status).toBe(200);
    expect((await challenge.get('/api/me')).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'MFA_ENABLED' } })).toBe(1);
  });

  it('answers TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE after the challenge budget is spent', async () => {
    const { agent, email } = await userWithAgent();
    const { totpURI } = await enableMfaFor(agent);

    const challenge = await challengeSignIn(email);
    const right = totpFromUri(totpURI);
    const wrong = right === '000000' ? '000001' : '000000';

    let sawTooMany = false;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await challenge.post('/api/auth/two-factor/verify-totp').send({ code: wrong });
      const code = (response.body?.code ?? response.body?.error?.code) as string | undefined;
      if (code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE') {
        sawTooMany = true;
        break;
      }
      expect(response.status).toBe(401);
    }
    expect(sawTooMany).toBe(true);
  });

  it('uses a backup code once, counts the rest and invalidates old codes when regenerated', async () => {
    const { agent, email } = await userWithAgent();
    const { backupCodes } = await enableMfaFor(agent);

    const firstChallenge = await challengeSignIn(email);
    const used = await firstChallenge
      .post('/api/auth/two-factor/verify-backup-code')
      .send({ code: backupCodes[0] });
    expect(used.status).toBe(200);
    expect((await firstChallenge.get('/api/me')).status).toBe(200);

    const usedAudit = await prisma.auditLog.findFirst({ where: { action: 'MFA_BACKUP_CODE_USED' } });
    expect((usedAudit?.detail as { remaining?: number } | null)?.remaining).toBe(9);
    expect(await emailFor(email, 'A backup code was used to sign in')).not.toBeNull();

    const reused = await challengeSignIn(email);
    const second = await reused
      .post('/api/auth/two-factor/verify-backup-code')
      .send({ code: backupCodes[0] });
    expect(second.status).toBe(401);
    expect((second.body?.code ?? second.body?.error?.code)).toBe('INVALID_BACKUP_CODE');

    const regenerated = await firstChallenge
      .post('/api/auth/two-factor/generate-backup-codes')
      .send({ password });
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.backupCodes).toHaveLength(10);

    const afterRegeneration = await challengeSignIn(email);
    const old = await afterRegeneration
      .post('/api/auth/two-factor/verify-backup-code')
      .send({ code: backupCodes[1] });
    expect(old.status).toBe(401);

    const fresh = await afterRegeneration
      .post('/api/auth/two-factor/verify-backup-code')
      .send({ code: regenerated.body.backupCodes[0] });
    expect(fresh.status).toBe(200);

    expect(await prisma.auditLog.count({ where: { action: 'MFA_BACKUP_CODES_REGENERATED' } })).toBe(1);
    expect(await emailFor(email, 'New backup codes were generated')).not.toBeNull();
  });

  it('never sets a trust-device cookie even when the client asks for one', async () => {
    const { agent, email } = await userWithAgent();
    const { totpURI } = await enableMfaFor(agent);
    const challenge = await challengeSignIn(email);

    const verified = await challenge.post('/api/auth/two-factor/verify-totp').send({
      code: totpFromUri(totpURI),
      trustDevice: true,
    });
    expect(verified.status).toBe(200);
    expect(setCookies(verified)).not.toContain('trust_device');
  });

  it('does not create a session from the email verification auto sign-in', async () => {
    const { agent, email, userId } = await userWithAgent();
    await enableMfaFor(agent);
    const sessionsBefore = await prisma.session.count({ where: { userId } });

    // A verification link is a single-factor credential. Put the account back
    // to unverified so the endpoint actually reaches its auto sign-in branch;
    // Better Auth returns early for an already-verified address and would never
    // exercise the guard.
    await prisma.user.update({ where: { id: userId }, data: { emailVerified: false } });

    const token = await signJWT({ email }, env.BETTER_AUTH_SECRET, 3600);
    const response = await request(app).get(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(setCookies(response)).not.toContain('session_token');

    expect(await prisma.session.count({ where: { userId } })).toBe(sessionsBefore);
    const refused = await prisma.auditLog.findFirst({ where: { action: 'MFA_SIGN_IN_REFUSED' } });
    expect((refused?.detail as { path?: string } | null)?.path).toBe('/verify-email');
  });

  it('turns off with the password and stops asking for a code', async () => {
    const { agent, email } = await userWithAgent();
    await enableMfaFor(agent);

    const wrong = await agent.post('/api/auth/two-factor/disable').send({ password: 'not-the-password' });
    expect(wrong.status).toBe(400);

    const disabled = await agent.post('/api/auth/two-factor/disable').send({ password });
    expect(disabled.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'MFA_DISABLED' } })).toBe(1);
    expect(await emailFor(email, 'Two-step verification was turned off')).not.toBeNull();

    const signedIn = await request(app).post('/api/auth/sign-in/email').send({ email, password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.twoFactorRedirect).toBeUndefined();
  });

  it('refuses an OAuth callback path when the account has two-step verification', async () => {
    const { agent, userId } = await userWithAgent();
    await enableMfaFor(agent);

    expect(await mfaSessionGuard({ userId }, { path: '/callback/google' })).toBe(false);
    const refused = await prisma.auditLog.findFirst({
      where: { action: 'MFA_SIGN_IN_REFUSED' },
      orderBy: { createdAt: 'desc' },
    });
    expect((refused?.detail as { path?: string } | null)?.path).toBe('/callback/google');

    // No endpoint context is server-side code, which is trusted.
    expect(await mfaSessionGuard({ userId }, null)).toBe(true);
  });

  it('enforces the requirement across workspace routes while leaving account routes open', async () => {
    const owner = await userWithAgent();
    const organizationId = await createWorkspace(owner.agent, 'Gate');
    const member = await addMember(organizationId, 'viewer');

    expect((await member.agent.get(`/api/workspaces/${organizationId}/clients`)).status).toBe(200);

    await enableMfaFor(owner.agent);
    const turnedOn = await owner.agent
      .put(`/api/workspaces/${organizationId}/security`)
      .send({ requireMfa: true });
    expect(turnedOn.status).toBe(200);
    expect(turnedOn.body.membersWithout).toBe(1);

    const clients = await member.agent.get(`/api/workspaces/${organizationId}/clients`);
    expect(clients.status).toBe(403);
    expect(clients.body.error.code).toBe('MFA_REQUIRED');
    expect(clients.body.error.setupUrl).toBe('/account/security');
    expect(clients.body.error.workspaceName).toContain('Gate Agency');

    const beforeDpa = await member.agent.get(`/api/workspaces/${organizationId}/report-shares`);
    expect(beforeDpa.status).toBe(403);
    expect(beforeDpa.body.error.code).toBe('MFA_REQUIRED');

    expect((await member.agent.get('/api/me/security')).status).toBe(200);
    expect((await member.agent.get('/api/workspaces')).status).toBe(200);
    expect((await member.agent.get('/api/auth/get-session')).status).toBe(200);

    const portal = await addMember(organizationId, 'portal');
    expect((await portal.agent.get(`/api/workspaces/${organizationId}/clients`)).status).toBe(200);

    const ssoMember = await addMember(organizationId, 'viewer');
    const sso = await createSessionForUser(ssoMember.userId, {});
    const ssoCookie = await ssoSessionCookie(sso.token, sso.expiresAt);
    const ssoResponse = await request(app)
      .get(`/api/workspaces/${organizationId}/clients`)
      .set('Cookie', `${ssoCookie.name}=${encodeURIComponent(ssoCookie.value)}`);
    expect(ssoResponse.status).toBe(200);

    await enableMfaFor(member.agent);
    expect((await member.agent.get(`/api/workspaces/${organizationId}/clients`)).status).toBe(200);

    const otherOwner = await userWithAgent();
    const otherOrganizationId = await createWorkspace(otherOwner.agent, 'Elsewhere');
    await prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: otherOrganizationId,
        userId: member.userId,
        role: 'viewer',
        createdAt: new Date(),
      },
    });
    expect((await member.agent.get(`/api/workspaces/${otherOrganizationId}/clients`)).status).toBe(200);
  });

  it('requires the owner to enrol before turning the requirement on, and records the change', async () => {
    const owner = await userWithAgent();
    const organizationId = await createWorkspace(owner.agent, 'Security');
    const admin = await addMember(organizationId, 'admin');
    await addMember(organizationId, 'viewer');

    const lacking = await owner.agent
      .put(`/api/workspaces/${organizationId}/security`)
      .send({ requireMfa: true });
    expect(lacking.status).toBe(409);
    expect(lacking.body.error.code).toBe('MFA_REQUIRED_FOR_CALLER');

    const adminAttempt = await admin.agent
      .put(`/api/workspaces/${organizationId}/security`)
      .send({ requireMfa: true });
    expect(adminAttempt.status).toBe(403);

    await enableMfaFor(owner.agent);
    const enabled = await owner.agent
      .put(`/api/workspaces/${organizationId}/security`)
      .send({ requireMfa: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.requireMfa).toBe(true);
    expect(enabled.body.membersWithout).toBe(2);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'WORKSPACE_MFA_REQUIREMENT_CHANGED' },
    });
    expect(audit?.organizationId).toBe(organizationId);
    expect(audit?.detail).toEqual({ from: false, to: true });
  });

  it('lets an owner reset a member, and refuses admin, self and cross-workspace resets', async () => {
    const owner = await userWithAgent();
    const organizationId = await createWorkspace(owner.agent, 'Reset');
    const member = await addMember(organizationId, 'viewer');
    await enableMfaFor(member.agent);

    const ownerMember = await prisma.member.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId, userId: owner.userId } },
    });

    const reset = await owner.agent.post(
      `/api/workspaces/${organizationId}/members/${member.memberId}/mfa/reset`,
    );
    expect(reset.status).toBe(200);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: member.userId } })).twoFactorEnabled,
    ).toBe(false);
    expect(await prisma.session.count({ where: { userId: member.userId } })).toBe(0);
    expect((await member.agent.get('/api/me')).status).toBe(401);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'MFA_RESET' } });
    expect(audit?.organizationId).toBe(organizationId);
    expect(audit?.detail).toEqual({ by: 'owner' });

    const admin = await addMember(organizationId, 'admin');
    const adminAttempt = await admin.agent.post(
      `/api/workspaces/${organizationId}/members/${member.memberId}/mfa/reset`,
    );
    expect(adminAttempt.status).toBe(403);
    expect(adminAttempt.body.error.code).toBe('MFA_RESET_OWNER_ONLY');

    const self = await owner.agent.post(
      `/api/workspaces/${organizationId}/members/${ownerMember.id}/mfa/reset`,
    );
    expect(self.status).toBe(400);

    const otherOwner = await userWithAgent();
    const otherOrganizationId = await createWorkspace(otherOwner.agent, 'Other reset');
    const stranger = await addMember(otherOrganizationId, 'viewer');
    const crossWorkspace = await owner.agent.post(
      `/api/workspaces/${organizationId}/members/${stranger.memberId}/mfa/reset`,
    );
    expect(crossWorkspace.status).toBe(404);
  });

  it('lets staff reset with a reason, and records it without a workspace', async () => {
    const { agent, userId } = await userWithAgent();
    await enableMfaFor(agent);

    const withoutKey = await request(app)
      .post(`/api/staff/users/${userId}/mfa/reset`)
      .send({ reason: 'Sole owner lost the authenticator and backup codes.' });
    expect(withoutKey.status).toBe(403);

    const shortReason = await request(app)
      .post(`/api/staff/users/${userId}/mfa/reset`)
      .set('Authorization', `Bearer ${env.STAFF_API_KEY}`)
      .send({ reason: 'short' });
    expect(shortReason.status).toBe(400);

    const reset = await request(app)
      .post(`/api/staff/users/${userId}/mfa/reset`)
      .set('Authorization', `Bearer ${env.STAFF_API_KEY}`)
      .send({ reason: 'Sole owner lost the authenticator and backup codes.' });
    expect(reset.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).twoFactorEnabled).toBe(false);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'MFA_RESET', organizationId: null },
    });
    expect(audit?.detail).toMatchObject({ by: 'staff' });
  });

  it('shows the two-step field to owners but omits it for a viewer', async () => {
    const owner = await userWithAgent();
    const organizationId = await createWorkspace(owner.agent, 'Roster');
    const enrolled = await addMember(organizationId, 'viewer');
    await enableMfaFor(enrolled.agent);
    const viewer = await addMember(organizationId, 'viewer');

    const ownerList = await owner.agent.get(`/api/workspaces/${organizationId}/members`);
    expect(ownerList.status).toBe(200);
    expect(
      (ownerList.body.members as Array<{ twoFactorEnabled?: boolean }>).every(
        (row) => typeof row.twoFactorEnabled === 'boolean',
      ),
    ).toBe(true);

    const viewerList = await viewer.agent.get(`/api/workspaces/${organizationId}/members`);
    expect(viewerList.status).toBe(200);
    expect(
      (viewerList.body.members as Array<{ twoFactorEnabled?: boolean }>).every(
        (row) => row.twoFactorEnabled === undefined,
      ),
    ).toBe(true);
  });

  it('accepts the signed SSO session cookie and refuses the raw token', async () => {
    const { userId } = await userWithAgent();
    const { token, expiresAt } = await createSessionForUser(userId, {});
    const cookie = await ssoSessionCookie(token, expiresAt);

    const signed = await request(app)
      .get('/api/me')
      .set('Cookie', `${cookie.name}=${encodeURIComponent(cookie.value)}`);
    expect(signed.status).toBe(200);
    expect(signed.body.user.id).toBe(userId);

    const session = await request(app)
      .get('/api/auth/get-session')
      .set('Cookie', `${cookie.name}=${encodeURIComponent(cookie.value)}`);
    expect(session.status).toBe(200);
    expect(session.body.session.authMethod).toBe('sso');

    const raw = await request(app)
      .get('/api/me')
      .set('Cookie', `${cookie.name}=${token}`);
    expect(raw.status).toBe(401);
  });
});
