/**
 * The issuer is checked before the service fetches it.
 *
 * `createSchema` validated `issuer` with `min(1)`, so any non-empty string was
 * stored - and the value is later passed to `new URL(...)` and fetched by
 * `openid-client` as `<issuer>/.well-known/openid-configuration`. A string
 * carrying a path, or one that resolves to a link-local address, made this
 * service request an internal host over a scheme an administrator had already
 * been told was fine.
 *
 * The resolution half needs the network, so these tests cover the check that
 * does not: the shape of the string, at the boundary. The resolution guard is
 * covered in `ssrf-guard.unit.test.ts`, where the lookup is injected.
 */

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { grantPlan } from './helpers/plan.js';

const password = 'correct-horse-battery-staple';

let fixtureId = 0;

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "sso_auth_request", "sso_connection_domain", "sso_connection", "subscription", "organization", member, session, account, verification, "user" CASCADE',
  );
}

async function setup(): Promise<{ agent: ReturnType<typeof request.agent>; organizationId: string }> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `sso-issuer-${Date.now()}-${fixtureId}@northgate.test`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'SSO Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const created = await agent.post('/api/workspaces').send({
    name: 'Northgate Digital',
    slug: `si-${Date.now()}-${fixtureId}`,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  const organizationId = created.body.id as string;
  await grantPlan(organizationId, 'ADMIRALTY');
  return { agent, organizationId };
}

function body(issuer: string): Record<string, unknown> {
  return {
    label: 'Okta',
    protocol: 'OIDC',
    issuer,
    entryPoint: 'https://app.dmarcharbor.com/api/sso/placeholder/callback',
    clientId: '0oa1abcDEF',
    clientSecret: 'the-provider-client-secret',
    provisioning: 'JIT',
    allowedEmailDomains: ['northgate.test'],
    defaultRole: 'analyst',
  };
}

describe('an SSO connection cannot be given any string as its issuer', () => {
  beforeEach(resetDatabase);

  it('refuses a scheme that is not https', async () => {
    const { agent, organizationId } = await setup();

    const response = await agent
      .post(`/api/workspaces/${organizationId}/sso-connections`)
      .send(body('http://northgate.okta.com'));

    // Refused at the boundary rather than stored and fetched later, because the
    // later failure is a sign-in attempt that never completes.
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/https/i);
  });

  it('refuses a value that is not a URL at all', async () => {
    const { agent, organizationId } = await setup();

    const response = await agent
      .post(`/api/workspaces/${organizationId}/sso-connections`)
      .send(body('northgate.okta.com'));

    expect(response.status).toBe(400);
  });

  it('refuses an issuer carrying a path', async () => {
    const { agent, organizationId } = await setup();

    // The discovery document is fetched by trimming a trailing slash and
    // appending the well-known path, so a base URL with a path relocates the
    // request to a subdirectory the administrator did not choose.
    const response = await agent
      .post(`/api/workspaces/${organizationId}/sso-connections`)
      .send(body('https://northgate.okta.com/oauth2/default'));

    expect(response.status).toBe(400);
  });

  it('stores nothing when the issuer is refused', async () => {
    const { agent, organizationId } = await setup();

    await agent
      .post(`/api/workspaces/${organizationId}/sso-connections`)
      .send(body('http://northgate.okta.com'));

    // A refused connection must not leave a row behind, or a second attempt would
    // collide on an id the caller believes it never created.
    expect(await prisma.ssoConnection.count({ where: { organizationId } })).toBe(0);
  });

  it('refuses to start a sign-in through another workspace’s connection', async () => {
    const victim = await setup();
    const attacker = await setup();

    await attacker.agent
      .post(`/api/workspaces/${attacker.organizationId}/sso-connections`)
      .send(body('https://northgate.okta.com'));

    const attackerConnection = await prisma.ssoConnection.findFirstOrThrow({
      where: { organizationId: attacker.organizationId },
    });

    // The victim knows nothing about it and is not a member of it.
    const start = await victim.agent.get(`/api/sso/${attackerConnection.id}/start`);

    // Either a refusal or a scope failure, never a redirect to the provider.
    expect(start.status).not.toBe(302);

    // And the victim's own workspace still has no connection, so the attempt
    // created nothing on the way through.
    expect(await prisma.ssoConnection.count({ where: { organizationId: victim.organizationId } })).toBe(0);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
