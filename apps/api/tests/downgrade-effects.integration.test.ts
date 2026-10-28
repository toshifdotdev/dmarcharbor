import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { bulkImportClients } from '../src/services/bulk-onboarding.service.js';
import { afterPlanChange, SSO_DOWNGRADE_GRACE_DAYS } from '../src/services/entitlements/plan-change-effects.js';
import { completeSignIn } from '../src/services/sso/sso-flow.service.js';
import { createSsoConnection } from '../src/services/sso/sso.service.js';
import { grantPlan } from './helpers/plan.js';

/**
 * What a workspace keeps, and what stops, after its plan changes.
 *
 * The rule throughout: nothing set up on a higher plan is deleted, anything that
 * holds a credential can still be removed, a public page stops when its feature
 * does, and people who reach the workspace through SSO are not locked out on the
 * day of the downgrade. Each case is checked again after an upgrade, so a pass
 * shows the plan is what made the difference.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const dayMs = 24 * 60 * 60 * 1000;

const placeholderCertificate = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBszCCAV2gAwIBAgIUNVjs8h1PY0uEwGnkVOnkGkMg2MIICIjANBgkqhkiG9w0BAQEF',
  'AAOCAg8AMIICCgKCAgEA0R8bkSBLDPHZ7AjKQFd6yXwOoSK5ZzNkTJgUL0FR9jNXzZz',
  '-----END CERTIFICATE-----',
].join('\n');

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "email_delivery", "hosted_dmarc_record", "report_share", "report_inbox", "sso_auth_request", "sso_connection_domain", "sso_connection", "entitlement_override", "subscription", "audit_log", "notification", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspace(label: string) {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const created = await agent.post('/api/workspaces').send({
    name: `${label} Agency`,
    slug: `${label}-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status).toBe(201);
  return { agent, email, organizationId: created.body.id as string };
}

async function clientWithDomain(agent: ReturnType<typeof request.agent>, organizationId: string) {
  const client = await agent
    .post(`/api/workspaces/${organizationId}/clients`)
    .send({ name: 'Acme Corp', slug: `acme-${Date.now()}-${fixtureId}` });
  expect(client.status).toBe(201);
  const domain = await agent
    .post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`)
    .send({ name: `downgrade-${Date.now()}-${fixtureId}.test` });
  expect(domain.status).toBe(201);
  return { clientId: client.body.id as string, domainId: domain.body.id as string };
}

describe('workspace deletion', () => {
  beforeEach(resetDatabase);

  it('closes the plugin delete route, which skipped the erasure grace period', async () => {
    const owner = await workspace('delete-route');

    const deleted = await owner.agent.post('/api/auth/organization/delete').send({ organizationId: owner.organizationId });
    expect(deleted.status).toBe(404);
    expect(await prisma.organization.count({ where: { id: owner.organizationId } })).toBe(1);
  });
});

describe('the report mailbox after a downgrade', () => {
  beforeEach(resetDatabase);

  it('shows a kept mailbox, refuses changes and polling, and lets it be removed', async () => {
    const owner = await workspace('mailbox-kept');
    await grantPlan(owner.organizationId, 'HARBOR');
    const configured = await owner.agent
      .put(`/api/workspaces/${owner.organizationId}/report-inbox`)
      .send({ host: 'imap.migadu.com', username: 'agg@reports.dmarcharbor.com', password: 'a-mailbox-password' });
    expect(configured.status).toBe(200);

    await grantPlan(owner.organizationId, 'FAIRWAY');

    const shown = await owner.agent.get(`/api/workspaces/${owner.organizationId}/report-inbox`);
    expect(shown.status).toBe(200);
    expect(shown.body.configured).toBe(true);
    expect(shown.body.paused).toBe(true);
    expect(JSON.stringify(shown.body)).not.toContain('a-mailbox-password');

    const changed = await owner.agent
      .put(`/api/workspaces/${owner.organizationId}/report-inbox`)
      .send({ host: 'imap.migadu.com', username: 'agg@reports.dmarcharbor.com', password: 'another' });
    expect(changed.status).toBe(402);
    expect((await owner.agent.post(`/api/workspaces/${owner.organizationId}/report-inbox/poll`)).status).toBe(402);

    const removed = await owner.agent.delete(`/api/workspaces/${owner.organizationId}/report-inbox`);
    expect(removed.status).toBe(204);
    expect(await prisma.reportInbox.count({ where: { organizationId: owner.organizationId } })).toBe(0);

    // Nothing kept now, so the read is the ordinary plan refusal again.
    expect((await owner.agent.get(`/api/workspaces/${owner.organizationId}/report-inbox`)).status).toBe(402);
  });

  it('still refuses the read on a plan that never had a mailbox', async () => {
    const owner = await workspace('mailbox-never');
    const read = await owner.agent.get(`/api/workspaces/${owner.organizationId}/report-inbox`);
    expect(read.status).toBe(402);
    expect(read.body.error.feature).toBe('reports.inbox');
  });
});

describe('single sign-on after a downgrade', () => {
  beforeEach(resetDatabase);

  async function ssoWorkspace(label: string) {
    const owner = await workspace(label);
    await grantPlan(owner.organizationId, 'ADMIRALTY');
    const created = await createSsoConnection({
      organizationId: owner.organizationId,
      label: 'Okta',
      protocol: 'SAML',
      issuer: 'https://okta.test/entity',
      entryPoint: 'https://okta.test/sso',
      clientId: 'client-1',
      clientSecret: 'a-signing-secret',
      idpCertificate: placeholderCertificate,
      provisioning: 'JIT',
      allowedEmailDomains: ['northgate.test'],
      defaultRole: 'analyst',
    });
    const load = () =>
      prisma.ssoConnection.findUniqueOrThrow({
        where: { id: created.id },
        include: { connections: { select: { domain: true } }, organization: { select: { id: true, name: true } } },
      });
    return { ...owner, connectionId: created.id, load };
  }

  it('admits existing members for the grace period, nobody new, and then nobody', async () => {
    const owner = await ssoWorkspace('sso-grace');
    const memberEmail = `member-${Date.now()}@northgate.test`;
    expect((await completeSignIn(await owner.load(), { email: memberEmail, providerSubject: 'subject-1' })).created).toBe(true);

    await grantPlan(owner.organizationId, 'HARBOR');
    await afterPlanChange(owner.organizationId, { from: 'ADMIRALTY', to: 'HARBOR' });

    const since = (await owner.load()).unlicensedSince;
    expect(since).not.toBeNull();

    await expect(
      completeSignIn(await owner.load(), { email: `newcomer-${Date.now()}@northgate.test`, providerSubject: 'subject-2' }),
    ).rejects.toThrow(/nobody new/i);

    const stillIn = await completeSignIn(await owner.load(), { email: memberEmail, providerSubject: 'subject-1' });
    expect(stillIn.created).toBe(false);

    // Kept connections are listed with the last day members can use them, and
    // can be read but not changed.
    const listed = await owner.agent.get(`/api/workspaces/${owner.organizationId}/sso-connections`);
    expect(listed.status).toBe(200);
    expect(listed.body.connections[0].paused).toBe(true);
    expect(new Date(listed.body.connections[0].signInUntil).getTime()).toBe(
      (since as Date).getTime() + SSO_DOWNGRADE_GRACE_DAYS * dayMs,
    );
    const patched = await owner.agent
      .patch(`/api/workspaces/${owner.organizationId}/sso-connections/${owner.connectionId}`)
      .send({ label: 'Renamed' });
    expect(patched.status).toBe(402);

    // The grace period has run out.
    await prisma.ssoConnection.update({
      where: { id: owner.connectionId },
      data: { unlicensedSince: new Date(Date.now() - (SSO_DOWNGRADE_GRACE_DAYS + 1) * dayMs) },
    });
    await expect(completeSignIn(await owner.load(), { email: memberEmail, providerSubject: 'subject-1' })).rejects.toThrow(
      /Forgot password/,
    );

    // Upgrading restores sign-in and clears the date.
    await grantPlan(owner.organizationId, 'ADMIRALTY');
    expect((await completeSignIn(await owner.load(), { email: memberEmail, providerSubject: 'subject-1' })).created).toBe(false);
    expect((await owner.load()).unlicensedSince).toBeNull();
  });

  it('lets a kept connection be removed on a plan without SSO', async () => {
    const owner = await ssoWorkspace('sso-remove');
    await grantPlan(owner.organizationId, 'HARBOR');

    const removed = await owner.agent.delete(`/api/workspaces/${owner.organizationId}/sso-connections/${owner.connectionId}`);
    expect(removed.status).toBe(204);

    // Nothing kept: the read is the ordinary plan refusal.
    expect((await owner.agent.get(`/api/workspaces/${owner.organizationId}/sso-connections`)).status).toBe(402);
  });

  it('emails the owners once about what the new plan no longer covers', async () => {
    const owner = await ssoWorkspace('sso-email');
    const { domainId } = await clientWithDomain(owner.agent, owner.organizationId);
    await prisma.hostedDmarcRecord.create({
      data: {
        organizationId: owner.organizationId,
        domainId,
        token: `tok-${Date.now()}-${fixtureId}`,
        value: 'v=DMARC1; p=quarantine',
        status: 'ACTIVE',
      },
    });

    await grantPlan(owner.organizationId, 'MOORING');
    await afterPlanChange(owner.organizationId, { from: 'ADMIRALTY', to: 'MOORING' });
    // The same change reported twice, as a webhook and its reconciliation would.
    await afterPlanChange(owner.organizationId, { from: 'ADMIRALTY', to: 'MOORING' });

    const queued = async () =>
      prisma.emailDelivery.findMany({
        where: { idempotencyKey: { startsWith: `plan-paused:${owner.organizationId}:` } },
        select: { to: true, subject: true, text: true },
      });
    // Queuing is not awaited by the sender, so allow it a moment.
    for (let attempt = 0; attempt < 20 && (await queued()).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const messages = await queued();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.to).toBe(owner.email);
    expect(messages[0]?.subject).toContain('Mooring');
    expect(messages[0]?.text).toContain('1 hosted DMARC record');
    expect(messages[0]?.text).toContain('Forgot password');
  });

  it('sends nothing when the new plan still covers everything', async () => {
    const owner = await workspace('no-email');
    await grantPlan(owner.organizationId, 'HARBOR');
    await afterPlanChange(owner.organizationId, { from: 'MOORING', to: 'HARBOR' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      await prisma.emailDelivery.count({ where: { idempotencyKey: { startsWith: `plan-paused:${owner.organizationId}:` } } }),
    ).toBe(0);
  });
});

describe('public pages after a downgrade', () => {
  beforeEach(resetDatabase);

  it('answers a Trust Center as withdrawn while the plan lacks it', async () => {
    const owner = await workspace('trust-down');
    await grantPlan(owner.organizationId, 'HARBOR');
    const { clientId } = await clientWithDomain(owner.agent, owner.organizationId);
    const created = await owner.agent.post(`/api/workspaces/${owner.organizationId}/clients/${clientId}/trust-center`).send({});
    expect(created.status).toBe(200);
    const url = `/api/trust/${created.body.slug}`;

    expect((await request(app).get(url)).status).toBe(200);

    await grantPlan(owner.organizationId, 'FAIRWAY');
    const hidden = await request(app).get(url);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe('TRUST_CENTER_NOT_FOUND');

    await grantPlan(owner.organizationId, 'HARBOR');
    expect((await request(app).get(url)).status).toBe(200);
  });

  it('answers a share link as withdrawn while the plan lacks it', async () => {
    const owner = await workspace('share-down');
    await grantPlan(owner.organizationId, 'FAIRWAY');
    const { domainId } = await clientWithDomain(owner.agent, owner.organizationId);
    const share = await owner.agent
      .post(`/api/workspaces/${owner.organizationId}/report-shares`)
      .send({ domainId, includeForensics: false, includeSources: false, expiresInDays: 7 });
    expect(share.status).toBe(201);

    expect((await request(app).get(share.body.url)).status).toBe(200);

    await grantPlan(owner.organizationId, 'MOORING');
    expect((await request(app).get(share.body.url)).status).toBe(404);

    await grantPlan(owner.organizationId, 'FAIRWAY');
    expect((await request(app).get(share.body.url)).status).toBe(200);
  });
});

describe('bulk imports under the workspace lock', () => {
  beforeEach(resetDatabase);

  it('lets two simultaneous imports share the free client slots, not take them twice', async () => {
    const owner = await workspace('bulk-race');

    // Mooring includes one client. Before the lock, both imports read one free
    // slot and both created a client.
    const [a, b] = await Promise.all([
      bulkImportClients({ organizationId: owner.organizationId, clients: [{ name: 'First Client' }] }),
      bulkImportClients({ organizationId: owner.organizationId, clients: [{ name: 'Second Client' }] }),
    ]);

    expect(a.created.length + b.created.length).toBe(1);
    expect(a.planBlocked.length + b.planBlocked.length).toBe(1);
    expect(await prisma.client.count({ where: { organizationId: owner.organizationId } })).toBe(1);
  });
});
