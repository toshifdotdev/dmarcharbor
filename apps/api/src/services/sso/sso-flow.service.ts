import { randomBytes, createHash } from 'node:crypto';
import * as saml from '@node-saml/node-saml';
import {
  ClientSecretPost,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
import { prisma } from '../../database/prisma.js';
import { env } from '../../config/env.js';
import { decryptSensitive, encryptSensitive } from '../privacy.service.js';
import { recordAuditEvent } from '../audit.service.js';
import { SsoError, assertMayProvision, normalizeEmailDomain } from './sso.service.js';

/**
 * The two sign in flows.
 *
 * Both end in the same place: an identity the provider has vouched for, an
 * email address, and a workspace. What differs is the wire format, and the part
 * that actually matters is identical in both, so it lives in one function rather
 * than being written twice. In particular the domain allowlist and the
 * provisioning mode are checked in exactly one place, because a rule that is
 * applied in the OIDC path and forgotten in the SAML path is an open door that
 * happens to be behind a different logo.
 *
 * The provider's signature or token is verified before anything here runs. A
 * caller that reaches this file is trusted to have authenticated; the checks
 * below decide what that identity is allowed to do, not whether it is real.
 */

/** How long an in flight authorisation request may sit around. */
const requestTtlMs = 10 * 60 * 1000;

/**
 * Request tracking for SAML, held in the database rather than in process memory.
 *
 * `node-saml` protects against replay by writing each outgoing AuthnRequest id to
 * a `cacheProvider`, refusing an assertion whose `InResponseTo` is not in that
 * cache, and removing the id once the assertion validates. The default provider is
 * an in-memory map, which is correct for one process and wrong for two: a user
 * whose sign-in start and assertion return land on different replicas fails for no
 * visible reason, and a rolling deploy drops every request in flight.
 *
 * Backing it with the existing `sso_auth_request` table makes the guarantee hold
 * across instances and restarts, which is the only version of it worth having for
 * an endpoint that mints seven day sessions.
 *
 * Two properties matter and both come from the library's own call pattern: `get` is
 * consulted before the assertion is trusted, and `remove` is called immediately
 * after it is, so a second presentation of the same assertion finds nothing. That
 * is single use without this code inventing a nonce of its own.
 */
const samlRequestCacheFor = (connectionId: string) => ({
  async saveAsync(key: string, value: string) {
    await prisma.ssoAuthRequest.create({
      data: {
        connectionId,
        // node-saml hands us the issue instant, not the PKCE verifier, so the
        // request id is the key and the value is the timestamp it ages out by.
        samlRequestId: key,
        verifier: value,
        createdAt: new Date(),
      },
    });
    return null;
  },

  async getAsync(key: string) {
    const row = await prisma.ssoAuthRequest.findUnique({
      where: { samlRequestId: key },
      select: { createdAt: true },
    });
    if (!row) {
      return null;
    }
    if (Date.now() - row.createdAt.getTime() > requestTtlMs) {
      await prisma.ssoAuthRequest.deleteMany({ where: { samlRequestId: key } });
      return null;
    }
    return row.createdAt.toISOString();
  },

  async removeAsync(key: string | null) {
    if (!key) {
      return null;
    }
    await prisma.ssoAuthRequest.deleteMany({ where: { samlRequestId: key } });
    return null;
  },
});

async function purgeExpiredRequests(): Promise<void> {
  await prisma.ssoAuthRequest.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - requestTtlMs) } },
  });
}

type Connection = Awaited<ReturnType<typeof loadConnection>>;

async function loadConnection(connectionId: string) {
  const connection = await prisma.ssoConnection.findUnique({
    where: { id: connectionId },
    include: { connections: { select: { domain: true } }, organization: { select: { id: true, name: true } } },
    // clientId is needed to build the provider configuration, so it has to come
    // back with the connection rather than being looked up separately.
  });

  if (!connection || !connection.enabled) {
    // The same answer for a connection that does not exist and one that is
    // disabled, so the endpoint cannot be used to probe which ids are real.
    throw new SsoError('No such single sign on connection.', 'SSO_NOT_FOUND', 404);
  }

  return connection;
}

function requireSecret(connection: { clientSecretEncrypted: string }): string {
  const secret = decryptSensitive(connection.clientSecretEncrypted);
  if (!secret) {
    throw new SsoError('The stored identity provider secret could not be read.', 'SSO_CONFIG_INVALID', 500);
  }
  return secret;
}

/**
 * Roles a just in time member may be given.
 *
 * `owner` is absent on purpose. Provisioning is unattended, so handing out the
 * owner role from an identity provider would mean anyone the directory happens
 * to contain could become the person who can change the plan or invite others.
 * Someone has to grant that deliberately, by invitation.
 */
const provisionableRoles = new Set(['analyst', 'viewer', 'admin']);

function provisionableRole(requested: string): string {
  return provisionableRoles.has(requested) ? requested : 'analyst';
}

export interface VerifiedIdentity {
  email: string;
  name?: string;
  providerSubject: string;
}

/**
 * Turns a verified identity into a session.
 *
 * The allowlist is checked first, before any account is looked at or created, so
 * an address from a domain the workspace has not registered cannot cause a user
 * row to exist at all. Without that ordering the provisioning check would be a
 * check on an already committed side effect.
 */
export async function completeSignIn(
  connection: NonNullable<Connection>,
  identity: VerifiedIdentity,
  requestId?: string,
): Promise<{ organizationId: string; userId: string; created: boolean }> {
  const email = identity.email.trim().toLowerCase();
  const domain = assertMayProvision(connection, email);

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  let userId = existing?.id;
  let created = false;

  if (!userId) {
      /**
       * Someone we have never seen before can only join by being provisioned.
       *
       * This is the only place the provisioning mode decides anything, which is
       * what makes "invitation only" mean what it says: an address with no account
       * and no invitation is refused, while an address that already holds a
       * membership is not affected by the mode at all and can keep signing in.
       */
      if (connection.provisioning === 'DISABLED') {
        throw new SsoError(
          'This connection only admits people who have already been invited.',
          'SSO_PROVISIONING_DISABLED',
          403,
        );
      }

      const role = provisionableRole(connection.defaultRole);

    const user = await prisma.user.create({
      data: {
        // The user table predates our own conventions and has no generated id,
        // so it is supplied here rather than defaulted.
        id: randomBytes(16).toString('hex'),
        email,
        emailVerified: true,
        // No password. The account is reachable only through the provider, which
        // is the point: a local password would be a second way in that the
        // customer's own access policy cannot see or revoke.
        name: identity.name?.trim() || email.split('@')[0],
        members: {
          create: {
            id: randomBytes(16).toString('hex'),
            organizationId: connection.organizationId,
            role,
            createdAt: new Date(),
          },
        },
      },
      select: { id: true },
    });

    userId = user.id;
    created = true;
  } else {
    /**
     * An existing account is only re-attached if it is not already a member.
     *
     * The membership row is created whenever one is missing, which meant removing
     * somebody from a workspace did not stick: the next time they signed in
     * through their own employer's IdP they reappeared, because nothing in the
     * connection distinguished "has never been here" from "was deliberately
     * removed". The only thing consulted was the email domain allowlist, which is
     * a property of their employer rather than a decision this workspace made.
     *
     * A removal is now a removal. Someone removed by an administrator has to be
     * invited back, which is what an invitation is for.
     */
    const already = await prisma.member.findUnique({
      where: { organizationId_userId: { organizationId: connection.organizationId, userId } },
      select: { id: true },
    });

    if (!already) {
      const invitation = await prisma.invitation.findFirst({
        where: { organizationId: connection.organizationId, email, status: 'pending' },
        select: { id: true },
      });

      if (!invitation) {
        throw new SsoError(
          'This account is not a member of this workspace. Ask an administrator for an invitation.',
          'SSO_NOT_PROVISIONABLE',
          403,
        );
      }

      await prisma.member.create({
        data: {
          id: randomBytes(16).toString('hex'),
          organizationId: connection.organizationId,
          userId,
          role: provisionableRole(connection.defaultRole),
          createdAt: new Date(),
        },
      });

      await prisma.invitation.updateMany({
        where: { organizationId: connection.organizationId, email, status: 'pending' },
        data: { status: 'accepted' },
      });
    }
  }

  await recordAuditEvent({
    organizationId: connection.organizationId,
    actorUserId: userId,
    action: 'SSO_SIGN_IN',
    targetType: 'sso_connection',
    targetId: connection.id,
    detail: { emailDomain: domain, provisioned: created, providerSubject: identity.providerSubject },
    requestId,
  });

  return { organizationId: connection.organizationId, userId, created };
}

/**
 * Creates a session for a user the provider has just vouched for.
 *
 * Written straight to the session table rather than through Better Auth's
 * internal adapter, because that adapter's signature is not part of the
 * library's stable surface and would break on an upgrade. The session shape is
 * ours, in our own schema, and Better Auth reads it back by the cookie value
 * exactly as it would one it created itself.
 *
 * The cookie is `better-auth.session_token`, which is the name the library
 * derives from the plugin name, so the browser is signed in the same way as
 * after a password sign in.
 */
export const SESSION_COOKIE = 'better-auth.session_token';

export async function createSessionForUser(
  userId: string,
  context: { ipAddress?: string; userAgent?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 60 * 60 * 24 * 7 * 1000);

  await prisma.session.create({
    data: {
      id: randomBytes(16).toString('hex'),
      token,
      userId,
      expiresAt,
      updatedAt: new Date(),
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      createdAt: new Date(),
    },
  });

  return { token, expiresAt };
}

/* ---------------------------------------------------------------- OIDC ---- */

/**
 * The provider configuration, discovered from the issuer.
 *
 * Discovered rather than configured by hand, because the endpoints and signing
 * keys change and a stored copy is how a client ends up validating tokens
 * against a key the provider retired.
 */
async function oidcConfiguration(connection: NonNullable<Connection>) {
  if (!connection.issuer) {
    throw new SsoError('The connection has no issuer.', 'SSO_CONFIG_INVALID', 500);
  }

  const redirectUri = connection.entryPoint;

  const configuration = await discovery(
    new URL(connection.issuer),
    connection.clientId,
    { client_secret: requireSecret(connection), redirect_uris: [redirectUri] },
    ClientSecretPost(requireSecret(connection)),
  );

  return configuration;
}

/**
 * Where a connection's provider must send the user back to.
 *
 * Built from the configured application URL rather than the request's Host header.
 *
 * The previous implementation of this function returned the connection's
 * entryPoint, which is the provider's own discovery document, while its name and
 * comment promised the redirect target. Nothing called it, so it was harmless, and
 * wiring it up would have handed an administrator their IdP's URL to paste as a
 * callback, at which point sign-in would silently never complete.
 *
 * Two protocols, one answer, because an administrator configuring an IdP needs to
 * paste a value and cannot tell from the form which of the two applies.
 */
export function callbackUrlsFor(connectionId: string): { saml: string; oidc: string } {
  const base = env.APP_URL.replace(/\/+$/, '');
  return {
    saml: `${base}/api/sso/${connectionId}/saml/acs`,
    oidc: `${base}/api/sso/${connectionId}/callback`,
  };
}

/**
 * The identifiers an IdP configuration screen asks for.
 *
 * Without these the callback URL is not enough to finish the job: an IdP console
 * asks for the service provider's entity id and for a sign-in URL, and neither
 * can be derived from the callback. That is why SSO could be created through the
 * product and then not configured, because the one value an administrator
 * genuinely needs was never on screen.
 *
 * Our entity id is namespaced per connection so it survives a certificate
 * rotation, and so two connections never collide in one IdP.
 */
export function ssoIdentifiersFor(connection: { id: string; issuer: string; entryPoint: string }): {
  entityId: string;
  idpEntityId: string;
  loginUrl: string;
} {
  return {
    entityId: `${env.APP_URL.replace(/\/+$/, '')}/api/sso/${connection.id}`,
    idpEntityId: connection.issuer,
    loginUrl: connection.entryPoint,
  };
}

export async function beginOidcSignIn(connectionId: string): Promise<string> {
  const connection = await loadConnection(connectionId);
  if (connection.protocol !== 'OIDC') {
    throw new SsoError('This connection is not an OIDC connection.', 'SSO_PROTOCOL_MISMATCH', 400);
  }

  await purgeExpiredRequests();

  // PKCE plus a single use state. The state is what ties the callback to this
  // browser's request and makes a captured response unreplayable; PKCE means a
  // stolen authorisation code is useless without the verifier held server side.
  const state = randomState();
  const verifier = randomPKCECodeVerifier();
  const challenge = await calculatePKCECodeChallenge(verifier);

  await prisma.ssoAuthRequest.create({
    data: { nonce: state, connectionId, verifier },
  });

  const configuration = await oidcConfiguration(connection);

  return buildAuthorizationUrl(configuration, {
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
}

/**
 * Completes the code exchange and turns the verified identity into a member.
 *
 * The library validates the id token's signature against the provider's
 * published keys and the audience, and the state is checked before the code is
 * spent, so a response for another connection or another browser is refused
 * before any account is touched.
 */
export async function finishOidcSignIn(connectionId: string, currentUrl: URL): Promise<{ userId: string; organizationId: string; created: boolean }> {
  const connection = await loadConnection(connectionId);
  if (connection.protocol !== 'OIDC') {
    throw new SsoError('This connection is not an OIDC connection.', 'SSO_PROTOCOL_MISMATCH', 400);
  }

  const state = currentUrl.searchParams.get('state');
  if (!state) {
    throw new SsoError('This sign in request is not recognised.', 'SSO_STATE_INVALID', 400);
  }

  const pending = await prisma.ssoAuthRequest.findFirst({ where: { connectionId, nonce: state } });
  if (!pending) {
    throw new SsoError('This sign in request is not recognised.', 'SSO_STATE_INVALID', 400);
  }
  if (Date.now() - pending.createdAt.getTime() > requestTtlMs) {
    await prisma.ssoAuthRequest.delete({ where: { id: pending.id } }).catch(() => undefined);
    throw new SsoError('This sign in request has expired. Start again.', 'SSO_STATE_EXPIRED', 400);
  }
  // Single use, so a replayed response finds nothing and cannot mint a second
  // session.
  await prisma.ssoAuthRequest.delete({ where: { id: pending.id } }).catch(() => undefined);

  const configuration = await oidcConfiguration(connection);
  const tokens = await authorizationCodeGrant(configuration, currentUrl, {
    expectedState: state,
    // Nullable now that a SAML request shares this table, so it has to be proved
    // present rather than assumed. An OIDC row always has one.
    pkceCodeVerifier: pending.verifier ?? undefined,
  });

  const claims = tokens.claims();
  const email = typeof claims?.email === 'string' ? claims.email : null;
  if (!email) {
    throw new SsoError('The provider did not return an email address.', 'SSO_EMAIL_MISSING', 403);
  }

  return completeSignIn(connection, {
    email,
    name: typeof claims?.name === 'string' ? claims.name : undefined,
    providerSubject: typeof claims?.sub === 'string' ? claims.sub : '',
  });
}

/* --------------------------------------------------------------- SAML ---- */

/**
 * Where to send the browser to start a SAML sign in.
 *
 * `getAuthorizeUrlAsync` builds a full signed AuthnRequest rather than a bare
 * redirect, which matters because a provider that is configured to require a
 * signed request will refuse a plain URL.
 */
export async function samlEntryPoint(connectionId: string): Promise<string> {
  const connection = await loadConnection(connectionId);
  if (connection.protocol !== 'SAML') {
    throw new SsoError('This connection is not a SAML connection.', 'SSO_PROTOCOL_MISMATCH', 400);
  }

  await purgeExpiredRequests();

  /**
   * A single use RelayState, stored server side.
   *
   * `InResponseTo` proves the assertion answers a request we issued. It does not
   * prove the assertion came back through the browser we sent it to, because the
   * connection id in the ACS path is the only other thing checked and a cuid is
   * not a secret. So an attacker who captures one assertion can post it with a
   * RelayState of their own choosing and be accepted. A 256 bit value we minted,
   * stored, and delete on first use closes that half.
   *
   * It also gives the OIDC and SAML paths the same shape, which is why the OIDC
   * path was already safe and this one was not.
   */
  const relayState = randomBytes(32).toString('base64url');
  await prisma.ssoAuthRequest.create({
    data: { connectionId, relayState, createdAt: new Date() },
  });

  const samlInstance = buildSaml(connectionId, connection);
  return samlInstance.getAuthorizeUrlAsync(relayState, undefined, {});
}

// No host parameter. It used to carry the request's Host header into the ACS URL, which
// meant the value an administrator pasted into their IdP depended on which hostname
// they happened to be browsing and could be the internal name behind a proxy.
function buildSaml(connectionId: string, connection: NonNullable<Connection>) {
  return new saml.SAML({
    entryPoint: connection.entryPoint,
    issuer: `dmarcharbor-${connectionId}`,
    // Required by the library's types. An unsigned assertion is refused
    // below by wantAssertionsSigned, so a missing certificate fails closed.
    idpCert: connection.idpCertificate ?? '',
    // From configuration, not from the request. A Host header behind a proxy is
    // the internal name, and without one the old fallback produced
    // https://localhost/api/sso/..., which tells an IdP to send users nowhere.
    callbackUrl: callbackUrlsFor(connectionId).saml,
    wantAssertionsSigned: true,
    // A signed response alone is accepted as well as a signed assertion,
    // because some providers will only sign one of the two. At least one must
    // be signed or the assertion could be edited in flight.
    wantAuthnResponseSigned: true,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 5000,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    /**
     * Replay protection, and the reason this file changed.
     *
     * The library's default is `never`, which means the `InResponseTo` on the
     * incoming assertion is read out of the XML and then ignored. That attribute
     * is the only thing tying an assertion to the AuthnRequest that asked for it,
     * and without checking it a single captured assertion is a permanent
     * credential: it can be posted to the assertion consumer service again and
     * again, each time minting a fresh seven day session, until the assertion
     * expires.
     *
     * `always` refuses an assertion with no `InResponseTo` at all, which also
     * closes login CSRF: a response the provider never produced for a request we
     * made is refused before any account is touched.
     */
    validateInResponseTo: saml.ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: requestTtlMs,
    /** Durable, shared across instances, rather than the in-memory default. */
    cacheProvider: samlRequestCacheFor(connectionId),
  });
}

// No host parameter. The assertion consumer is configured from APP_URL rather than
// from whichever hostname the browser happened to arrive on.
export async function completeSamlSignIn(
  connectionId: string,
  encodedResponse: string,
  relayState: string | null,
): Promise<{ userId: string; organizationId: string; created: boolean }> {
  const connection = await loadConnection(connectionId);
  if (connection.protocol !== 'SAML') {
    throw new SsoError('This connection is not a SAML connection.', 'SSO_PROTOCOL_MISMATCH', 400);
  }

  /**
   * The RelayState is checked and consumed before the assertion is even parsed.
   *
   * Consuming it first means a replay loses here, having caused no work and no
   * session, rather than part way through the library's own validation. The
   * comparison against the path's connection id stops a RelayState minted for one
   * workspace being presented to another.
   */
  if (!relayState) {
    throw new SsoError('This sign in request is not recognised.', 'SSO_RELAY_STATE_INVALID', 400);
  }

  const pending = await prisma.ssoAuthRequest.findUnique({
    where: { relayState },
    select: { id: true, connectionId: true, createdAt: true },
  });

  if (!pending || pending.connectionId !== connectionId) {
    throw new SsoError('This sign in request is not recognised.', 'SSO_RELAY_STATE_INVALID', 400);
  }

  if (Date.now() - pending.createdAt.getTime() > requestTtlMs) {
    await prisma.ssoAuthRequest.deleteMany({ where: { id: pending.id } });
    throw new SsoError('This sign in request has expired. Start again.', 'SSO_RELAY_STATE_EXPIRED', 400);
  }

  await prisma.ssoAuthRequest.deleteMany({ where: { id: pending.id } });

  const samlInstance = buildSaml(connectionId, connection);

  /**
   * `InResponseTo` is verified inside this call, against the request ids this
   * connection issued and has not yet seen. A response for a request we never
   * made, or one already used, is refused before a session exists.
   */
  let profile: Awaited<ReturnType<typeof samlInstance.validatePostResponseAsync>>['profile'];
  try {
    ({ profile } = await samlInstance.validatePostResponseAsync({ SAMLResponse: encodedResponse }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown SAML validation error.';
    // The library's own wording for a response whose InResponseTo does not match
    // a request we issued. Reported as a distinct code because it is the answer
    // to "someone is replaying assertions at us", which is worth being able to
    // alert on.
    if (/InResponseTo/i.test(detail)) {
      throw new SsoError('That sign in response does not match any request we made.', 'SSO_IN_RESPONSE_TO_INVALID', 400);
    }
    throw new SsoError('The sign in response could not be verified.', 'SSO_RESPONSE_INVALID', 400);
  }

  const email = typeof profile?.email === 'string' ? profile.email : profile?.nameID;
  if (typeof email !== 'string' || !email.includes('@')) {
    throw new SsoError('The provider did not return an email address.', 'SSO_EMAIL_MISSING', 403);
  }

  // The in response To and the audience have already been checked by the
  // library, which is what stops a response captured from another workspace
  // being posted here.
  return completeSignIn(connection, {
    email,
    name: typeof profile?.displayName === 'string' ? profile.displayName : undefined,
    providerSubject: typeof profile?.nameID === 'string' ? profile.nameID : '',
  });
}

export { encryptSensitive, normalizeEmailDomain, randomBytes, createHash };
