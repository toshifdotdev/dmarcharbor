import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import {
  completeSamlSignIn,
  samlEntryPoint,
  samlRequestCacheFor,
} from '../src/services/sso/sso-flow.service.js';
import { SsoError, createSsoConnection } from '../src/services/sso/sso.service.js';

/**
 * The `InResponseTo` half of SAML replay protection, exercised through the real
 * library call path.
 *
 * This exists because the first round of SAML tests proved the wrong thing. They
 * posted a base64 string that decoded to `payload`, the library threw while
 * parsing it as XML, and `validateInResponseTo` was therefore never reached. So
 * `getAsync` and `removeAsync` - the two methods that make `validateInResponseTo:
 * 'always'` either work or break every sign-in - had no coverage at all.
 *
 * The fix is a minimal Response element that parses. It carries an
 * `InResponseTo` and no signature, so the library gets as far as the cache lookup,
 * succeeds or fails there, and then refuses on the signature. Which of those two
 * refusals happened is the observable difference, and it is the difference that
 * matters.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

/**
 * node-saml asserts a certificate at construction. These tests never validate a
 * real signature, so any well formed PEM satisfies it.
 */
const placeholderCertificate = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBszCCAV2gAwIBAgIUNVjs8h1PY0uEwGnkVOnkGkMg2MIICIjANBgkqhkiG9w0BAQEF',
  'AAOCAg8AMIICCgKCAgEA0R8bkSBLDPHZ7AjKQFd6yXwOoSK5ZzNkTJgUL0FR9jNXzZz',
  '-----END CERTIFICATE-----',
].join('\n');

/**
 * A SAML Response that parses, carries the given `InResponseTo`, and is unsigned.
 *
 * Only three things about it matter to the library: the root's local name must be
 * `Response`, the `InResponseTo` attribute is read off the root, and there must be
 * no valid signature over it.
 */
function unsignedResponse(inResponseTo?: string | null): string {
  const attribute = inResponseTo === undefined ? '' : ` InResponseTo="${inResponseTo}"`;
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"',
    ' xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"',
    ` ID="_resp_${Math.random().toString(36).slice(2)}" Version="2.0"${attribute}`,
    ' IssueInstant="2026-01-01T00:00:00Z">',
    '<saml:Issuer>https://idp.test/entity</saml:Issuer>',
    '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>',
    '</samlp:Response>',
  ].join('');
  return Buffer.from(xml, 'utf8').toString('base64');
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "sso_auth_request", "sso_connection_domain", "sso_connection", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function samlConnection(label: string) {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });

  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const created = await agent.post('/api/workspaces').send({ name: 'Agency', slug: `${label}-${Date.now()}-${fixtureId}` });
  const organizationId = created.body.id as string;

  const connection = await createSsoConnection({
    organizationId,
    label: 'Okta',
    protocol: 'SAML',
    issuer: 'https://idp.test/entity',
    entryPoint: 'https://idp.test/sso',
    clientId: 'client-1',
    clientSecret: 'a-signing-secret',
    idpCertificate: placeholderCertificate,
    provisioning: 'JIT',
    allowedEmailDomains: ['northgate.test'],
    defaultRole: 'analyst',
  } as never);

  return { organizationId, connectionId: connection.id };
}

/** Starts a sign in and returns a RelayState that has not been consumed. */
async function freshRelayState(connectionId: string): Promise<string> {
  await samlEntryPoint(connectionId);
  const row = await prisma.ssoAuthRequest.findFirstOrThrow({
    where: { connectionId, relayState: { not: null } },
    select: { relayState: true },
  });
  return row.relayState as string;
}

describe('SAML request tracking cache provider', () => {
  beforeAll(resetDatabase);

  it('round trips a saved request id', async () => {
    const owner = await samlConnection('cache-round-trip');
    const cache = samlRequestCacheFor(owner.connectionId);

    await cache.saveAsync('_req_round_trip', new Date().toISOString());

    // What node-saml calls to decide whether an `InResponseTo` is one of ours.
    const found = await cache.getAsync('_req_round_trip');
    expect(found).not.toBeNull();
    expect(new Date(found as string).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('returns null for a request id it never issued', async () => {
    const owner = await samlConnection('cache-unknown');
    const cache = samlRequestCacheFor(owner.connectionId);

    expect(await cache.getAsync('_req_never_issued')).toBeNull();
  });

  it('returns null and clears the row once the request has expired', async () => {
    const owner = await samlConnection('cache-expiry');
    const cache = samlRequestCacheFor(owner.connectionId);

    await cache.saveAsync('_req_expired', new Date().toISOString());
    await prisma.ssoAuthRequest.updateMany({
      where: { samlRequestId: '_req_expired' },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    expect(await cache.getAsync('_req_expired')).toBeNull();
    expect(await prisma.ssoAuthRequest.count({ where: { samlRequestId: '_req_expired' } })).toBe(0);
  });

  it('removes a request id, so a second read misses', async () => {
    const owner = await samlConnection('cache-remove');
    const cache = samlRequestCacheFor(owner.connectionId);

    await cache.saveAsync('_req_remove', new Date().toISOString());
    expect(await cache.getAsync('_req_remove')).not.toBeNull();

    await cache.removeAsync('_req_remove');

    expect(await cache.getAsync('_req_remove')).toBeNull();
    expect(await prisma.ssoAuthRequest.count({ where: { samlRequestId: '_req_remove' } })).toBe(0);
  });

  /**
   * The library calls this with null when there was no `InResponseTo` to remove,
   * so it must not throw. A cache provider that throws inside the library's
   * `catch` block would replace a clean refusal with an unhandled error.
   */
  it('tolerates a null key on remove', async () => {
    const owner = await samlConnection('cache-null');
    const cache = samlRequestCacheFor(owner.connectionId);

    await expect(cache.removeAsync(null)).resolves.toBeNull();
  });
});

describe('InResponseTo is checked, through the library', () => {
  beforeAll(resetDatabase);

  /**
   * This is the configuration assertion as behaviour.
   *
   * If `validateInResponseTo` were `never` or `ifPresent`, an unknown request id
   * would skip the lookup entirely and fall through to the signature check, which
   * would report `SSO_RESPONSE_INVALID` instead. Getting
   * `SSO_IN_RESPONSE_TO_INVALID` here means the check is genuinely on.
   */
  it('refuses an assertion whose request we never made', async () => {
    const owner = await samlConnection('irt-unknown');
    const relayState = await freshRelayState(owner.connectionId);

    const error = await completeSamlSignIn(owner.connectionId, unsignedResponse('_req_never_issued'), relayState).catch(
      (thrown: Error) => thrown,
    );

    expect(error).toBeInstanceOf(SsoError);
    expect((error as SsoError).code).toBe('SSO_IN_RESPONSE_TO_INVALID');
  });

  it('refuses an assertion carrying no InResponseTo at all', async () => {
    const owner = await samlConnection('irt-missing');
    const relayState = await freshRelayState(owner.connectionId);

    const error = await completeSamlSignIn(owner.connectionId, unsignedResponse(), relayState).catch(
      (thrown: Error) => thrown,
    );

    // This is the login CSRF case: a response the provider never produced for a
    // request we made is refused before any account is touched.
    expect(error).toBeInstanceOf(SsoError);
    expect((error as SsoError).code).toBe('SSO_IN_RESPONSE_TO_INVALID');
  });

  /**
   * The one that matters most, and the one that had no coverage at all.
   *
   * A request id we *did* issue gets past the cache lookup, and the assertion is
   * then refused for the unrelated reason that it carries no valid signature. If
   * this reported `SSO_IN_RESPONSE_TO_INVALID` instead, the cache provider would
   * be failing to find requests it made, and every genuine sign-in would be
   * turned away at the door.
   */
  it('gets past the lookup for a request we did issue, then refuses on the signature', async () => {
    const owner = await samlConnection('irt-known');
    const relayState = await freshRelayState(owner.connectionId);

    // The id node-saml generated and persisted when the sign in started.
    const issued = await prisma.ssoAuthRequest.findFirstOrThrow({
      where: { connectionId: owner.connectionId, samlRequestId: { not: null } },
      select: { samlRequestId: true },
    });

    const error = await completeSamlSignIn(
      owner.connectionId,
      unsignedResponse(issued.samlRequestId),
      relayState,
    ).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(SsoError);
    expect((error as SsoError).code).toBe('SSO_RESPONSE_INVALID');
    // The distinguishing assertion: it was not refused for its request id.
    expect(String((error as SsoError).message)).not.toMatch(/inresponseto/i);
  });

  /**
   * Single use, through the library's own call order.
   *
   * node-saml removes the request id on the way out of validation whether it
   * succeeded or threw, so the first attempt consumes it. A replay therefore
   * misses in the cache, which is a different refusal from the first one. Without
   * that removal the id would sit there until its ten minute expiry and every
   * replay inside that window would pass the `InResponseTo` check.
   */
  it('consumes the request id on the first attempt, so a replay misses', async () => {
    const owner = await samlConnection('irt-replay');
    const relayState = await freshRelayState(owner.connectionId);

    const issued = await prisma.ssoAuthRequest.findFirstOrThrow({
      where: { connectionId: owner.connectionId, samlRequestId: { not: null } },
      select: { samlRequestId: true },
    });
    const requestId = issued.samlRequestId as string;

    // The RelayState is single use too, so it is restored to isolate the assertion
    // replay from the binding check. Otherwise the second attempt would be refused
    // for a missing RelayState and would prove nothing about InResponseTo.
    const first = await completeSamlSignIn(owner.connectionId, unsignedResponse(requestId), relayState).catch(
      (thrown: Error) => thrown,
    );
    expect((first as SsoError).code).toBe('SSO_RESPONSE_INVALID');

    expect(await prisma.ssoAuthRequest.count({ where: { samlRequestId: requestId } })).toBe(0);

    await prisma.ssoAuthRequest.create({
      data: { connectionId: owner.connectionId, relayState: 'relay-for-replay-test', createdAt: new Date() },
    });

    const replay = await completeSamlSignIn(
      owner.connectionId,
      unsignedResponse(requestId),
      'relay-for-replay-test',
    ).catch((thrown: Error) => thrown);

    // A different refusal from the first attempt, and the right one: the request
    // id has been used.
    expect((replay as SsoError).code).toBe('SSO_IN_RESPONSE_TO_INVALID');
  });
});