import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { grantPlan } from './helpers/plan.js';

/**
 * Removing a domain, a client or a whole workspace.
 *
 * Two classes of bug live here and neither shows up in a unit test:
 *
 *  1. Permission. The workspace delete is guarded by `organization: delete`,
 *     which only the owner role holds. An admin holds `['read','update']`, so
 *     the wrong guard on that route silently hands an admin the power to destroy
 *     the account. Asserted here by logging in as a real admin.
 *
 *  2. The foreign-key lock. Writing the audit row through the global Prisma
 *     client from inside a transaction that has already deleted the row makes the
 *     insert wait for a lock the transaction cannot release until the insert
 *     returns. The pair deadlocks until the transaction times out, and the route
 *     answers 500. That was not theoretical: it is exactly how this route failed
 *     on every call before the fix, and only a real database reproduces it.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

interface Fixture {
  agent: ReturnType<typeof request.agent>;
  organizationId: string;
  clientId: string;
  domainId: string;
  domainSlug: string;
  userId: string;
  /** A second signed-in account, invited as admin. */
  joinAsAdmin: () => Promise<ReturnType<typeof request.agent>>;
}

async function workspace(): Promise<Fixture> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `del-${Date.now()}-${fixtureId}@example.com`;

  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Del Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const created = await agent.post('/api/workspaces').send({
    name: 'Del Workspace',
    slug: `del-workspace-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status).toBe(201);
  const organizationId = created.body.id as string;
  await grantPlan(organizationId);

  // An alert rule needs at least one recipient, and only a member of this
  // workspace is a legal one.
  const owner = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  const userId = owner!.id;

  const client = await agent
    .post(`/api/workspaces/${organizationId}/clients`)
    .send({ name: 'Del Client', slug: `del-client-${Date.now()}-${fixtureId}` });
  expect(client.status).toBe(201);
  const clientId = client.body.id as string;

  const domain = await agent
    .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
    .send({ name: `del-${fixtureId}-report.test` });
  expect(domain.status).toBe(201);

  const adminEmail = `del-admin-${Date.now()}-${fixtureId}@example.com`;
  const joinAsAdmin = async () => {
    const admin = request.agent(app);
    expect((await admin.post('/api/auth/sign-up/email').send({ name: 'Del Admin', email: adminEmail, password })).status).toBe(200);
    await prisma.user.update({ where: { email: adminEmail }, data: { emailVerified: true } });
    expect((await admin.post('/api/auth/sign-in/email').send({ email: adminEmail, password })).status).toBe(200);
    // The membership row is written directly, the way the other permission
    // tests do it: an invitation is a pending row until it is accepted, and this
    // needs a signed-in admin, not a pending one.
    const user = await prisma.user.findUnique({ where: { email: adminEmail }, select: { id: true } });
    await prisma.member.create({
      data: {
        id: `member-admin-${fixtureId}`,
        organizationId,
        userId: user!.id,
        role: 'admin',
        createdAt: new Date(),
      },
    });
    return admin;
  };

  return {
    agent,
    organizationId,
    clientId,
    domainId: domain.body.id as string,
    domainSlug: domain.body.slug as string,
    userId,
    joinAsAdmin,
  };
}

describe('domain and client deletion', () => {
  beforeAll(resetDatabase);

  it('deletes a domain and reports what went with it', async () => {
    const { agent, organizationId, domainId } = await workspace();

    const response = await agent.delete(`/api/workspaces/${organizationId}/domains/${domainId}`);
    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(`del-${fixtureId}-report.test`);
    expect(response.body.summary.domains).toBe(1);

    expect(await prisma.domain.count({ where: { id: domainId } })).toBe(0);
  });

  it('accepts a domain slug as well as its id, so the UI link works', async () => {
    const { agent, organizationId, domainSlug } = await workspace();

    const response = await agent.delete(`/api/workspaces/${organizationId}/domains/${domainSlug}`);
    expect(response.status).toBe(200);
  });

  it('answers 404 for a domain in another workspace rather than confirming it exists', async () => {
    const first = await workspace();
    const second = await workspace();

    const response = await second.agent.delete(`/api/workspaces/${second.organizationId}/domains/${first.domainId}`);
    expect(response.status).toBe(404);
    // Still there: a refusal must not have destroyed somebody else's domain.
    expect(await prisma.domain.count({ where: { id: first.domainId } })).toBe(1);
  });

  it('deletes a client and every domain under it', async () => {
    const { agent, organizationId, clientId, domainId } = await workspace();

    const response = await agent.delete(`/api/workspaces/${organizationId}/clients/${clientId}`);
    expect(response.status).toBe(200);
    expect(response.body.summary.domains).toBe(1);

    expect(await prisma.client.count({ where: { id: clientId } })).toBe(0);
    expect(await prisma.domain.count({ where: { id: domainId } })).toBe(0);
  });

  it('refuses to delete a client while a portal contact still has access', async () => {
    const { agent, organizationId, clientId } = await workspace();

    const granted = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clientId}/portal-access`)
      .send({ email: 'contact@client.test', displayName: 'Client Contact' });
    expect([200, 201]).toContain(granted.status);

    const response = await agent.delete(`/api/workspaces/${organizationId}/clients/${clientId}`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PORTAL_ACCESS_STILL_GRANTED');

    // The refusal has to leave the client standing, or the operator retries into
    // a second surprise.
    expect(await prisma.client.count({ where: { id: clientId } })).toBe(1);
  });

  it('lets the client be deleted once the contact is REVOKED, revoked row and all', async () => {
    const { agent, organizationId, clientId } = await workspace();

    const granted = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clientId}/portal-access`)
      .send({ email: 'contact@client.test', displayName: 'Client Contact' });
    expect([200, 201]).toContain(granted.status);

    expect((await agent.delete(`/api/workspaces/${organizationId}/portal-access/${granted.body.id}`)).status).toBe(204);

    // The regression: revoking sets `revokedAt` and KEEPS the row for the audit
    // trail, and the delete guard counted every row. So the operator revoked the
    // access, followed the instruction in the refusal, and was refused again with
    // no way forward - the client could never be deleted at all.
    const stillThere = await prisma.clientPortalAccess.count({ where: { clientId } });
    expect(stillThere).toBe(1);
    expect(await prisma.clientPortalAccess.count({ where: { clientId, revokedAt: null } })).toBe(0);

    const response = await agent.delete(`/api/workspaces/${organizationId}/clients/${clientId}`);
    expect(response.status).toBe(200);
    expect(await prisma.client.count({ where: { id: clientId } })).toBe(0);
  });

  it('removes a revoked grant permanently, and refuses while it is still active', async () => {
    const { agent, organizationId, clientId } = await workspace();

    const granted = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clientId}/portal-access`)
      .send({ email: 'contact@client.test', displayName: 'Client Contact' });
    expect([200, 201]).toContain(granted.status);
    const accessId = granted.body.id as string;

    // Still live: removing it now would end the contact's access without leaving
    // the revocation in the trail, which is the one thing the trail is for.
    const tooEarly = await agent.delete(`/api/workspaces/${organizationId}/portal-access/${accessId}/permanent`);
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.error.code).toBe('PORTAL_ACCESS_STILL_ACTIVE');
    expect(await prisma.clientPortalAccess.count({ where: { id: accessId } })).toBe(1);

    expect((await agent.delete(`/api/workspaces/${organizationId}/portal-access/${accessId}`)).status).toBe(204);

    const removed = await agent.delete(`/api/workspaces/${organizationId}/portal-access/${accessId}/permanent`);
    expect(removed.status).toBe(204);
    expect(await prisma.clientPortalAccess.count({ where: { id: accessId } })).toBe(0);

    // The record of the clean-up survives even though the row did not.
    const audit = await prisma.auditLog.findFirst({
      where: { targetId: accessId, action: 'PORTAL_ACCESS_DELETED' },
      select: { organizationId: true },
    });
    expect(audit?.organizationId).toBe(organizationId);
  });

  it('clears every revoked grant in one call, and reports how many went', async () => {
    const { agent, organizationId, clientId } = await workspace();

    const ids: string[] = [];
    for (const email of ['one@client.test', 'two@client.test', 'three@client.test']) {
      const granted = await agent
        .post(`/api/workspaces/${organizationId}/clients/${clientId}/portal-access`)
        .send({ email, displayName: email });
      expect([200, 201]).toContain(granted.status);
      ids.push(granted.body.id as string);
    }

    // Two revoked, one left live: the live one must survive a bulk clean-up,
    // because somebody still has access through it.
    for (const id of ids.slice(0, 2)) {
      expect((await agent.delete(`/api/workspaces/${organizationId}/portal-access/${id}`)).status).toBe(204);
    }

    const cleared = await agent.delete(`/api/workspaces/${organizationId}/portal-access/revoked`);
    expect(cleared.status).toBe(200);
    expect(cleared.body.removed).toBe(2);

    const survivors = await prisma.clientPortalAccess.findMany({ where: { clientId }, select: { id: true } });
    expect(survivors.map((s) => s.id)).toEqual([ids[2]]);

    // Nothing left to clear is answered honestly rather than as a silent success.
    const again = await agent.delete(`/api/workspaces/${organizationId}/portal-access/revoked`);
    expect(again.status).toBe(200);
    expect(again.body.removed).toBe(0);
  });

  it('counts each portal grant once in a workspace preview', async () => {
    const { agent, organizationId, clientId } = await workspace();

    for (const email of ['one@client.test', 'two@client.test']) {
      const granted = await agent
        .post(`/api/workspaces/${organizationId}/clients/${clientId}/portal-access`)
        .send({ email, displayName: email });
      expect([200, 201]).toContain(granted.status);
    }

    const preview = await agent.get(`/api/workspaces/${organizationId}/deletion-preview`);
    expect(preview.status).toBe(200);
    // Two grants. The org-wide count added on top of the per-client counts
    // reported four, and a confirmation screen that doubles its own numbers is
    // one nobody trusts.
    expect(preview.body.summary.portalAccessGrants).toBe(2);
  });
});

/**
 * A page built from the URL holds whatever is in the URL, and after the slug
 * change that is a slug.
 *
 * Both services here accept an id or a slug and resolve either, so the write
 * always succeeded. The AUDIT that followed was handed the caller's raw input
 * instead of the resolved id, and a slug in `AuditLog.domainId` violates the
 * `audit_log_domainId_fkey` foreign key: the response was a bare 500 for work
 * that had already been committed, so every retry minted another share or rule.
 */
describe('domain-scoped writes addressed by slug', () => {
  beforeAll(resetDatabase);

  it('creates a share link when the caller sends the slug, and audits it against the real id', async () => {
    const { agent, organizationId, domainSlug } = await workspace();

    const created = await agent
      .post(`/api/workspaces/${organizationId}/report-shares`)
      .send({ domainId: domainSlug, includeForensics: false, includeSources: true, expiresInDays: 30 });
    expect(created.status).toBe(201);

    const audit = await prisma.auditLog.findFirst({
      where: { targetId: created.body.id as string, action: 'REPORT_SHARE_CREATED' },
      select: { domainId: true },
    });
    expect(audit?.domainId).toBeTruthy();
    // The column holds the cuid, never the slug: a slug here is the foreign key
    // violation that made this a 500.
    expect(audit?.domainId).not.toBe(domainSlug);
  });

  it('creates an alert rule when the caller sends the slug, and audits it against the real id', async () => {
    const { agent, organizationId, domainSlug, userId } = await workspace();

    const created = await agent
      .post(`/api/workspaces/${organizationId}/alert-rules`)
      .send({
        domainId: domainSlug,
        name: 'Slug addressed rule',
        metric: 'FAILURE_COUNT',
        operator: 'GREATER_THAN',
        threshold: 100,
        windowMinutes: 1440,
        recipientUserIds: [userId],
      });
    expect(created.status).toBe(201);

    const audit = await prisma.auditLog.findFirst({
      where: { targetId: created.body.id as string, action: 'ALERT_RULE_CREATED' },
      select: { domainId: true },
    });
    expect(audit?.domainId).toBeTruthy();
    expect(audit?.domainId).not.toBe(domainSlug);
  });
});

describe('workspace deletion', () => {
  beforeAll(resetDatabase);

  it('deletes the workspace even on a paid plan that was never charged for', async () => {
    const { agent, organizationId, clientId, domainId } = await workspace();

    // `grantPlan` leaves the workspace ACTIVE with `provider: NONE`: an
    // entitlement, not a payment. Nothing was charged, so nothing can be
    // stranded, and refusing here told the operator they had already paid for a
    // period - with no subscription in any billing portal to cancel.
    const subscription = await prisma.subscription.findFirst({ where: { organizationId } });
    expect(subscription?.status).toBe('ACTIVE');
    expect(subscription?.provider).toBe('NONE');

    const response = await agent.delete(`/api/workspaces/${organizationId}`);
    // The regression this file exists for: the audit insert used to open a
    // second connection, block on the deleted row's lock and time out after five
    // seconds with "Transaction already closed".
    expect(response.status).toBe(200);
    expect(response.body.summary.domains).toBe(1);

    expect(await prisma.organization.count({ where: { id: organizationId } })).toBe(0);
    expect(await prisma.client.count({ where: { id: clientId } })).toBe(0);
    expect(await prisma.domain.count({ where: { id: domainId } })).toBe(0);

    // The record of the deletion outlives the workspace. `onDelete: SetNull`
    // clears the foreign key, and `targetId` is what still names it. Filtered by
    // action because the DPA acceptance recorded earlier in this workspace's life
    // carries the same organization id in `targetId`.
    const audit = await prisma.auditLog.findFirst({
      where: { targetId: organizationId, action: 'WORKSPACE_DELETED' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.action).toBe('WORKSPACE_DELETED');
    expect(audit?.organizationId).toBeNull();
  });

  it('refuses an admin, who holds update but not delete', async () => {
    const { organizationId, joinAsAdmin } = await workspace();
    const admin = await joinAsAdmin();

    const response = await admin.delete(`/api/workspaces/${organizationId}`);
    expect(response.status).toBe(403);

    // The guard is the whole point of this test: an admin who could delete the
    // workspace would destroy every member's work.
    expect(await prisma.organization.count({ where: { id: organizationId } })).toBe(1);
  });

  it('refuses while a real paid subscription is active, and says how to resolve it', async () => {
    const { agent, organizationId } = await workspace();

    // A Razorpay subscription is money that changed hands. Deleting the workspace
    // would leave the order with nothing to serve and no refund path.
    await prisma.subscription.updateMany({
      where: { organizationId },
      data: { provider: 'RAZORPAY', providerSubscriptionId: `lifecycle-${Date.now()}-${fixtureId}` },
    });

    const response = await agent.delete(`/api/workspaces/${organizationId}`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SUBSCRIPTION_STILL_ACTIVE');
    expect(response.body.error.message).toMatch(/cancel/i);

    expect(await prisma.organization.count({ where: { id: organizationId } })).toBe(1);
  });

  it('deletes freely once the paid subscription is cancelled', async () => {
    const { agent, organizationId } = await workspace();

    await prisma.subscription.updateMany({
      where: { organizationId },
      data: { provider: 'RAZORPAY', providerSubscriptionId: `lifecycle-cancel-${Date.now()}-${fixtureId}` },
    });
    expect((await agent.delete(`/api/workspaces/${organizationId}`)).status).toBe(409);

    await prisma.subscription.updateMany({
      where: { organizationId },
      data: { status: 'CANCELLED' },
    });

    expect((await agent.delete(`/api/workspaces/${organizationId}`)).status).toBe(200);
    expect(await prisma.organization.count({ where: { id: organizationId } })).toBe(0);
  });

  it('answers 404 for a workspace the caller is not in', async () => {
    const { organizationId } = await workspace();
    const stranger = await workspace();

    const response = await stranger.agent.delete(`/api/workspaces/${organizationId}`);
    expect([403, 404]).toContain(response.status);
    expect(await prisma.organization.count({ where: { id: organizationId } })).toBe(1);
  });
});
