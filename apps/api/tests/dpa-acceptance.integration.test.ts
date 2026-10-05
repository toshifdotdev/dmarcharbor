import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
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