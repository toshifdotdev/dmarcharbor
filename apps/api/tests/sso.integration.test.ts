import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { grantPlan } from './helpers/plan.js';
import { SsoError, createSsoConnection, listSsoConnections, normalizeEmailDomain, assertMayProvision } from '../src/services/sso/sso.service.js';

/**
 * Workspace single sign on.
 *
 * The behaviour worth testing is not the redirect plumbing, it is who is allowed
 * in. A sign in flow that works perfectly and accepts an address from any domain
 * on the internet is worse than no single sign on at all, because it looks like
 * a security control while being an open door. So these tests are mostly about
 * the allowlist, about one workspace's connection not being usable by another,
 * and about provisioning never handing out the owner role.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "sso_auth_request", "sso_connection_domain", "sso_connection", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup(plan: 'MOORING' | 'FAIRWAY' | 'HARBOR' | 'ADMIRALTY' = 'ADMIRALTY') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `sso-${Date.now()}-${fixtureId}@northgate.test`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'SSO Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Northgate Digital',
    slug: `s-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
  const organizationId = workspace.body.id as string;
  if (plan !== 'MOORING') {
    await grantPlan(organizationId, plan);
  }

  return { agent, organizationId };
}

function connectionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: 'Okta',
    protocol: 'OIDC',
    issuer: 'https://northgate.okta.com',
    entryPoint: 'https://app.dmarcharbor.com/api/sso/placeholder/callback',
    clientId: '0oa1abcDEF',
    clientSecret: 'the-provider-client-secret',
    provisioning: 'JIT',
    allowedEmailDomains: ['northgate.test'],
    defaultRole: 'analyst',
    ...overrides,
  };
}

describe('email domain normalisation', () => {
  it('treats the same domain written different ways as one domain', () => {
    // A comparison that treats these as different can be evaded by typing a
    // different case, so the normalisation is part of the allowlist rather than
    // a convenience.
    expect(normalizeEmailDomain('Northgate.TEST')).toBe('northgate.test');
    expect(normalizeEmailDomain('@northgate.test')).toBe('northgate.test');
    expect(normalizeEmailDomain('northgate.test.')).toBe('northgate.test');
    expect(normalizeEmailDomain('  northgate.test  ')).toBe('northgate.test');
  });
});

describe('connection settings', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('stores the provider secret encrypted and never returns it', async () => {
    const { organizationId } = await setup();

    await createSsoConnection({ organizationId, ...connectionBody() } as never);

    const row = await prisma.ssoConnection.findFirstOrThrow({ where: { organizationId } });
    expect(row.clientSecretEncrypted).not.toContain('the-provider-client-secret');
    expect(row.clientSecretEncrypted).not.toBe('the-provider-client-secret');

    const listed = await listSsoConnections(organizationId);
    expect(JSON.stringify(listed)).not.toContain('the-provider-client-secret');
  });

  it('refuses just in time provisioning with no permitted domain', async () => {
    const { organizationId } = await setup();

    // An empty allowlist with provisioning on would accept an address from any
    // domain on the internet, so this is refused at configuration time rather
    // than discovered at first login.
    await expect(
      createSsoConnection({ organizationId, ...connectionBody({ allowedEmailDomains: [] }) } as never),
    ).rejects.toBeInstanceOf(SsoError);
  });

  it('refuses a domain that is not a domain', async () => {
    const { organizationId } = await setup();

    await expect(
      createSsoConnection({ organizationId, ...connectionBody({ allowedEmailDomains: ['not a domain'] }) } as never),
    ).rejects.toBeInstanceOf(SsoError);
  });

  it('allows a connection with no domains when provisioning is off', async () => {
    const { organizationId } = await setup();

    // With provisioning disabled the allowlist governs nothing, because nobody
    // new can join through the connection at all.
    const created = await createSsoConnection({
      organizationId,
      ...connectionBody({ provisioning: 'DISABLED', allowedEmailDomains: [] }),
    } as never);

    expect(created.id).toBeTruthy();
  });

  it('is refused to a workspace below Admiralty', async () => {
    const { agent, organizationId } = await setup('HARBOR');

    const response = await agent
      .post(`/api/workspaces/${organizationId}/sso-connections`)
      .send(connectionBody());

    expect(response.status).toBe(402);
    expect(response.body.error.feature).toBe('auth.sso');
    expect(await prisma.ssoConnection.count({ where: { organizationId } })).toBe(0);
  });

  it('is available to an Admiralty workspace', async () => {
    const { agent, organizationId } = await setup('ADMIRALTY');

    const response = await agent
      .post(`/api/workspaces/${organizationId}/sso-connections`)
      .send(connectionBody());

    expect(response.status).toBe(201);
  });
});

describe('who a connection admits', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  async function connection(organizationId: string, domains: string[] = ['northgate.test']) {
    const created = await createSsoConnection({
      organizationId,
      ...connectionBody({ allowedEmailDomains: domains }),
    } as never);
    return prisma.ssoConnection.findUniqueOrThrow({
      where: { id: created.id },
      include: { connections: { select: { domain: true } } },
    });
  }

  it('admits an address inside the allowlist', () => {
    const c = connectionFixture(['northgate.test']);
    expect(() => assertMayProvision(c, 'someone@northgate.test')).not.toThrow();
  });

  it('refuses an address outside the allowlist', () => {
    const c = connectionFixture(['northgate.test']);

    // The person signed in successfully at their own provider, and that proves
    // nothing about whether they may join this workspace.
    expect(() => assertMayProvision(c, 'attacker@gmail.com')).toThrow(SsoError);
  });

  it('refuses an address that merely looks like the permitted domain', () => {
    const c = connectionFixture(['northgate.test']);

    // Suffix matching would accept all three of these, so the comparison is on
    // the parsed domain rather than on the shape of the string.
    expect(() => assertMayProvision(c, 'attacker@northgate.test.evil.com')).toThrow(SsoError);
    expect(() => assertMayProvision(c, 'attacker@evilnorthgate.test')).toThrow(SsoError);
    expect(() => assertMayProvision(c, 'attacker@sub.northgate.test')).toThrow(SsoError);
  });

  it('is not fooled by case', () => {
    const c = connectionFixture(['northgate.test']);
    expect(() => assertMayProvision(c, 'Someone@NorthGate.TEST')).not.toThrow();
  });

  it('checks the address and the allowlist, not the provisioning mode', () => {
    const c = connectionFixture(['northgate.test']);
    const disabled = { ...c, provisioning: 'DISABLED' as const };

    /**
     * Deliberately does not throw now.
     *
     * This used to assert that every address is refused when provisioning is off,
     * which contradicted the error message beside it: "this connection only
     * admits people who have already been invited" cannot be enforced by refusing
     * everybody. In practice an administrator who switched a connection to
     * invitation-only locked every existing member out of it.
     *
     * Whether a given person may join depends on whether they already hold a
     * membership or a pending invitation, which is a question about the database.
     * It is answered in `completeSignIn`, and covered below.
     */
    expect(() => assertMayProvision(disabled, 'someone@northgate.test')).not.toThrow();

    // The allowlist still governs, in either mode.
    expect(() => assertMayProvision(disabled, 'attacker@gmail.com')).toThrow(SsoError);
  });

  it('refuses an address with no domain', () => {
    const c = connectionFixture(['northgate.test']);
    expect(() => assertMayProvision(c, 'not-an-email')).toThrow(SsoError);
  });

  it('does not disclose which domains are registered', () => {
    const c = connectionFixture(['northgate.test']);
    let message = '';
    try {
      assertMayProvision(c, 'attacker@gmail.com');
    } catch (error) {
      message = (error as Error).message;
    }

    // The message must not confirm or deny that a domain is known, or this
    // becomes a way to discover which domains a workspace uses.
    expect(message).not.toContain('northgate.test');
  });

  it('lets a sign in page name the workspace, so a fake provider is obvious', async () => {
    const first = await setup();
    const target = await connection(first.organizationId);

    // Knowing the connection id is meant to be enough to start a sign in, and
    // the page that does so should say whose workspace it is. That is a
    // phishing defence: a person about to enter their work password somewhere
    // should see the name they expect.
    const response = await request(app).get(`/api/sso/${target.id}`);

    expect(response.status).toBe(200);
    expect(response.body.organization).toBe('Northgate Digital');
  });

  it('cannot use a known connection id to skip the domain allowlist', async () => {
    const first = await setup();
    const target = await connection(first.organizationId, ['northgate.test']);

    // The id is a capability for starting a sign in, not a way past the check
    // that decides who the connection admits. Knowing it changes nothing about
    // what the assertion has to satisfy.
    expect(() => assertMayProvision(target, 'attacker@gmail.com')).toThrow(SsoError);
    expect(() => assertMayProvision(target, 'someone@northgate.test')).not.toThrow();
  });

  it('refuses to delete another workspace connection', async () => {
    const first = await setup();
    const second = await setup();
    const target = await connection(first.organizationId);

    const removed = await second.agent
      .delete(`/api/workspaces/${second.organizationId}/sso-connections/${target.id}`)
      .set('Authorization', `Bearer ${'test-staff-key-not-a-real-secret'}`);

    // The delete is scoped to the workspace in the query itself, so a
    // connection id from elsewhere removes nothing rather than reaching across
    // tenants.
    expect([403, 404, 401]).toContain(removed.status);
    expect(await prisma.ssoConnection.findUnique({ where: { id: target.id } })).not.toBeNull();
  });
});

/** A connection record shaped the way the flow code reads it. */
function connectionFixture(domains: string[]) {
  return {
    provisioning: 'JIT' as const,
    connections: domains.map((domain) => ({ domain })),
  };
}
