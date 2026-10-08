import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { currentDpaVersion, dpaPath } from '../src/services/dpa-acceptance.service.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspace(): Promise<{ agent: ReturnType<typeof request.agent>; organizationId: string }> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `dpa-${Date.now()}-${fixtureId}@example.com`;

  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'DPA Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const created = await agent.post('/api/workspaces').send({
    name: 'DPA Workspace',
    slug: `dpa-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
  expect(created.status).toBe(201);

  return { agent, organizationId: created.body.id as string };
}

/**
 * An acceptance with no version cannot answer an auditor's question, which is not
 * "when" but "which document". And an acceptance recorded against a person rather
 * than an organisation disappears when that person leaves.
 */
describe('Data Processing Agreement acceptance', () => {
  beforeAll(resetDatabase);

  /**
   * The workspace does not survive a failure to record the agreement.
   *
   * Better Auth commits the organisation inside its own call, so the acceptance
   * cannot join that transaction. Until this was fixed a throw between the two
   * left a workspace with `dpaVersion: null`, which is not a missing optional
   * field but a workspace answering `requiresReconsent: true` for ever with no
   * API route able to clear it. The number of organisations after the failure is
   * the assertion that matters: the workspace has to be gone, not merely left
   * in a warning state.
   */
  it('leaves no workspace behind when the acceptance cannot be recorded', async () => {
    fixtureId += 1;
    const agent = request.agent(app);
    const email = `dpa-rollback-${Date.now()}-${fixtureId}@example.com`;
    expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Rollback Owner', email, password })).status).toBe(200);
    await prisma.user.update({ where: { email }, data: { emailVerified: true } });
    expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

    const before = await prisma.organization.count({ where: { members: { some: { user: { email } } } } });
    expect(before).toBe(0);

    /**
     * Simulate the failure from the outside rather than by mocking, so the
     * rollback path under test is the real one: the route's own catch, calling
     * the real delete, not a stub that agrees with the assertion.
     */
    const database = await import('../src/database/prisma.js');
    vi.spyOn(database.prisma.auditLog, 'create').mockImplementation(() => {
      throw new Error('audit write failed');
    });

    try {
      const failed = await agent.post('/api/workspaces').send({
        name: 'Half Created Workspace',
        slug: `dpa-rollback-${Date.now()}-${fixtureId}`,
        dpaHasRead: true,
        dpaConfirmsAuthority: true,
      });
      expect(failed.status).toBe(500);
      // And it says nothing was created, rather than only that something failed.
      expect(failed.body.error.message).toMatch(/nothing has been created/i);
    } finally {
      vi.restoreAllMocks();
    }

    // The workspace is gone, and the member row that linked the acting user to
    // it with it, so the user is not left attached to an organisation that no
    // longer exists.
    const survived = await prisma.organization.count({
      where: { members: { some: { user: { email } } } },
    });
    expect(survived).toBe(0);
    expect(await prisma.member.count({ where: { user: { email } } })).toBe(0);

    // Which also means the user can try again rather than being stuck.
    const retried = await agent.post('/api/workspaces').send({
      name: 'Second Attempt',
      slug: `dpa-retry-${Date.now()}-${fixtureId}`,
      dpaHasRead: true,
      dpaConfirmsAuthority: true,
    });
    expect(retried.status).toBe(201);

    const recreated = await prisma.organization.findUniqueOrThrow({ where: { id: retried.body.id } });
    expect(recreated.dpaAcceptedAt).not.toBeNull();
    expect(recreated.dpaVersion).toBe(currentDpaVersion);

    // And the spy never really wrote anything, so the count reflects a clean run.
    expect(await database.prisma.auditLog.count({ where: { organizationId: retried.body.id, action: 'DPA_ACCEPTED' } })).toBe(1);
  });

  /**
   * A workspace created through the product records its acceptance as part of
 * creation.
 *
 * This used to assert the opposite, and the opposite was the defect: creation had
 * no opinion about the agreement, the endpoint that records it was never called
 * from anywhere in the app, so every workspace in existence had `dpaAcceptedAt:
 * null` and the compliance evidence chain recorded nothing. An assertion that a
 * fresh workspace is unaccepted was a test that would have failed the day someone
 * fixed it.
 */
  it('records the acceptance as part of creating a workspace', async () => {
    const { agent, organizationId } = await workspace();

    const response = await agent.get(`/api/workspaces/${organizationId}/dpa-acceptance`);

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(true);
    expect(response.body.version).toBe(currentDpaVersion);
    expect(response.body.requiresReconsent).toBe(false);
    expect(response.body.acceptedAt).not.toBeNull();
  });

  it('refuses to create a workspace without the agreement being accepted', async () => {
    fixtureId += 1;
    const agent = request.agent(app);
    const email = `dpa-refused-${Date.now()}-${fixtureId}@example.com`;
    expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Refused Owner', email, password })).status).toBe(200);
    await prisma.user.update({ where: { email }, data: { emailVerified: true } });
    expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

    const slug = `refused-${Date.now()}-${fixtureId}`;

    // No confirmations at all.
    const neither = await agent.post('/api/workspaces').send({ name: 'Refused', slug });
    expect(neither.status).toBe(400);
    expect(neither.body.error.code).toBe('DPA_NOT_ACCEPTED');
    // The client has to be able to show the document, not just be told no.
    expect(neither.body.error.dpaUrl).toBe('/dpa');

    // Read but no authority. This is the one that matters legally.
    const readOnly = await agent
      .post('/api/workspaces')
      .send({ name: 'Refused', slug, dpaHasRead: true, dpaConfirmsAuthority: false });
    expect(readOnly.status).toBe(400);
    expect(readOnly.body.error.code).toBe('DPA_NOT_ACCEPTED');

    // And nothing was created by either attempt.
    expect(await prisma.organization.count({ where: { slug } })).toBe(0);
  });

  it('points at a route that exists', async () => {
    // The instruction this endpoint hands out used to be `/legal/dpa`, and there is
    // no `/legal` segment in the web app at all, so a caller that respected it went
    // to a 404 at the exact moment it needed to read what it was agreeing to.
    expect(dpaPath).toBe('/dpa');
  });

  it('refuses an acceptance without both confirmations', async () => {
    const { agent, organizationId } = await workspace();

    // The authority confirmation is the one that matters: an employee creating a
    // workspace has not been authorised by their firm to bind it.
    const readOnly = await agent
      .post(`/api/workspaces/${organizationId}/dpa-acceptance`)
      .send({ hasRead: true, confirmsAuthority: false });
    expect(readOnly.status).toBe(409);

    const unchecked = await agent
      .post(`/api/workspaces/${organizationId}/dpa-acceptance`)
      .send({ hasRead: false, confirmsAuthority: true });
    expect(unchecked.status).toBe(409);

    const neither = await agent.post(`/api/workspaces/${organizationId}/dpa-acceptance`).send({});
    expect(neither.status).toBe(409);
  });

  it('leaves the record untouched when a confirmation is missing', async () => {
    const { agent, organizationId } = await workspace();

    const before = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });

    await agent
      .post(`/api/workspaces/${organizationId}/dpa-acceptance`)
      .send({ hasRead: true, confirmsAuthority: false });

    const after = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });

    /**
     * A refusal must change nothing.
     *
     * This used to assert the fields were null, which was only true because
     * creation never recorded anything. Now that a workspace is created with a
     * recorded acceptance, "still null" is no longer the property worth checking:
     * the one that matters is that a refused call did not overwrite, clear or
     * partially write an existing record. So the before and after are compared.
     */
    expect(after.dpaAcceptedAt).toEqual(before.dpaAcceptedAt);
    expect(after.dpaVersion).toEqual(before.dpaVersion);
    expect(after.dpaAcceptedByEmail).toEqual(before.dpaAcceptedByEmail);
  });

  it('records the version, the time and who accepted', async () => {
    const { agent, organizationId } = await workspace();

    const response = await agent
      .post(`/api/workspaces/${organizationId}/dpa-acceptance`)
      .send({ hasRead: true, confirmsAuthority: true });

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(true);
    expect(response.body.version).toBe(response.body.currentVersion);
    expect(response.body.acceptedAt).toBeTruthy();
    expect(response.body.acceptedByEmail).toContain('@');
    expect(response.body.requiresReconsent).toBe(false);
  });

  it('keeps the acceptance on the organisation, not the person', async () => {
    const { agent, organizationId } = await workspace();

    await agent
      .post(`/api/workspaces/${organizationId}/dpa-acceptance`)
      .send({ hasRead: true, confirmsAuthority: true });

    const stored = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(stored.dpaAcceptedById).toBeTruthy();
    expect(stored.dpaAcceptedByEmail).toContain('@');
  });

  it('writes an audit entry, because authority is disputed on a row not in memory', async () => {
    const { agent, organizationId } = await workspace();

    await agent
      .post(`/api/workspaces/${organizationId}/dpa-acceptance`)
      .send({ hasRead: true, confirmsAuthority: true });

    const entries = await prisma.auditLog.findMany({ where: { organizationId } });
    const accepted = entries.find((entry) => entry.action === 'DPA_ACCEPTED');

    expect(accepted).toBeDefined();
    expect(accepted?.detail).toMatchObject({ authorityConfirmed: true });
  });

  it('asks for consent again when an older version was accepted', async () => {
    const { agent, organizationId } = await workspace();

    await prisma.organization.update({
      where: { id: organizationId },
      data: { dpaAcceptedAt: new Date(), dpaVersion: '0.9', dpaAcceptedByEmail: 'earlier@example.com' },
    });

    const response = await agent.get(`/api/workspaces/${organizationId}/dpa-acceptance`);

    // Accepting a version nobody was shown is worse than having no field at all,
    // so an older acceptance prompts rather than passing.
    expect(response.body.accepted).toBe(true);
    expect(response.body.version).toBe('0.9');
    expect(response.body.requiresReconsent).toBe(true);
  });

  /**
   * The version gap is enforced, not only reported.
   *
   * `dpaAcceptanceFor` computed `requiresReconsent` for a long time with nothing
   * reading it, which meant a published change to the agreement took effect for
   * nobody and the only trace was a field on a record nobody was required to
   * look at. This asserts the enforcement actually bites on routes that do the
   * product's work, and not only that the flag exists.
   */
  it('refuses workspace requests that are still operating under an older version', async () => {
    const { agent, organizationId } = await workspace();

    // Reading the acceptance itself still answers, because it is what tells a
    // client there is something to accept, and which version to accept.
    const acceptance = await agent.get(`/api/workspaces/${organizationId}/dpa-acceptance`);
    expect(acceptance.status).toBe(200);
    expect(acceptance.body.requiresReconsent).toBe(false);

    await prisma.organization.update({
      where: { id: organizationId },
      data: { dpaAcceptedAt: new Date(), dpaVersion: '0.9', dpaAcceptedByEmail: 'earlier@example.com' },
    });

    const stillAnswered = await agent.get(`/api/workspaces/${organizationId}/dpa-acceptance`);
    expect(stillAnswered.status).toBe(200);
    expect(stillAnswered.body.requiresReconsent).toBe(true);

    // And every route that does work on the workspace refuses, with the reason
    // and the route to the document the caller is missing.
    for (const path of [
      `/api/workspaces/${organizationId}/clients`,
      `/api/workspaces/${organizationId}/entitlements`,
      `/api/workspaces/${organizationId}/api-keys`,
      `/api/workspaces/${organizationId}/webhooks`,
      `/api/workspaces/${organizationId}/export-jobs`,
      `/api/workspaces/${organizationId}/billing`,
    ]) {
      const refused = await agent.get(path);
      expect(refused.status, `${path} refused for a superseded agreement`).toBe(409);
      expect(refused.body.error.code).toBe('DPA_RECONSENT_REQUIRED');
      expect(refused.body.error.dpaUrl).toBe(dpaPath);
      expect(refused.body.error.acceptedVersion).toBe('0.9');
      expect(refused.body.error.currentVersion).toBe(currentDpaVersion);
    }

    // A write is refused too, because the agreement governs what may be done
    // with the data as much as what may be read.
    const refusedWrite = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
      name: 'New Client',
      slug: `refused-${Date.now()}`,
    });
    expect(refusedWrite.status).toBe(409);

    // Accepting the current version from the same place clears it, so the
    // enforcement cannot become a lockout.
    const accepted = await agent
      .post(`/api/workspaces/${organizationId}/dpa-acceptance`)
      .send({ hasRead: true, confirmsAuthority: true });
    expect(accepted.status).toBe(200);
    expect(accepted.body.version).toBe(currentDpaVersion);
    expect(accepted.body.requiresReconsent).toBe(false);

    expect((await agent.get(`/api/workspaces/${organizationId}/clients`)).status).toBe(200);
  });

  it('does not let one workspace record acceptance for another', async () => {
    const mine = await workspace();
    const theirs = await workspace();

    const before = await prisma.organization.findUniqueOrThrow({ where: { id: theirs.organizationId } });

    const response = await mine.agent
      .post(`/api/workspaces/${theirs.organizationId}/dpa-acceptance`)
      .send({ hasRead: true, confirmsAuthority: true });

    expect(response.status).toBe(403);

    // Unchanged, rather than merely "not null": a cross-workspace write attempt
    // must leave the other workspace's own record exactly as it was.
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: theirs.organizationId } });
    expect(after.dpaAcceptedAt).toEqual(before.dpaAcceptedAt);
    expect(after.dpaVersion).toEqual(before.dpaVersion);
  });

  it('requires a session', async () => {
    const { organizationId } = await workspace();
    const anonymous = request(app);

    expect((await anonymous.get(`/api/workspaces/${organizationId}/dpa-acceptance`)).status).toBe(401);
    expect(
      (
        await anonymous
          .post(`/api/workspaces/${organizationId}/dpa-acceptance`)
          .send({ hasRead: true, confirmsAuthority: true })
      ).status,
    ).toBe(401);
  });
});

describe('security.txt', () => {
  it('publishes an RFC 9116 contact with an expiry', async () => {
    const response = await request(app).get('/.well-known/security.txt');

    // A missing expiry tells a researcher the file was abandoned, which is worse
    // than not publishing one at all.
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/plain/);
    expect(response.text).toContain('Contact:');
    expect(response.text).toContain('Expires:');
    expect(response.text).toMatch(/Expires: \d{4}-\d{2}-\d{2}T/);
  });

  it('needs no session, because a researcher has none', async () => {
    const response = await request(app).get('/.well-known/security.txt');
    expect(response.status).toBe(200);
  });
});