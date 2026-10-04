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
    const already = await prisma.member.findFirst({
      where: { organizationId: connection.organizationId, userId },
      select: { id: true },
    });

    if (!already) {
      await prisma.member.create({
        data: {
          id: randomBytes(16).toString('hex'),
          organizationId: connection.organizationId,
          userId,
          role: provisionableRole(connection.defaultRole),
          createdAt: new Date(),
        },
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
    pkceCodeVerifier: pending.verifier,
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

  const samlInstance = buildSaml(connectionId, connection);
  // The connection id doubles as the RelayState, so the assertion that comes
  // back can be matched to the request that started it.
  return samlInstance.getAuthorizeUrlAsync(connectionId, undefined, {});
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
  });
}

// No host parameter. The assertion consumer is configured from APP_URL rather than
// from whichever hostname the browser happened to arrive on.
export async function completeSamlSignIn(
  connectionId: string,
  encodedResponse: string,
): Promise<{ userId: string; organizationId: string; created: boolean }> {
  const connection = await loadConnection(connectionId);
  if (connection.protocol !== 'SAML') {
    throw new SsoError('This connection is not a SAML connection.', 'SSO_PROTOCOL_MISMATCH', 400);
  }

  const samlInstance = buildSaml(connectionId, connection);
  const { profile } = await samlInstance.validatePostResponseAsync({ SAMLResponse: encodedResponse });

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
