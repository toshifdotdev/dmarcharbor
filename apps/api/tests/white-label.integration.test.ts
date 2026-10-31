import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { env } from '../src/config/env.js';
import { grantPlan } from './helpers/plan.js';
import { resetAgencyHostCache } from '../src/auth/agency-origin.js';
import { agencyFromHeader } from '../src/email/sender.js';
import type { ScanResult } from '../src/models/scan.model.js';
import { setProspectScannerForTests } from '../src/services/prospect/prospect-report.service.js';

/**
 * Complete white label: an Admiralty agency with a verified custom domain.
 *
 * A client must be able to sign in on the agency's domain, and every link the
 * client receives must point there. Requests "through the agency domain" carry
 * what the web app's proxy sends: the browser's Origin and an
 * x-forwarded-host naming the same host.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const agencyName = 'Wistholm IT';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "email_delivery", "rate_limit_bucket", "prospect_report", "report_share", "client_portal_access", "entitlement_override", "subscription", "audit_log", "notification", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "two_factor", "user" CASCADE',
  );
}

async function signUpVerified(agent: ReturnType<typeof request.agent>, email: string, name: string) {
  expect((await agent.post('/api/auth/sign-up/email').send({ name, email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
}

/** An agency workspace on `plan`, with `host` claimed and, unless told otherwise, verified. */
async function agency(input: { plan?: 'ADMIRALTY' | 'HARBOR'; verified?: boolean } = {}) {
  fixtureId += 1;
  const host = `reports-${fixtureId}.wistholm.example`;
  const agent = request.agent(app);
  const email = `owner-${Date.now()}-${fixtureId}@wistholm.example`;
  await signUpVerified(agent, email, 'Agency Owner');
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: agencyName,
    slug: `wistholm-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId, input.plan ?? 'ADMIRALTY');
  await prisma.organization.update({
    where: { id: organizationId },
    data: {
      customDomain: host,
      customDomainToken: 'token',
      customDomainVerifiedAt: input.verified === false ? null : new Date(),
    },
  });

  return { agent, organizationId, email, host, origin: `https://${host}` };
}

async function clientWithDomain(agent: ReturnType<typeof request.agent>, organizationId: string) {
  const client = await agent
    .post(`/api/workspaces/${organizationId}/clients`)
    .send({ name: 'Pellowyn Dental', slug: `pellowyn-${Date.now()}-${fixtureId}` });
  expect(client.status).toBe(201);
  const domain = await agent
    .post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`)
    .send({ name: `pellowyn-${fixtureId}.example` });
  expect(domain.status).toBe(201);
  return { clientId: client.body.id as string, domainId: domain.body.id as string };
}

/** Senders are fire and forget, so the row is waited for rather than read once. */
async function queuedEmail(to: string, subjectPart: string) {
  return vi.waitFor(
    async () => {
      const row = await prisma.emailDelivery.findFirst({
        where: { to, subject: { contains: subjectPart } },
        orderBy: { createdAt: 'desc' },
      });
      if (!row) throw new Error(`No email to ${to} about "${subjectPart}" yet.`);
      return row;
    },
    { timeout: 5_000, interval: 50 },
  );
}

function firstLink(text: string): URL {
  const match = /https?:\/\/\S+/.exec(text);
  expect(match).not.toBeNull();
  return new URL(match![0]);
}

beforeAll(resetDatabase);
beforeEach(() => resetAgencyHostCache());

describe('signing in on an agency domain', () => {
  it('accepts a sign-in that came through the verified agency domain', async () => {
    const { email, host, origin } = await agency();

    const signedIn = await request(app)
      .post('/api/auth/sign-in/email')
      .set('Origin', origin)
      .set('x-forwarded-host', host)
      .send({ email, password });
    expect(signedIn.status).toBe(200);

    // A wrong password is refused for the password, never for the origin.
    const wrong = await request(app)
      .post('/api/auth/sign-in/email')
      .set('Origin', origin)
      .set('x-forwarded-host', host)
      .send({ email, password: 'not-the-password' });
    expect(wrong.status).toBe(401);
  });

  it('refuses the same Origin without the proxy header, or with another host in it', async () => {
    const { email, host, origin } = await agency();

    const direct = await request(app).post('/api/auth/sign-in/email').set('Origin', origin).send({ email, password });
    expect(direct.status).toBe(403);

    const mismatched = await request(app)
      .post('/api/auth/sign-in/email')
      .set('Origin', origin)
      .set('x-forwarded-host', `other-${host}`)
      .send({ email, password });
    expect(mismatched.status).toBe(403);
  });

  it('refuses an unverified domain, and one the plan no longer includes', async () => {
    const unverified = await agency({ verified: false });
    const response = await request(app)
      .post('/api/auth/sign-in/email')
      .set('Origin', unverified.origin)
      .set('x-forwarded-host', unverified.host)
      .send({ email: unverified.email, password });
    expect(response.status).toBe(403);

    const downgraded = await agency({ plan: 'HARBOR' });
    const refused = await request(app)
      .post('/api/auth/sign-in/email')
      .set('Origin', downgraded.origin)
      .set('x-forwarded-host', downgraded.host)
      .send({ email: downgraded.email, password });
    expect(refused.status).toBe(403);
  });
});

describe('password reset on an agency domain', () => {
  it('sends a client the link on the agency domain, in the agency name, and the link works there', async () => {
    const { agent, organizationId, host, origin } = await agency();
    const { clientId } = await clientWithDomain(agent, organizationId);
    const contactEmail = `it-${Date.now()}-${fixtureId}@pellowyn.example`;
    expect(
      (await agent.post(`/api/workspaces/${organizationId}/clients/${clientId}/portal-access`).send({ email: contactEmail })).status,
    ).toBeLessThan(300);
    await signUpVerified(request.agent(app), contactEmail, 'Pellowyn IT');

    const asked = await request(app)
      .post('/api/auth/request-password-reset')
      .set('Origin', origin)
      .set('x-forwarded-host', host)
      .send({ email: contactEmail, redirectTo: `${origin}/sign-in` });
    expect(asked.status).toBe(200);

    const email = await queuedEmail(contactEmail, 'Reset your password');
    expect(email.subject).toBe(`Reset your password for ${agencyName}`);
    expect(email.text).not.toContain('DMARC Harbor');
    expect(email.fromHeader).toBe(agencyFromHeader(agencyName));
    const link = firstLink(email.text);
    expect(link.origin).toBe(origin);
    expect(link.pathname).toMatch(/^\/api\/auth\/reset-password\//);

    // Opened through the agency domain, the link redirects to its sign-in page.
    const opened = await request(app).get(`${link.pathname}${link.search}`).set('x-forwarded-host', host);
    expect(opened.status).toBe(302);
    expect(opened.headers.location).toMatch(new RegExp(`^${origin.replace(/\./g, '\\.')}/sign-in\\?`));

    // The same path on our API host, with no agency header, refuses the callback.
    const elsewhere = await request(app).get(`${link.pathname}${link.search}`);
    expect(elsewhere.status).toBe(403);
  });

  it('keeps the link on our host for an address the agency has no tie to', async () => {
    const { host, origin } = await agency();
    const strangerEmail = `stranger-${Date.now()}-${fixtureId}@elsewhere.example`;
    await signUpVerified(request.agent(app), strangerEmail, 'Stranger');

    const asked = await request(app)
      .post('/api/auth/request-password-reset')
      .set('Origin', origin)
      .set('x-forwarded-host', host)
      .send({ email: strangerEmail, redirectTo: `${origin}/sign-in` });
    expect(asked.status).toBe(200);

    const email = await queuedEmail(strangerEmail, 'Reset your');
    expect(email.subject).toBe('Reset your DMARC Harbor password');
    expect(email.fromHeader).toBeNull();
    const link = firstLink(email.text);
    expect(link.origin).toBe(new URL(env.BETTER_AUTH_URL).origin);
    expect(link.searchParams.get('callbackURL')).toBe(`${env.APP_URL.replace(/\/+$/, '')}/sign-in`);
  });

  it('keeps the link on our host for the agency’s own team, whose account may reach other workspaces', async () => {
    const { email: ownerEmail, host, origin } = await agency();

    const asked = await request(app)
      .post('/api/auth/request-password-reset')
      .set('Origin', origin)
      .set('x-forwarded-host', host)
      .send({ email: ownerEmail, redirectTo: `${origin}/sign-in` });
    expect(asked.status).toBe(200);

    const email = await queuedEmail(ownerEmail, 'Reset your');
    expect(email.subject).toBe('Reset your DMARC Harbor password');
    expect(email.fromHeader).toBeNull();
    const link = firstLink(email.text);
    expect(link.origin).toBe(new URL(env.BETTER_AUTH_URL).origin);
    expect(link.searchParams.get('callbackURL')).toBe(`${env.APP_URL.replace(/\/+$/, '')}/sign-in`);
  });
});

describe('client links on an agency domain', () => {
  it('returns a share pageUrl on the custom domain and keeps the relative url', async () => {
    const { agent, organizationId, origin } = await agency();
    const { domainId } = await clientWithDomain(agent, organizationId);

    const share = await agent
      .post(`/api/workspaces/${organizationId}/report-shares`)
      .send({ domainId, includeForensics: false, includeSources: true, expiresInDays: 7 });
    expect(share.status).toBe(201);
    expect(share.body.url).toBe(`/api/reports/share/${share.body.token}`);
    expect(share.body.pageUrl).toBe(`${origin}/share/${share.body.token}`);

    const listed = await agent.get(`/api/workspaces/${organizationId}/report-shares`);
    expect(listed.status).toBe(200);
    expect(listed.body.items[0].pageUrl).toBe(`${origin}/share/${share.body.token}`);
  });

  it('puts the Trust Center link on the custom domain', async () => {
    const { agent, organizationId, origin } = await agency();
    const { clientId } = await clientWithDomain(agent, organizationId);

    const created = await agent.post(`/api/workspaces/${organizationId}/clients/${clientId}/trust-center`).send({});
    expect(created.status).toBe(200);
    expect(created.body.url).toBe(`${origin}/trust/${created.body.slug}`);
  });

  it('reports the client origin on the branding settings', async () => {
    const { agent, organizationId, origin } = await agency();

    const settings = await agent.get(`/api/workspaces/${organizationId}/branding`);
    expect(settings.status).toBe(200);
    expect(settings.body.clientOrigin).toBe(origin);

    const unverified = await agency({ verified: false });
    const fallback = await unverified.agent.get(`/api/workspaces/${unverified.organizationId}/branding`);
    expect(fallback.body.clientOrigin).toBe(env.APP_URL.replace(/\/+$/, ''));
  });

  it('sends the portal invitation from the agency, linking to the custom domain', async () => {
    const { agent, organizationId, origin } = await agency();
    const { clientId } = await clientWithDomain(agent, organizationId);
    const contactEmail = `invited-${Date.now()}-${fixtureId}@pellowyn.example`;

    const granted = await agent.post(`/api/workspaces/${organizationId}/clients/${clientId}/portal-access`).send({ email: contactEmail });
    expect(granted.status).toBeLessThan(300);

    const email = await queuedEmail(contactEmail, 'DMARC reports for');
    expect(email.text).toContain(`${origin}/portal`);
    expect(email.text).toContain('choose Create an account');
    expect(email.fromHeader).toBe(agencyFromHeader(agencyName));
  });

  it('puts a prospect report link on the custom domain', async () => {
    const { agent, organizationId, origin } = await agency();
    setProspectScannerForTests(async (domain) => recordedScan(domain));
    try {
      const created = await agent.post(`/api/workspaces/${organizationId}/prospect-reports`).send({ domain: 'corriwick.example' });
      expect(created.status).toBe(201);
      expect(created.body.report.url).toMatch(new RegExp(`^${origin.replace(/\./g, '\\.')}/prospect/`));
    } finally {
      setProspectScannerForTests(null);
    }
  });
});

function recordedScan(domain: string): ScanResult {
  return {
    domain,
    scannedAt: new Date().toISOString(),
    status: 'needs_attention',
    score: 41,
    scoreBreakdown: { base: 100, final: 41, factors: [] },
    dmarc: {
      status: 'found',
      record: 'v=DMARC1; p=none',
      policy: 'none',
      tags: { p: 'none' },
      hasAggregateReports: false,
      hasForensicReports: false,
      aggregateMailtoTargets: [],
      aggregateWebTargets: [],
    },
    spf: { status: 'found', record: 'v=spf1 include:_spf.google.com ~all', valid: true, lookupCount: 3 },
    dkim: { status: 'missing', selectors: [], checkedSelectors: ['google'], records: {} },
    mx: { status: 'found', records: [{ exchange: 'aspmx.l.google.com', priority: 1 }] },
    issues: [],
    recommendations: [],
  };
}
