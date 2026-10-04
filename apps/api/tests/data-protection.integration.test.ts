import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { completeSamlSignIn, samlEntryPoint } from '../src/services/sso/sso-flow.service.js';
import { SsoError, createSsoConnection } from '../src/services/sso/sso.service.js';
import { completeSignIn } from '../src/services/sso/sso-flow.service.js';

/**
 * Data protection and sign-in integrity.
 *
 * Every case here is a defect that was present and unnoticed. The SAML ones
 * matter most: `validateInResponseTo` was left at the library default of `never`
 * and the RelayState was ignored, so a captured assertion was a permanent
 * credential.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

/**
 * node-saml asserts a certificate is present when the SAML instance is
 * constructed, before any assertion is seen. These tests never validate a real
 * signature — they exercise the request tracking around the assertion — so any
 * well formed PEM satisfies it.
 */
const placeholderCertificate = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBszCCAV2gAwIBAgIUNVjs8h1PY0uEwGnkVOnkGkMg2MIICIjANBgkqhkiG9w0BAQEF',
  'AAOCAg8AMIICCgKCAgEA0R8bkSBLDPHZ7AjKQFd6yXwOoSK5ZzNkTJgUL0FR9jNXzZz',
  '-----END CERTIFICATE-----',
].join('\n');

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "sso_auth_request", "sso_connection_domain", "sso_connection", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function agency(label: string) {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });

  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const created = await agent.post('/api/workspaces').send({ name: `${label} Agency`, slug: `${label}-${Date.now()}-${fixtureId}` });

  return { email, agent, organizationId: created.body.id as string };
}

describe('SAML replay protection', () => {
  beforeAll(resetDatabase);

  async function samlConnection(label: string) {
    const owner = await agency(label);
    const connection = await createSsoConnection({
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
    } as never);
    return { ...owner, connectionId: connection.id };
  }

  it('stores a single use RelayState when a sign in starts', async () => {
    const owner = await samlConnection('saml-relay');

    await samlEntryPoint(owner.connectionId);

    const stored = await prisma.ssoAuthRequest.findMany({ where: { connectionId: owner.connectionId } });
    // Two rows, and that is the design rather than a leak: one carries the
    // RelayState we minted, the other carries the AuthnRequest id the library
    // generated and persisted through our cache provider. Both are consumed.
    expect(stored).toHaveLength(2);
    expect(stored.filter((row) => row.relayState)).toHaveLength(1);
    expect(stored.filter((row) => row.samlRequestId)).toHaveLength(1);

    const storedRelayState = stored.find((row) => row.relayState)!.relayState as string;

    // 256 bits, not a cuid, not the connection id.
    expect(storedRelayState).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(storedRelayState).not.toBe(owner.connectionId);
    expect(storedRelayState.length).toBeGreaterThanOrEqual(43);
  });

  it('refuses an assertion posted with no RelayState at all', async () => {
    const owner = await samlConnection('saml-no-relay');

    await expect(completeSamlSignIn(owner.connectionId, 'cGF5bG9hZA==', null)).rejects.toThrow(SsoError);
  });

  it('refuses a RelayState that was never issued', async () => {
    const owner = await samlConnection('saml-forged-relay');

    await expect(
      completeSamlSignIn(owner.connectionId, 'cGF5bG9hZA==', 'attacker-chosen-relay-state-value'),
    ).rejects.toThrow(/not recognised/i);
  });

  it('refuses a RelayState issued for a different connection', async () => {
    const first = await samlConnection('saml-relay-a');
    const second = await samlConnection('saml-relay-b');

    await samlEntryPoint(first.connectionId);
    const relayState = (
      await prisma.ssoAuthRequest.findFirstOrThrow({ where: { connectionId: first.connectionId, relayState: { not: null } } })
    ).relayState as string;

    // A workspace with a leaked RelayState from another workspace must not be
    // able to complete a sign in with it.
    await expect(completeSamlSignIn(second.connectionId, 'cGF5bG9hZA==', relayState)).rejects.toThrow(/not recognised/i);
  });

  it('consumes the RelayState on first use, so a second presentation is refused', async () => {
    const owner = await samlConnection('saml-single-use');
    await samlEntryPoint(owner.connectionId);
    const relayState = (
      await prisma.ssoAuthRequest.findFirstOrThrow({ where: { connectionId: owner.connectionId, relayState: { not: null } } })
    ).relayState as string;

    /**
     * A real assertion is not needed to prove single use: the RelayState is
     * consumed before the XML is parsed, so both attempts fail at the same place
     * with the same code, and the row is gone afterwards either way. That ordering
     * is deliberate. It means a replay costs no parsing and mints no session even
     * if the signature check would also have caught it.
     */
    const first = await completeSamlSignIn(owner.connectionId, 'cGF5bG9hZA==', relayState).catch((error: Error) => error);
    const sessionsBefore = await prisma.session.count();
    const second = await completeSamlSignIn(owner.connectionId, 'cGF5bG9hZA==', relayState).catch((error: Error) => error);

    expect(first).toBeInstanceOf(SsoError);
    expect(second).toBeInstanceOf(SsoError);
    expect((second as SsoError).code).toBe('SSO_RELAY_STATE_INVALID');

    expect(await prisma.ssoAuthRequest.count({ where: { relayState } })).toBe(0);

    /**
     * The replay minted nothing. Counted as a difference rather than an absolute,
     * because the fixtures in this file sign in normally and those sessions are
     * real and expected to still exist.
     */
    expect(await prisma.session.count()).toBe(sessionsBefore);
  });

  it('refuses an expired RelayState', async () => {
    const owner = await samlConnection('saml-expired');

    await samlEntryPoint(owner.connectionId);
    const row = await prisma.ssoAuthRequest.findFirstOrThrow({ where: { connectionId: owner.connectionId, relayState: { not: null } } });

    await prisma.ssoAuthRequest.update({
      where: { id: row.id },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    await expect(completeSamlSignIn(owner.connectionId, 'cGF5bG9hZA==', row.relayState as string)).rejects.toThrow(
      /expired/i,
    );
  });
});

describe('workspace erasure does not reach into other tenants', () => {
  beforeAll(resetDatabase);

  /**
   * The whole defect in one scenario.
   *
   * A person who consults for two agencies is one `User` row and two `Member`
   * rows. `deleteMany(User where members.some organizationId = A)` matched that
   * user, and the delete cascaded to every membership, every invitation they had
   * issued, every portal grant they held and their credentials. Agency B never
   * consented and lost all of it because agency A asked to be forgotten.
   */
  it('leaves another workspace untouched when one workspace is erased', async () => {
    const first = await agency('erase-first');
    const second = await agency('erase-second');

    const consultantEmail = `consultant-${Date.now()}-${fixtureId}@example.com`;
    expect(
      (await request(app).post('/api/auth/sign-up/email').send({ name: 'Consultant', email: consultantEmail, password })).status,
    ).toBe(200);
    await prisma.user.update({ where: { email: consultantEmail }, data: { emailVerified: true } });
    const consultant = await prisma.user.findUniqueOrThrow({ where: { email: consultantEmail }, select: { id: true } });

    // Member of both workspaces, and the issuer of a pending invitation in the second.
    for (const organizationId of [first.organizationId, second.organizationId]) {
      await prisma.member.create({
        data: {
          id: `member-${organizationId.slice(0, 6)}-${fixtureId}`,
          organizationId,
          userId: consultant.id,
          role: 'analyst',
          createdAt: new Date(),
        },
      });
    }
    await prisma.invitation.create({
      data: {
        id: `invite-${fixtureId}`,
        organizationId: second.organizationId,
        email: 'newcomer@example.com',
        role: 'analyst',
        status: 'pending',
        inviterId: consultant.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
      },
    });

    const before = await prisma.user.findUniqueOrThrow({ where: { email: consultantEmail }, select: { id: true } });
    expect(before.id).toBe(consultant.id);

    // Erase the first workspace only.
    const requested = await first.agent.post(`/api/workspaces/${first.organizationId}/erasures`).send({
      scope: 'ORGANIZATION',
      confirm: true,
    });
    // 202 with a seven day grace period, not an immediate deletion.
    expect(requested.status).toBe(202);

    // Run the executor directly, as the scheduled job does.
    const { executeDueErasures } = await import('../src/services/erasure/erasure.service.js');
    await executeDueErasures(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));

    // The first workspace is gone.
    expect(await prisma.organization.findUnique({ where: { id: first.organizationId } })).toBeNull();

    /**
     * Everything below is what the cascade used to destroy. The consultant still
     * exists, is still a member of the second workspace, the invitation they had
     * issued there is still pending, and they can still sign in.
     */
    expect(await prisma.user.findUnique({ where: { email: consultantEmail } })).not.toBeNull();

    const memberships = await prisma.member.findMany({ where: { userId: consultant.id } });
    expect(memberships.map((m) => m.organizationId)).toEqual([second.organizationId]);

    const invitation = await prisma.invitation.findUnique({
      where: { id: `invite-${fixtureId}` },
      select: { status: true, inviterId: true },
    });
    expect(invitation).not.toBeNull();
    expect(invitation?.status).toBe('pending');

    const accounts = await prisma.account.count({ where: { userId: consultant.id } });
    expect(accounts).toBe(1);
  });

  it('still deletes a person who belonged only to the erased workspace', async () => {
    const owner = await agency('erase-sole');
    const email = `solo-${Date.now()}-${fixtureId}@example.com`;

    expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Solo', email, password })).status).toBe(200);
    await prisma.user.update({ where: { email }, data: { emailVerified: true } });
    const solo = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    await prisma.member.create({
      data: { id: `member-solo-${fixtureId}`, organizationId: owner.organizationId, userId: solo.id, role: 'admin', createdAt: new Date() },
    });

    await owner.agent.post(`/api/workspaces/${owner.organizationId}/erasures`).send({ scope: 'ORGANIZATION', confirm: true });
    const { executeDueErasures } = await import('../src/services/erasure/erasure.service.js');
    await executeDueErasures(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));

    // Nobody else can reach them, so nothing is orphaned by keeping the row.
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });
});

describe('SSO just in time provisioning', () => {
  beforeAll(resetDatabase);

  async function jitConnection(label: string, provisioning: 'JIT' | 'DISABLED' = 'JIT') {
    const owner = await agency(label);
    const connection = await createSsoConnection({
      organizationId: owner.organizationId,
      label: 'Okta',
      protocol: 'SAML',
      issuer: 'https://okta.test/entity',
      entryPoint: 'https://okta.test/sso',
      clientId: 'client-1',
      clientSecret: 'a-signing-secret',
      idpCertificate: placeholderCertificate,
      provisioning,
      allowedEmailDomains: ['northgate.test'],
      defaultRole: 'analyst',
    });

    const loaded = await prisma.ssoConnection.findUniqueOrThrow({
      where: { id: connection.id },
      include: { connections: { select: { domain: true } }, organization: { select: { id: true, name: true } } },
    });

    return { ...owner, connection: loaded };
  }

  it('provisions a brand new person when provisioning is on', async () => {
    const owner = await jitConnection('jit-new');

    const result = await completeSignIn(owner.connection, {
      email: `new-${Date.now()}@northgate.test`,
      providerSubject: 'subject-1',
    });

    expect(result.created).toBe(true);
    // The workspace owner is already a member, so this is the second.
    expect(await prisma.member.count({ where: { organizationId: owner.organizationId } })).toBe(2);
  });

  /**
   * The removal that did not stick.
   *
   * A membership row was created whenever one was missing, so removing somebody
   * from a workspace meant nothing: the next sign-in through their own employer's
   * IdP recreated it. Nothing distinguished "has never been here" from "was
   * deliberately removed", because the only thing consulted was the employer's
   * email domain.
   */
  it('does not bring back somebody who was removed from the workspace', async () => {
    const owner = await jitConnection('jit-removed');
    const email = `removed-${Date.now()}@northgate.test`;

    await completeSignIn(owner.connection, { email, providerSubject: 'subject-2' });
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    expect(await prisma.member.count({ where: { organizationId: owner.organizationId, userId: user.id } })).toBe(1);

    await prisma.member.deleteMany({ where: { organizationId: owner.organizationId, userId: user.id } });

    await expect(completeSignIn(owner.connection, { email, providerSubject: 'subject-2' })).rejects.toThrow(
      /not a member/i,
    );
    expect(await prisma.member.count({ where: { organizationId: owner.organizationId, userId: user.id } })).toBe(0);
  });

  it('lets a removed person back in when an administrator invites them', async () => {
    const owner = await jitConnection('jit-reinvited');
    const email = `reinvited-${Date.now()}@northgate.test`;

    await completeSignIn(owner.connection, { email, providerSubject: 'subject-3' });
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    await prisma.member.deleteMany({ where: { organizationId: owner.organizationId, userId: user.id } });

    // `inviterId` is a real foreign key onto a real person.
    const inviter = await prisma.member.findFirstOrThrow({
      where: { organizationId: owner.organizationId },
      select: { userId: true },
    });

    await prisma.invitation.create({
      data: {
        id: `invite-re-${fixtureId}`,
        organizationId: owner.organizationId,
        email,
        role: 'analyst',
        status: 'pending',
        inviterId: inviter.userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
      },
    });

    const result = await completeSignIn(owner.connection, { email, providerSubject: 'subject-3' });
    expect(result.created).toBe(false);
    expect(await prisma.member.count({ where: { organizationId: owner.organizationId, userId: user.id } })).toBe(1);
    expect(
      (await prisma.invitation.findUnique({ where: { id: `invite-re-${fixtureId}` }, select: { status: true } }))?.status,
    ).toBe('accepted');
  });

  it('refuses a new person when provisioning is invitation only', async () => {
    const owner = await jitConnection('jit-disabled', 'DISABLED');

    await expect(
      completeSignIn(owner.connection, { email: `stranger-${Date.now()}@northgate.test`, providerSubject: 'subject-4' }),
    ).rejects.toThrow(/invited/i);
  });

  /**
   * The lockout. `assertMayProvision` refused every address when provisioning was
   * off, so switching a working connection to invitation-only locked out the
   * people it had been letting in, which is the opposite of what "only admits
   * people who have already been invited" describes.
   */
  it('still admits an existing member when provisioning is invitation only', async () => {
    const owner = await jitConnection('jit-disabled-member');

    const email = `member-${Date.now()}@northgate.test`;
    await completeSignIn(owner.connection, { email, providerSubject: 'subject-5' });

    await prisma.ssoConnection.update({
      where: { id: owner.connection.id },
      data: { provisioning: 'DISABLED' },
    });
    const reloaded = await prisma.ssoConnection.findUniqueOrThrow({
      where: { id: owner.connection.id },
      include: { connections: { select: { domain: true } }, organization: { select: { id: true, name: true } } },
    });

    // The same address that was let in a moment ago, now that the mode has
    // changed. The workspace owner is also a member but signed up on a different
    // domain, so the address under test has to be the provisioned one.
    const result = await completeSignIn(reloaded, { email, providerSubject: 'subject-5' });
    expect(result.created).toBe(false);
  });

  it('creates at most one membership per person per workspace', async () => {
    const owner = await jitConnection('jit-unique');
    const email = `concurrent-${Date.now()}@northgate.test`;

    await completeSignIn(owner.connection, { email, providerSubject: 'subject-6' });
    await completeSignIn(owner.connection, { email, providerSubject: 'subject-6' });
    await completeSignIn(owner.connection, { email, providerSubject: 'subject-6' });

    // The `member` quota counts these rows, so a duplicate is a number the
    // customer has been sold.
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    expect(await prisma.member.count({ where: { organizationId: owner.organizationId, userId: user.id } })).toBe(1);
  });
});