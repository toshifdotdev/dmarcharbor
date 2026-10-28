import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { createApiKey } from '../src/services/api-key.service.js';
import { createSsoConnection } from '../src/services/sso/sso.service.js';
import { runReportDigests, sendReportDigestNow } from '../src/services/report-digest.service.js';
import { grantPlan } from './helpers/plan.js';

/**
 * Behaviour coverage for the defects found in the full-repository audit.
 *
 * Each block states the observable consequence that defined the bug, so a passing
 * test means the defect is gone rather than that the code merely runs. Failure
 * modes that produce the wrong answer were the pattern here: an empty body parsed
 * without complaint, a global count reported as a local one, a permission that
 * let a viewer delete, and a sweep that crossed a tenant boundary.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

/** node-saml asserts a certificate at construction. No signature is validated here. */
const placeholderCertificate = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBszCCAV2gAwIBAgIUNVjs8h1PY0uEwGnkVOnkGkMg2MIICIjANBgkqhkiG9w0BAQEF',
  'AAOCAg8AMIICCgKCAgEA0R8bkSBLDPHZ7AjKQFd6yXwOoSK5ZzNkTJgUL0FR9jNXzZz',
  '-----END CERTIFICATE-----',
].join('\n');

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_log", "erasure_request", "report_digest", "export_job", "sso_auth_request", "sso_connection_domain", "sso_connection", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspace(label: string) {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });

  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const created = await agent.post('/api/workspaces').send({ name: 'Agency', slug: `${label}-${Date.now()}-${fixtureId}`, tosAccepted: true, dpaHasRead: true, dpaConfirmsAuthority: true });
  return { agent, organizationId: created.body.id as string };
}

describe('the SAML consumer is fed a parsed form body', () => {
  beforeAll(resetDatabase);

  /**
   * A SAML identity provider POSTs `application/x-www-form-urlencoded` and
   * nothing else. Before the fix the app registered only `express.json`, so
   * `request.body` was empty, `SAMLResponse` read as `''`, and every login failed
   * as `SSO_RELAY_STATE_INVALID` rather than ever reaching assertion validation.
   * The empty-string guard in the controller meant it failed quietly as a wrong
   * answer instead of loudly as a parse error.
   */
  it('reaches relay-state validation rather than being handed an empty body', async () => {
    const owner = await workspace('acs-parsed');

    // Things created through the service rather than the table, so the secret is
    // encrypted the way the sign-in path reads it.
    const connection = await createSsoConnection({
      organizationId: owner.organizationId,
      label: 'Okta',
      protocol: 'SAML',
      issuer: 'https://idp.test/entity',
      entryPoint: 'https://idp.test/sso',
      clientId: 'client-1',
      clientSecret: 'a-signing-secret',
      idpCertificate: placeholderCertificate,
      provisioning: 'DISABLED',
      allowedEmailDomains: [],
      defaultRole: 'analyst',
    } as never);

    // Get as far as a real relay state, through the signed in session that owns
    // the workspace, which is also how the start route resolves its own scope.
    const start = await owner.agent
      .get(`/api/sso/${connection.id}/start`)
      .query({ organizationId: owner.organizationId });
    expect(start.status).toBe(302);
    const relayState = new URL(start.headers.location as string).searchParams.get('RelayState');
    expect(relayState).toBeTruthy();

    // Exactly what an IdP sends: an urlencoded form, not JSON.
    const response = await request(app)
      .post(`/api/sso/${connection.id}/saml/acs`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send({ SAMLResponse: 'bm90LWEtcmVhbC1hc3NlcnRpb24=', RelayState: relayState });

    // The point is not the status, it is that the assertion was reached at all.
    // With an unparsed body the controller reads SAMLResponse as '' and RelayState
    // as null and refuses at the relay-state check having never opened the
    // assertion; here the parsed form carries a real RelayState and a payload that
    // is not a SAML document, so the refusal comes from the assertion itself.
    expect(response.body.error?.code).not.toBe('SSO_RELAY_STATE_INVALID');
    expect(response.body.error?.code).toBe('SSO_RESPONSE_INVALID');
  });
});

describe('a workspace scoped route cannot sweep another tenant', () => {
  beforeAll(resetDatabase);

  /**
   * `POST /workspaces/:id/report-digests/run` called `runReportDigests()` with no
   * filter, so a member with `report: update` in one workspace could evaluate and
   * email every tenant's digests. The scheduler still sweeps globally, so the
   * fix is the argument, not the function.
   */
  it('evaluates only the digests belonging to the workspace named in the route', async () => {
    const first = await workspace('digest-scope-a');
    const second = await workspace('digest-scope-b');
    await grantPlan(first.organizationId, 'HARBOR');
    await grantPlan(second.organizationId, 'HARBOR');

    const [firstClient, secondClient] = await Promise.all([
      prisma.client.create({ data: { organizationId: first.organizationId, name: 'Alpha', slug: 'alpha' } }),
      prisma.client.create({ data: { organizationId: second.organizationId, name: 'Beta', slug: 'beta' } }),
    ]);
    const [firstDomain, secondDomain] = await Promise.all([
  prisma.domain.create({ data: { clientId: firstClient.id, name: 'a-' + Date.now() + '.test', slug: 'a' + Date.now(), dkimSelectors: { create: { selector: 'sel' } } } }),
  prisma.domain.create({ data: { clientId: secondClient.id, name: 'b' + Date.now() + '.test', slug: 'b' + Date.now(), dkimSelectors: { create: { selector: 'sel' } } } }),
    ]);

    await prisma.reportDigest.createMany({
      data: [
        {
          organizationId: first.organizationId,
          domainId: firstDomain.id,
          frequency: 'MONTHLY',
          dayOfMonth: new Date().getUTCDate(),
          sendHourUtc: 0,
          recipientEmails: ['a@example.test'],
          enabled: true,
        },
        {
          organizationId: second.organizationId,
          domainId: secondDomain.id,
          frequency: 'MONTHLY',
          dayOfMonth: new Date().getUTCDate(),
          sendHourUtc: 0,
          recipientEmails: ['b@example.test'],
          enabled: true,
        },
      ],
    });

    const results = await runReportDigests(new Date(), first.organizationId);

    // Only the tenant that was asked about appears at all.
    expect(results).toHaveLength(1);
    const evaluatedDigestIds = results.map((result) => result.digestId);
    const secondDigest = await prisma.reportDigest.findFirstOrThrow({
      where: { organizationId: second.organizationId },
      select: { id: true, lastSentAt: true },
    });
    expect(evaluatedDigestIds).not.toContain(secondDigest.id);
    expect(secondDigest.lastSentAt).toBeNull();
  });
});

describe('a digest is read with its workspace attached', () => {
  beforeAll(resetDatabase);

  /**
   * `sendReportDigestNow` looked the digest up by id alone and relied on its
   * caller for tenancy. The controller happened to check existence first, which
   * closed the hole while leaving an unscoped read of another workspace's row.
   */
  it('refuses a digest that belongs to a different workspace', async () => {
    const owner = await workspace('digest-tenant');
    const stranger = await workspace('digest-stranger');

    const client = await prisma.client.create({ data: { organizationId: owner.organizationId, name: 'Alpha', slug: 'alpha' } });
const domain = await prisma.domain.create({ data: { clientId: client.id, name: 't' + Date.now() + '.test', slug: 't' + Date.now(), dkimSelectors: { create: { selector: 'sel' } } } });
    const digest = await prisma.reportDigest.create({
      data: {
        organizationId: owner.organizationId,
        domainId: domain.id,
        frequency: 'MONTHLY',
        dayOfMonth: 1,
        sendHourUtc: 0,
        recipientEmails: ['a@example.test'],
        enabled: true,
      },
    });

    expect(await sendReportDigestNow(digest.id, owner.organizationId)).toBeDefined();
    expect(await sendReportDigestNow(digest.id, stranger.organizationId)).toBeNull();
  });
});

describe('the erasure reason reaches the row it was given for', () => {
  beforeAll(resetDatabase);

  /**
   * The reason was accepted by the request schema and written into the audit
   * event detail, but there was no column for it, so it never reached the row the
   * UI lists: the person who asked could not see their own stated reason, and a
   * regulator reading the request log saw an empty one.
   */
  it('round trips the reason through create, list and read', async () => {
    const owner = await workspace('erasure-reason');

    const created = await owner.agent
      .post(`/api/workspaces/${owner.organizationId}/erasures`)
      .send({ scope: 'ORGANIZATION', reason: 'ticket #482, data-subject request' });

    expect(created.status).toBe(202);
    expect(created.body.id).toBeTruthy();

    const listed = await owner.agent.get(`/api/workspaces/${owner.organizationId}/erasures`);
    expect(listed.status).toBe(200);
    const row = listed.body.requests.find((r: { id: string }) => r.id === created.body.id);
    expect(row?.reason).toBe('ticket #482, data-subject request');

    const read = await owner.agent.get(`/api/workspaces/${owner.organizationId}/erasures/${created.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body.reason).toBe('ticket #482, data-subject request');
  });

  it('stores nothing as a reason rather than an empty string', async () => {
    const owner = await workspace('erasure-reason-empty');

    const created = await owner.agent
      .post(`/api/workspaces/${owner.organizationId}/erasures`)
      .send({ scope: 'ORGANIZATION' });
    expect(created.status).toBe(202);

    const listed = await owner.agent.get(`/api/workspaces/${owner.organizationId}/erasures`);
    const row = listed.body.requests.find((r: { id: string }) => r.id === created.body.id);
    expect(row?.reason).toBeNull();
  });
});

describe('the v1 API validates the body it already had a schema for', () => {
  beforeAll(resetDatabase);

  /**
   * `createApiClientController` read the raw body and re-implemented the checks
   * loosely: no cap on the name, no pattern on the slug, and `domains` taken as
   * `as string[]`, so a non-string item reached `normaliseDomain`, which throws on
   * anything that is not a string. The result was a 500 for what is a bad request.
   * `apiClientCreateSchema` existed the whole time and was never imported.
   */
  async function writeKey(organizationId: string, userId: string): Promise<string> {
    const created = await createApiKey({
      organizationId,
      name: 'Audit key',
      scopes: ['write'],
      createdById: userId,
    });
    return created.key;
  }

  it('answers 400 rather than 500 when a domain entry is not a string', async () => {
    const owner = await workspace('v1-validation');
    await grantPlan(owner.organizationId, 'HARBOR');
    const userId = (await prisma.organization.findUniqueOrThrow({
      where: { id: owner.organizationId },
      select: { members: { select: { userId: true }, take: 1 } },
    })).members[0].userId;
    const key = await writeKey(owner.organizationId, userId);

    const response = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${key}`)
      .send({ name: 'Alpha', domains: [42] });

    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('INVALID_REQUEST');
  });

  it('answers 400 when the client name is absent', async () => {
    const owner = await workspace('v1-name');
    await grantPlan(owner.organizationId, 'HARBOR');
    const userId = (await prisma.organization.findUniqueOrThrow({
      where: { id: owner.organizationId },
      select: { members: { select: { userId: true }, take: 1 } },
    })).members[0].userId;
    const key = await writeKey(owner.organizationId, userId);

    const response = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${key}`)
      .send({ domains: [] });

    expect(response.status).toBe(400);
  });

  it('still creates a valid client, so the schema did not narrow the route', async () => {
    const owner = await workspace('v1-valid');
    await grantPlan(owner.organizationId, 'HARBOR');
    const userId = (await prisma.organization.findUniqueOrThrow({
      where: { id: owner.organizationId },
      select: { members: { select: { userId: true }, take: 1 } },
    })).members[0].userId;
    const key = await writeKey(owner.organizationId, userId);

    const response = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${key}`)
      .send({ name: 'Alpha', domains: ['alpha.test'] });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe('Alpha');
  });
});
