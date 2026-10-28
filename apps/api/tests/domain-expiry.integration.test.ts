import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { grantPlan } from './helpers/plan.js';
import type { GuardedRequestInput, GuardedResult } from '../src/services/net/guarded-request.js';
import { rdapBootstrapUrl, setRdapRequesterForTests } from '../src/services/monitoring/rdap.js';
import { runDomainExpiryPass } from '../src/services/monitoring/domain-expiry.service.js';
import { deleteDomain } from '../src/services/lifecycle-deletion.service.js';

/**
 * Domain-expiry alerts end to end: RDAP lookup, the stored date, the warning
 * ladder, delivery, plan gating, renewal and deletion.
 *
 * The registry is an in-memory fake behind the RDAP requester seam, keyed on
 * the registrable domain, so each test sets the date it wants and moves the
 * clock with the `now` the pass takes.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const day = 24 * 60 * 60 * 1000;

/** Registrable domain -> what the registry says. */
let registry: Map<string, { expiresAt?: string; status?: number; fail?: boolean }>;
let lookups: string[];

function ok(body: unknown, statusCode = 200): GuardedResult {
  return { status: 'ok', statusCode, headers: {}, body: Buffer.from(JSON.stringify(body), 'utf8') };
}

function fakeRegistry(input: GuardedRequestInput): GuardedResult {
  if (input.url === rdapBootstrapUrl) {
    return ok({ services: [[['example'], ['https://rdap.registry.test/']]] });
  }
  const name = decodeURIComponent(input.url.replace('https://rdap.registry.test/domain/', ''));
  lookups.push(name);
  const entry = registry.get(name);
  if (!entry) return ok({}, 404);
  if (entry.fail) return { status: 'error', failure: 'timeout', detail: 'The server did not answer in time.' };
  if (entry.status) return ok({}, entry.status);
  return ok({
    objectClassName: 'domain',
    ldhName: name,
    events: entry.expiresAt ? [{ eventAction: 'expiration', eventDate: entry.expiresAt }] : [],
    entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar']]] }],
  });
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "domain_registration", "notification", "email_delivery", "slack_destination", "teams_destination", "rate_limit_bucket", "audit_log", "session", "account", "verification", "two_factor", member, invitation, "user", "organization" CASCADE',
  );
}

beforeEach(async () => {
  await resetDatabase();
  registry = new Map();
  lookups = [];
  setRdapRequesterForTests(async (input) => fakeRegistry(input));
});

afterEach(() => {
  setRdapRequesterForTests(null);
});

async function setup(plan: 'HARBOR' | 'MOORING' = 'HARBOR', names: string[] = []) {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `expiry-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Expiry Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Expiry Agency',
    slug: `expiry-agency-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId, plan);

  const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name: 'Acme Ltd',
    slug: `expiry-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);

  const base = `expiry-${Date.now()}-${fixtureId}.example`;
  const domains: Array<{ id: string; slug: string; name: string }> = [];
  for (const name of names.length > 0 ? names.map((n) => n.replace('{base}', base)) : [base]) {
    const created = await agent
      .post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`)
      .send({ name });
    expect(created.status, name).toBe(201);
    await prisma.domain.update({ where: { id: created.body.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } });
    domains.push({ id: created.body.id as string, slug: created.body.slug as string, name });
  }

  const userId = (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
  return { agent, organizationId, base, domains, userId, email };
}

const expiryEmails = { idempotencyKey: { startsWith: 'domain-expiry:' } } as const;

async function waitForEmails(expected: number): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await prisma.emailDelivery.count({ where: expiryEmails })).toBe(expected);
    },
    { timeout: 5_000, interval: 25 },
  );
}

describe('domain expiry', () => {
  it('stores the registry date and shows it on the registration route', async () => {
    const fixture = await setup();
    const now = new Date();
    registry.set(fixture.base, { expiresAt: new Date(now.getTime() + 200 * day).toISOString() });

    const before = await fixture.agent.get(
      `/api/workspaces/${fixture.organizationId}/domains/${fixture.domains[0]!.id}/registration`,
    );
    expect(before.status).toBe(200);
    expect(before.body.registration).toBeNull();

    const outcome = await runDomainExpiryPass(now);
    expect(outcome.checked).toBe(1);
    expect(outcome.warned).toBe(0);

    const view = await fixture.agent.get(
      `/api/workspaces/${fixture.organizationId}/domains/${fixture.domains[0]!.slug}/registration`,
    );
    expect(view.body.registration).toMatchObject({
      registrableDomain: fixture.base,
      status: 'ok',
      registrar: 'Example Registrar',
      daysLeft: 200,
    });
  });

  it('warns once per rung, critical from seven days, and starts again after a renewal', async () => {
    const fixture = await setup();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 14 * day + 60_000);
    registry.set(fixture.base, { expiresAt: expiresAt.toISOString() });

    const first = await runDomainExpiryPass(now);
    expect(first.warned).toBe(1);
    let notices = await prisma.notification.findMany({ where: { kind: 'DOMAIN_EXPIRY' } });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      userId: fixture.userId,
      severity: 'WARNING',
      title: `${fixture.base}: registration expires soon`,
      link: `/domains/${fixture.domains[0]!.slug}`,
    });
    expect(notices[0]!.body).toContain('expires in 14 days');
    expect(notices[0]!.body).toContain('Registrar: Example Registrar.');
    await waitForEmails(1);
    const email = await prisma.emailDelivery.findFirstOrThrow({ where: expiryEmails });
    expect(email.to).toBe(fixture.email);
    expect(email.text).toContain('expires in 14 days');

    // The same day again: nothing new.
    expect((await runDomainExpiryPass(new Date(now.getTime() + 60 * 60 * 1000))).warned).toBe(0);

    // A week later: the 7-day rung, critical.
    const weekLater = new Date(now.getTime() + 7 * day);
    expect((await runDomainExpiryPass(weekLater)).warned).toBe(1);
    notices = await prisma.notification.findMany({ where: { kind: 'DOMAIN_EXPIRY' }, orderBy: { createdAt: 'asc' } });
    expect(notices).toHaveLength(2);
    expect(notices[1]!.severity).toBe('CRITICAL');
    await waitForEmails(2);

    // Renewed for a year: the next lookup stores the new date and warns nothing.
    registry.set(fixture.base, { expiresAt: new Date(expiresAt.getTime() + 365 * day).toISOString() });
    const renewed = await runDomainExpiryPass(new Date(weekLater.getTime() + day + 60_000));
    expect(renewed.checked).toBe(1);
    expect(renewed.warned).toBe(0);
    const row = await prisma.domainRegistration.findFirstOrThrow();
    expect(row.expiresAt?.toISOString()).toBe(new Date(expiresAt.getTime() + 365 * day).toISOString());

    // A year on, the new expiry runs down the ladder from the top again.
    const nextYear = new Date(expiresAt.getTime() + 365 * day - 20 * day);
    expect((await runDomainExpiryPass(nextYear)).warned).toBe(1);
    const latest = await prisma.notification.findFirstOrThrow({
      where: { kind: 'DOMAIN_EXPIRY' },
      orderBy: { createdAt: 'desc' },
    });
    expect(latest.body).toContain('expires in 20 days');
  });

  it('says expired, once, when the date has passed', async () => {
    const fixture = await setup();
    const now = new Date();
    registry.set(fixture.base, { expiresAt: new Date(now.getTime() - 3 * day - 60_000).toISOString() });

    expect((await runDomainExpiryPass(now)).warned).toBe(1);
    expect((await runDomainExpiryPass(new Date(now.getTime() + 2 * day))).warned).toBe(0);
    const notice = await prisma.notification.findFirstOrThrow({ where: { kind: 'DOMAIN_EXPIRY' } });
    expect(notice.title).toBe(`${fixture.base}: registration expired`);
    expect(notice.severity).toBe('CRITICAL');
  });

  it('looks a subdomain up as its registrable domain, once per pass', async () => {
    const fixture = await setup('HARBOR', ['{base}', 'mail.{base}']);
    const now = new Date();
    registry.set(fixture.base, { expiresAt: new Date(now.getTime() + 5 * day + 60_000).toISOString() });

    const outcome = await runDomainExpiryPass(now);
    expect(outcome.checked).toBe(2);
    expect(lookups).toEqual([fixture.base]);

    const rows = await prisma.domainRegistration.findMany();
    expect(rows.every((row) => row.registrableDomain === fixture.base)).toBe(true);
    const sub = await prisma.notification.findFirstOrThrow({
      where: { kind: 'DOMAIN_EXPIRY', title: { startsWith: 'mail.' } },
    });
    expect(sub.body).toContain(`The registration of ${fixture.base} expires in 5 days`);
    // One email listing both domains.
    await waitForEmails(1);
  });

  it('keeps the last good date when a lookup fails, and records why', async () => {
    const fixture = await setup();
    const now = new Date();
    registry.set(fixture.base, { expiresAt: new Date(now.getTime() + 100 * day).toISOString() });
    await runDomainExpiryPass(now);

    registry.set(fixture.base, { fail: true });
    const outcome = await runDomainExpiryPass(new Date(now.getTime() + day + 60_000));
    expect(outcome.failed).toBe(1);
    const row = await prisma.domainRegistration.findFirstOrThrow();
    expect(row.status).toBe('ok');
    expect(row.expiresAt).not.toBeNull();
    expect(row.lastError).toContain('could not be reached');
  });

  it('records a TLD without RDAP and a name the registry does not know, and warns about neither', async () => {
    const fixture = await setup('HARBOR', ['{base}', 'other-name.example']);
    const now = new Date();
    // `base` is not in the registry map, so the fake answers 404 for it.
    await prisma.domain.update({ where: { id: fixture.domains[1]!.id }, data: { name: 'acme-unsupported.zz' } });

    const outcome = await runDomainExpiryPass(now);
    expect(outcome.warned).toBe(0);
    const rows = await prisma.domainRegistration.findMany({ orderBy: { registrableDomain: 'asc' } });
    expect(rows.map((row) => row.status).sort()).toEqual(['not_found', 'unsupported']);
  });

  it('stores the date on every plan but only warns on plans with alerts', async () => {
    const fixture = await setup('MOORING');
    const now = new Date();
    registry.set(fixture.base, { expiresAt: new Date(now.getTime() + 3 * day + 60_000).toISOString() });

    const outcome = await runDomainExpiryPass(now);
    expect(outcome.checked).toBe(1);
    expect(outcome.notifications).toBe(0);
    expect(outcome.emails).toBe(0);
    expect(await prisma.notification.count({ where: { kind: 'DOMAIN_EXPIRY' } })).toBe(0);
    expect((await prisma.domainRegistration.findFirstOrThrow()).expiresAt).not.toBeNull();
  });

  it('does not let another workspace read the registration', async () => {
    const owner = await setup();
    const stranger = await setup();
    const response = await stranger.agent.get(
      `/api/workspaces/${owner.organizationId}/domains/${owner.domains[0]!.id}/registration`,
    );
    expect(response.status).toBe(403);
    const wrongDomain = await stranger.agent.get(
      `/api/workspaces/${stranger.organizationId}/domains/${owner.domains[0]!.id}/registration`,
    );
    expect(wrongDomain.status).toBe(404);
  });

  it('removes the registration and its notices when the domain is deleted', async () => {
    const fixture = await setup();
    const now = new Date();
    registry.set(fixture.base, { expiresAt: new Date(now.getTime() + 2 * day + 60_000).toISOString() });
    await runDomainExpiryPass(now);
    expect(await prisma.notification.count({ where: { kind: 'DOMAIN_EXPIRY' } })).toBe(1);

    await deleteDomain(fixture.organizationId, fixture.domains[0]!.id, fixture.userId);
    expect(await prisma.domainRegistration.count()).toBe(0);
    expect(await prisma.notification.count({ where: { kind: 'DOMAIN_EXPIRY' } })).toBe(0);
  });
});
