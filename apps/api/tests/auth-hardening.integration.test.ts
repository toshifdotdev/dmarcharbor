import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/database/prisma.js';
import { drainEmailQueue, enqueueEmail } from '../src/services/email-queue.service.js';
import { totpFromUri } from './helpers/totp.js';

/**
 * The session 1 findings, each closed and pinned here:
 * - a TOTP code works once;
 * - an OAuth failure lands on our sign-in page, not the library's;
 * - ten wrong passwords pause password sign-in for that address, audited,
 *   with one email to the owner;
 * - a password reset or change is audited and confirmed by email;
 * - a new password found in a breach is refused;
 * - mail to a reserved domain is never handed to the provider.
 */

const password = 'correct-horse-battery-staple';
let fixtureId = 0;

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "rate_limit_bucket", "audit_log", "email_delivery", "session", "account", "verification", "two_factor", member, invitation, "user", "organization" CASCADE',
  );
}

async function verifiedUser(): Promise<{ email: string; userId: string }> {
  fixtureId += 1;
  const email = `hardening-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await request(app).post('/api/auth/sign-up/email').send({ name: 'Hardening Test', email, password });
  expect(signUp.status, JSON.stringify(signUp.body)).toBe(200);
  const user = await prisma.user.update({ where: { email }, data: { emailVerified: true }, select: { id: true } });
  return { email, userId: user.id };
}

function errorCode(response: request.Response): string | undefined {
  return (response.body?.code ?? response.body?.error?.code) as string | undefined;
}

async function queuedEmail(to: string, subjectPart: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = await prisma.emailDelivery.findFirst({ where: { to, subject: { contains: subjectPart } } });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/** Waits for the after hooks, which write audit rows once the response is sent. */
async function auditCount(action: 'SIGN_IN_FAILED' | 'SIGN_IN_PAUSED' | 'PASSWORD_RESET' | 'PASSWORD_CHANGED', expected: number) {
  let count = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    count = await prisma.auditLog.count({ where: { action } });
    if (count >= expected) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return count;
}

describe('one use per authenticator code', () => {
  beforeEach(resetDatabase);

  async function enabledUser() {
    const { email } = await verifiedUser();
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
    const enabled = await agent.post('/api/auth/two-factor/enable').send({ password });
    expect(enabled.status).toBe(200);
    const totpURI = enabled.body.totpURI as string;
    const setupCode = totpFromUri(totpURI);
    expect((await agent.post('/api/auth/two-factor/verify-totp').send({ code: setupCode })).status).toBe(200);
    return { email, totpURI, setupCode };
  }

  async function challenge(email: string) {
    const agent = request.agent(app);
    const response = await agent.post('/api/auth/sign-in/email').send({ email, password });
    expect(response.body.twoFactorRedirect).toBe(true);
    return agent;
  }

  it('refuses the code that set two-step up, and a code that already signed someone in', async () => {
    const { email, totpURI, setupCode } = await enabledUser();

    // The code that turned two-step on cannot sign in straight after.
    const reusedSetup = await (await challenge(email)).post('/api/auth/two-factor/verify-totp').send({ code: setupCode });
    expect(reusedSetup.status).toBe(401);
    expect(errorCode(reusedSetup)).toBe('TOTP_CODE_REUSED');

    const next = totpFromUri(totpURI, Date.now() + 30_000);
    const first = await challenge(email);
    expect((await first.post('/api/auth/two-factor/verify-totp').send({ code: next })).status).toBe(200);
    expect((await first.get('/api/me')).status).toBe(200);

    // Same code, second device, inside its window: refused.
    const second = await challenge(email);
    const replay = await second.post('/api/auth/two-factor/verify-totp').send({ code: next });
    expect(replay.status).toBe(401);
    expect(errorCode(replay)).toBe('TOTP_CODE_REUSED');
    expect((await second.get('/api/me')).status).toBe(401);
  });

  it('does not spend a code that was refused as wrong', async () => {
    const { email, totpURI } = await enabledUser();
    const right = totpFromUri(totpURI, Date.now() + 30_000);
    const wrong = right === '000000' ? '000001' : '000000';

    const agent = await challenge(email);
    expect((await agent.post('/api/auth/two-factor/verify-totp').send({ code: wrong })).status).toBe(401);
    // The wrong code's claim was released, and the right one still works.
    expect((await agent.post('/api/auth/two-factor/verify-totp').send({ code: right })).status).toBe(200);
  });
});

describe('OAuth failures', () => {
  it("sends the library's error page to our sign-in page with the code", async () => {
    const response = await request(app).get('/api/auth/error?error=state_mismatch');
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(`${env.APP_URL.replace(/\/+$/, '')}/sign-in`);
    expect(location.searchParams.get('error')).toBe('state_mismatch');
  });

  it('lands a callback with an unknown state on our sign-in page', async () => {
    const response = await request(app).get('/api/auth/callback/google?code=abc&state=not-a-real-state');
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(`${env.APP_URL.replace(/\/+$/, '')}/sign-in`);
    expect(location.searchParams.get('error')).toMatch(/^[a-z_]+$/);
  });
});

describe('the per-account sign-in brake', () => {
  beforeEach(resetDatabase);

  async function wrongPasswords(email: string, count: number) {
    for (let attempt = 0; attempt < count; attempt += 1) {
      const response = await request(app).post('/api/auth/sign-in/email').send({ email, password: `wrong-password-${attempt}` });
      expect(response.status, `attempt ${attempt + 1}`).toBe(401);
    }
  }

  it('pauses after 10 wrong passwords, even for the right one, audits each and emails the owner once', async () => {
    const { email, userId } = await verifiedUser();

    // Nine, then the right password: the count starts again.
    await wrongPasswords(email, 9);
    expect((await request(app).post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

    await wrongPasswords(email, 10);
    const paused = await request(app).post('/api/auth/sign-in/email').send({ email, password });
    expect(paused.status).toBe(429);
    expect(errorCode(paused)).toBe('SIGN_IN_PAUSED');
    const retryAfter = Number(paused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(14 * 60);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);

    expect(await auditCount('SIGN_IN_FAILED', 19)).toBe(19);
    expect(await auditCount('SIGN_IN_PAUSED', 1)).toBe(1);
    const failed = await prisma.auditLog.findFirst({ where: { action: 'SIGN_IN_FAILED' } });
    expect(failed).toMatchObject({ outcome: 'DENIED', targetType: 'user', targetId: userId, actorUserId: null });

    const pausedEmail = await queuedEmail(email, 'Sign-in to your account was paused');
    expect(pausedEmail?.text).toContain('10 times in 15 minutes');
    expect(await prisma.emailDelivery.count({ where: { to: email, subject: { contains: 'paused' } } })).toBe(1);
  });

  it('pauses an address nobody has the same way, and records and sends nothing for it', async () => {
    const email = `nobody-${Date.now()}@example.com`;
    await wrongPasswords(email, 10);
    const paused = await request(app).post('/api/auth/sign-in/email').send({ email, password });
    expect(paused.status).toBe(429);
    expect(errorCode(paused)).toBe('SIGN_IN_PAUSED');
    expect(await prisma.auditLog.count()).toBe(0);
    expect(await prisma.emailDelivery.count({ where: { to: email } })).toBe(0);
  });

  it('lets a password reset end the pause', async () => {
    const { email } = await verifiedUser();
    await wrongPasswords(email, 10);
    expect((await request(app).post('/api/auth/sign-in/email').send({ email, password })).status).toBe(429);

    expect((await request(app).post('/api/auth/request-password-reset').send({ email, redirectTo: '/sign-in' })).status).toBe(200);
    const reset = await queuedEmail(email, 'Reset your');
    const token = /\/reset-password\/([^?\s]+)/.exec(reset?.text ?? '')?.[1];
    expect(token).toBeTruthy();
    const newPassword = 'a-fresh-password-for-the-brake';
    expect((await request(app).post('/api/auth/reset-password').send({ token, newPassword })).status).toBe(200);

    expect((await request(app).post('/api/auth/sign-in/email').send({ email, password: newPassword })).status).toBe(200);
  });
});

describe('password changes', () => {
  beforeEach(resetDatabase);

  it('audits a reset and confirms it by email', async () => {
    const { email, userId } = await verifiedUser();
    expect((await request(app).post('/api/auth/request-password-reset').send({ email, redirectTo: '/sign-in' })).status).toBe(200);
    const reset = await queuedEmail(email, 'Reset your');
    const token = /\/reset-password\/([^?\s]+)/.exec(reset?.text ?? '')?.[1];
    expect((await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'a-new-reset-password-2026' })).status).toBe(200);

    expect(await auditCount('PASSWORD_RESET', 1)).toBe(1);
    expect(await prisma.auditLog.findFirst({ where: { action: 'PASSWORD_RESET' } })).toMatchObject({
      actorUserId: userId,
      targetId: userId,
    });
    const confirmation = await queuedEmail(email, 'Your password was changed');
    expect(confirmation?.text).toContain('with a reset link');
  });

  it('audits a change from the account and confirms it by email', async () => {
    const { email } = await verifiedUser();
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
    const changed = await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: password, newPassword: 'a-changed-password-2026' });
    expect(changed.status).toBe(200);

    expect(await auditCount('PASSWORD_CHANGED', 1)).toBe(1);
    const confirmation = await queuedEmail(email, 'Your password was changed');
    expect(confirmation?.text).toContain('every other device');
  });

  it('sends nothing when the change is refused', async () => {
    const { email } = await verifiedUser();
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
    const refused = await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: 'not-the-password', newPassword: 'a-changed-password-2026' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await prisma.auditLog.count({ where: { action: 'PASSWORD_CHANGED' } })).toBe(0);
    expect(await prisma.emailDelivery.count({ where: { to: email, subject: { contains: 'password was changed' } } })).toBe(0);
  });
});

describe('breached passwords', () => {
  const breached = 'breached-password-2026';
  const suffix = createHash('sha1').update(breached).digest('hex').toUpperCase().slice(5);
  const realFetch = globalThis.fetch;
  const asked: string[] = [];

  beforeEach(async () => {
    await resetDatabase();
    env.PASSWORD_BREACH_CHECK = true;
    asked.length = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://api.pwnedpasswords.com/range/')) {
        asked.push(url);
        return new Response(`${suffix}:12\r\n0018A45C4D1DEF81644B54AB7F969B88D65:0`, { status: 200 });
      }
      return realFetch(input, init);
    });
  });

  afterEach(() => {
    env.PASSWORD_BREACH_CHECK = false;
    vi.restoreAllMocks();
  });

  it('refuses a breached password at sign-up and creates no account', async () => {
    const email = `breached-${Date.now()}@example.com`;
    const refused = await request(app).post('/api/auth/sign-up/email').send({ name: 'Breached', email, password: breached });
    expect(refused.status).toBe(400);
    expect(errorCode(refused)).toBe('PASSWORD_COMPROMISED');
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    // Only the five-character prefix left the process.
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toContain(suffix);
  });

  it('accepts a password the range does not list', async () => {
    const email = `clean-${Date.now()}@example.com`;
    const accepted = await request(app).post('/api/auth/sign-up/email').send({ name: 'Clean', email, password });
    expect(accepted.status).toBe(200);
  });

  it('refuses a breached password as the new one on a change', async () => {
    env.PASSWORD_BREACH_CHECK = false;
    const { email } = await verifiedUser();
    env.PASSWORD_BREACH_CHECK = true;
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
    const refused = await agent.post('/api/auth/change-password').send({ currentPassword: password, newPassword: breached });
    expect(refused.status).toBe(400);
    expect(errorCode(refused)).toBe('PASSWORD_COMPROMISED');
  });

  it('lets the password through when the service cannot be reached', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    const email = `offline-${Date.now()}@example.com`;
    const accepted = await request(app).post('/api/auth/sign-up/email').send({ name: 'Offline', email, password: breached });
    expect(accepted.status).toBe(200);
  });
});

describe('mail to reserved domains', () => {
  const original = { provider: env.EMAIL_PROVIDER, key: env.RESEND_API_KEY };

  beforeEach(async () => {
    await resetDatabase();
    env.EMAIL_PROVIDER = 'resend';
    env.RESEND_API_KEY = 're_test_not_a_real_key';
  });

  afterEach(() => {
    env.EMAIL_PROVIDER = original.provider;
    env.RESEND_API_KEY = original.key;
  });

  it('records it as SKIPPED on the first attempt and never retries it', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    for (const to of ['toshif@dmarcharbor.test', 'it@pellowyn.example', 'x@verify.invalid']) {
      await enqueueEmail({ kind: 'notification', to, subject: 'A sample alert', html: '<p>x</p>', text: 'x' });
    }

    const swept = await drainEmailQueue();
    expect(swept).toMatchObject({ sent: 0, retried: 0, dead: 0, skipped: 3 });

    const rows = await prisma.emailDelivery.findMany();
    expect(rows.map((row) => row.state)).toEqual(['SKIPPED', 'SKIPPED', 'SKIPPED']);
    expect(rows.every((row) => row.attempts === 1 && row.sentAt === null)).toBe(true);
    expect(rows.find((row) => row.to === 'toshif@dmarcharbor.test')?.lastError).toContain('.test is a reserved top-level domain');

    // Nothing is due again.
    expect(await drainEmailQueue()).toMatchObject({ sent: 0, retried: 0, dead: 0, skipped: 0 });
    vi.restoreAllMocks();
  });
});
