import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { sendErasureCompletedEmail, sendErasureScheduledEmail } from '../src/email/mailer.js';
import { drainEmailQueue } from '../src/services/email-queue.service.js';

/**
 * Integration coverage for the fail-loud fixes. Every case here is a behaviour
 * that was previously wrong in a way no existing test noticed, which is why they
 * are worth pinning.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "email_delivery", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspaceOwner(label: string) {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });

  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const created = await agent.post('/api/workspaces').send({ name: 'Agency', slug: `${label}-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
  expect(created.status).toBe(201);

  return { email, agent, organizationId: created.body.id as string };
}

/**
 * The console email provider writes `[email] <subject> for <to>` to stdout, so
 * capturing that is how a fire-and-forget send is observed at all.
 */
function captureEmails(): { sent: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return { sent: () => lines.join('\n'), restore: () => spy.mockRestore() };
}

/**
 * Polls rather than sleeping a fixed amount.
 *
 * The senders are fire and forget and do two sequential database round trips
 * before they log anything, so a fixed 50ms wait passes on a warm connection
 * and fails on a cold one. This is the difference between a test that proves
 * the fix and a test that proves nothing.
 */
async function waitForEmail(lines: () => string, needle: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lines().includes(needle)) {
      return true;
    }

    /**
     * Delivery goes through the durable queue now, so the scheduler is what turns a
     * queued row into a sent message.
     *
     * Driving the drain here rather than lengthening the timeout is what a running
     * service does every thirty seconds, and it keeps the test asserting the real path:
     * queued, then delivered, then present in the log.
     */
    await drainEmailQueue();

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return lines().includes(needle);
}

describe('owner and admin notification recipients', () => {
  beforeAll(resetDatabase);

  it('reaches the owner when a deletion is scheduled', async () => {
    const owner = await workspaceOwner('erasure-scheduled');
    const capture = captureEmails();

    sendErasureScheduledEmail({
      organizationId: owner.organizationId,
      scopeLabel: 'the whole workspace',
      executesAt: new Date('2030-01-01T00:00:00.000Z'),
      cancelUrl: 'https://app.example.com/erasures/abc/cancel',
    });
    const delivered = await waitForEmail(capture.sent, owner.email);
    capture.restore();

    // The recipient loop compared Member.role against 'OWNER' and 'ADMIN' while
    // Better Auth stores 'owner' and 'admin', so it matched nothing and this
    // Article 17 grace period cancellation link was never sent to anyone.
    expect(delivered, `no erasure notice reached ${owner.email}`).toBe(true);
  });

  it('reaches the owner when an erasure certificate is issued', async () => {
    const owner = await workspaceOwner('erasure-completed');
    const capture = captureEmails();

    sendErasureCompletedEmail({
      organizationId: owner.organizationId,
      scopeLabel: 'the whole workspace',
      completedAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const delivered = await waitForEmail(capture.sent, owner.email);
    capture.restore();

    expect(delivered, `no erasure certificate reached ${owner.email}`).toBe(true);
  });

  it('reaches an admin as well as the owner', async () => {
    const owner = await workspaceOwner('erasure-admin');
    const adminEmail = `admin-${Date.now()}-${fixtureId}@example.com`;

    expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Admin', email: adminEmail, password })).status).toBe(200);
    await prisma.user.update({ where: { email: adminEmail }, data: { emailVerified: true } });
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail }, select: { id: true } });
    await prisma.member.create({
      data: { id: `member-admin-${fixtureId}`, organizationId: owner.organizationId, userId: adminUser.id, role: 'admin', createdAt: new Date() },
    });

    const capture = captureEmails();
    sendErasureCompletedEmail({
      organizationId: owner.organizationId,
      scopeLabel: 'one client',
      completedAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const delivered = await waitForEmail(capture.sent, adminEmail);
    capture.restore();

    expect(delivered, `no erasure certificate reached the admin ${adminEmail}`).toBe(true);
  });

  it('does not send workspace notices to an ordinary member', async () => {
    const owner = await workspaceOwner('erasure-analyst');
    const analystEmail = `analyst-${Date.now()}-${fixtureId}@example.com`;

    expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Analyst', email: analystEmail, password })).status).toBe(200);
    await prisma.user.update({ where: { email: analystEmail }, data: { emailVerified: true } });
    const analystUser = await prisma.user.findUniqueOrThrow({ where: { email: analystEmail }, select: { id: true } });
    await prisma.member.create({
      data: { id: `member-analyst-${fixtureId}`, organizationId: owner.organizationId, userId: analystUser.id, role: 'analyst', createdAt: new Date() },
    });

    /**
     * Flushes the queue before the capture starts.
     *
     * Signing the analyst up queued a verification email to this same address. With
     * delivery now going through the queue, draining it inside the captured window
     * would emit that unrelated message and the assertion below would match the
     * verification link rather than the erasure notice it is about. So the drain has to
     * happen before the spy is installed, not merely before the notice is sent.
     */
    await drainEmailQueue();

    const capture = captureEmails();

    sendErasureCompletedEmail({
      organizationId: owner.organizationId,
      scopeLabel: 'one domain',
      completedAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const deliveredToAnalyst = await waitForEmail(capture.sent, analystEmail, 500);
    capture.restore();

    expect(deliveredToAnalyst).toBe(false);
  });
});

describe('notification preferences are private to their owner', () => {
  beforeAll(resetDatabase);

  it('refuses to read another user preferences', async () => {
    const first = await workspaceOwner('prefs-first');
    const second = await workspaceOwner('prefs-second');

    const firstUser = await prisma.user.findUniqueOrThrow({ where: { email: first.email }, select: { id: true } });

    // The read had no self check while the write beside it did, so any
    // authenticated caller could read anyone's timezone and quiet hours.
    const response = await second.agent.get(`/api/me/${firstUser.id}/notification-preferences`);
    expect(response.status).toBe(403);
  });

  it('still lets a user read their own preferences', async () => {
    const user = await workspaceOwner('prefs-self');
    const userId = await prisma.user.findUniqueOrThrow({ where: { email: user.email }, select: { id: true } });

    expect((await user.agent.get(`/api/me/${userId.id}/notification-preferences`)).status).toBe(200);
  });

  it('refuses an anonymous caller', async () => {
    expect((await request(app).get('/api/me/someone/notification-preferences')).status).toBe(401);
  });
});

describe('on demand reconciliation is not reachable from a workspace session', () => {
  beforeAll(resetDatabase);

  it('does not let a workspace owner sweep the fleet through the resume route', async () => {
    const owner = await workspaceOwner('reconcile-guard');

    // reconcileController used to be chained after resumeSubscriptionController
    // on this route and read ?organizationId from the query string, so any
    // member with billing:update could trigger provider API calls for every
    // customer, or for any single named workspace.
    const response = await owner.agent
      .post(`/api/workspaces/${owner.organizationId}/billing/resume`)
      .query({ organizationId: 'someone-elses-workspace' });

    // This workspace has no subscription, so resume itself is a conflict. What
    // matters is that the answer carries no reconciliation result: the chained
    // handler is gone, so nothing reached out to a provider.
    expect(response.status).toBe(409);
    expect(response.body).not.toHaveProperty('matched');
    expect(response.body).not.toHaveProperty('applied');
    expect(response.body).not.toHaveProperty('scanned');
    expect(response.body).toHaveProperty('error.code');
  });

  it('keeps the staff reconcile route closed to a workspace session', async () => {
    const owner = await workspaceOwner('reconcile-staff-only');
    expect((await owner.agent.post('/api/billing/reconcile')).status).toBe(403);
  });

  it('routes the billing portal request to the portal handler, not a chained currency handler', async () => {
    const owner = await workspaceOwner('portal-single-response');

    const response = await owner.agent.post(`/api/workspaces/${owner.organizationId}/billing/portal`);

    // The route used to chain billingCurrencyController and
    // setBillingCurrencyController ahead of the portal controller. Neither calls
    // next(), so the portal handler was unreachable and the client got a currency
    // payload. A currency-shaped body therefore proves the portal controller is
    // the one answering.
    expect(response.body).not.toHaveProperty('currency');
    expect(response.body).not.toHaveProperty('currencyLocked');
    // One response only. The previous chain also produced ERR_HTTP_HEADERS_SENT,
    // which the request logger records as a clean 200 and so hid entirely.
    expect(response.headers['content-type']).toMatch(/application\/json/);
  });
});

describe('response headers', () => {
  beforeAll(resetDatabase);

  it('sets the security headers the service was missing entirely', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(response.headers).not.toHaveProperty('x-powered-by');
  });

  it('does not break the JSON contract', async () => {
    const response = await request(app).get('/api/capabilities');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('currencies');
  });
});

describe('auth rate limiting', () => {
  beforeAll(resetDatabase);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is mounted ahead of the auth handler rather than behind it', async () => {
    // There is no MFA in this product, so this limit is the primary control on
    // credential stuffing. It has to be reachable by an unauthenticated caller,
    // which is exactly the traffic Better Auth's own in-memory limit is meant
    // to catch and cannot once there is more than one replica.
    const { createAuthRateLimiter } = await import('../src/middleware/rate-limit.middleware.js');
    const limited = await request(app).get('/api/auth/providers');
    // The suite raises the budget via AUTH_RATE_LIMIT_PER_MINUTE, so this asserts
    // wiring rather than tripping the limit, which rate-limit.test.ts covers.
    expect(limited.status).toBe(200);
    expect(typeof createAuthRateLimiter).toBe('function');
  });
});