import type { Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { prisma } from '../database/prisma.js';
import { env } from '../config/env.js';
import { auth } from '../auth/auth.config.js';
import { recordAuditEvent } from '../services/audit.service.js';
import {
  SsoError,
  createSsoConnection,
  deleteSsoConnection,
  listSsoConnections,
  updateSsoConnection,
} from '../services/sso/sso.service.js';
import { zodMessage } from '../utils/zod-messages.js';
import { assertFeature, resolveEntitlements } from '../services/entitlements/entitlement.service.js';
import { ssoSignInUntil, syncSsoLicence } from '../services/entitlements/plan-change-effects.js';
import {
  beginOidcSignIn,
  completeSamlSignIn,
  createSessionForUser,
  finishOidcSignIn,
  samlEntryPoint,
  ssoSessionCookie,
} from '../services/sso/sso-flow.service.js';

/**
 * Workspace single sign on.
 *
 * Two surfaces, deliberately separated.
 *
 * The settings endpoints are the agency managing their own identity provider and
 * need a session, workspace permission and the entitlement. The sign in endpoints
 * are the opposite: an unauthenticated browser arriving back from the customer's
 * IdP, so they take no session at all and are reachable only by someone who
 * already knows a connection id and has just come from the provider. That is why
 * the same file holds both: the boundary between the two is the whole security
 * story, and keeping them adjacent makes it reviewable.
 */

const createSchema = z.object({
  label: z.string().trim().min(1).max(120),
  protocol: z.enum(['SAML', 'OIDC']),
  issuer: z
    .string()
    .trim()
    .max(500)
    // An absolute https URL, and nothing else.
    //
    // `min(1)` accepted any non-empty string, so `https://` and `not-a-url` were
    // both stored. The value is later passed to `new URL(...)` and, for OIDC,
    // fetched - so an arbitrary string either throws at first sign-in or, for
    // anything the URL parser happens to accept, silently points discovery
    // somewhere nobody chose.
    //
    // Refining here rather than at the call site keeps the rule at the boundary,
    // where every other field's rule already lives.
    //
    // A URN is also accepted here, and only for SAML (checked with the
    // protocol below): a SAML entity id is a URI, and Auth0's is
    // `urn:<tenant>.auth0.com`, which the https-only rule refused (session 14).
    .refine((value) => isHttpsUrl(value) || isUrn(value), {
      message: "The issuer must be an absolute https URL, for example https://accounts.example.com.",
    }),
  entryPoint: z.string().trim().url(),
  // Required for OIDC, below. SAML has neither: the form asked a SAML
  // administrator for a client secret their provider never gave them
  // (session 14).
  clientId: z.string().trim().max(300).default(''),
  clientSecret: z.string().max(1000).default(''),
  idpCertificate: z.string().trim().max(8000).optional(),
  tokenEndpoint: z.string().trim().url().optional(),
  userinfoEndpoint: z.string().trim().url().optional(),
  provisioning: z.enum(['JIT', 'DISABLED']).default('JIT'),
  allowedEmailDomains: z.array(z.string().trim().min(1).max(255)).max(50).default([]),
  defaultRole: z.enum(['analyst', 'viewer', 'admin']).default('analyst'),
});

function fail(response: Response, error: unknown): void {
  if (error instanceof SsoError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  response.status(500).json({ error: { code: 'SSO_ERROR', message: 'Single sign on is not configured correctly.' } });
}

/**
 * A refusal on the two addresses a browser lands on (start and callback).
 *
 * Answered as JSON, the person refused saw `{"error":{"code":
 * "SSO_DOMAIN_NOT_PERMITTED",...}}` on a blank page straight after their
 * provider's login (session 14). They go to the sign-in page instead, which
 * says in words what happened (web lib/sign-in-errors.ts reads `sso_*`). The
 * code is ours, never free text, so nothing from the provider reaches the URL.
 */
function failToSignIn(response: Response, error: unknown): void {
  const code = error instanceof SsoError ? error.code : 'SSO_ERROR';
  if (!(error instanceof SsoError)) {
    console.error(`[sso] sign-in failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  // 303: the browser fetches the sign-in page with GET, after a POSTed
  // assertion too. Never 302, which is what the start answers when it sends
  // someone on to their provider.
  response.redirect(303, `/sign-in?error=${encodeURIComponent(code.toLowerCase())}`);
}

/**
 * A `urn:` identifier, the other shape a SAML entity id takes. Never fetched.
 * Looser than RFC 8141 on purpose: Auth0's `urn:<tenant>.us.auth0.com` has no
 * second colon, and it is what that provider puts in every assertion.
 */
function isUrn(value: string): boolean {
  return /^urn:[^\s]{3,}$/i.test(value);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * True when an OIDC issuer must be a bare base URL.
 *
 * SAML entity ids conventionally carry a path, so a rule that refused paths
 * would refuse every ordinary Okta configuration. The rule only applies to the
 * protocol whose discovery document is fetched by appending to this URL.
 */
export function isBareOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ["/", ""].includes(parsed.pathname);
  } catch {
    return false;
  }
}

export async function listSsoConnectionsController(_request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const licensed = (await resolveEntitlements(organizationId)).features['auth.sso'] === true;
  const connections = await listSsoConnections(organizationId);

  if (!licensed && connections.length === 0) {
    // Nothing kept from a previous plan: the ordinary "not on this plan" answer.
    await assertFeature(organizationId, 'auth.sso');
  }

  // A kept connection on a plan without SSO is paused: existing members can use
  // it until `signInUntil`, nobody new joins, and it can only be removed.
  const since = await syncSsoLicence(organizationId, licensed);
  const signInUntil = !licensed && since ? ssoSignInUntil(since).toISOString() : null;
  response.json({
    connections: connections.map((connection) => ({ ...connection, paused: !licensed, signInUntil })),
  });
}

/**
 * The caller's own workspace, or none.
 *
 * Reads the session rather than requiring one, because `ssoStartController`
 * serves users who have just been sent here by their identity provider and have
 * no session yet. Using the session when it exists narrows that endpoint without
 * locking out the person it is really for.
 */
async function callerOrganizationId(headers: NodeJS.Dict<string | string[] | undefined>): Promise<string | undefined> {
  /**
   * No session means no scope, not an error.
   *
   * `listOrganizations` throws UNAUTHORIZED without a session, and that reached
   * the catch-all as 500 "Single sign on is not configured correctly", so
   * signing in through SSO failed for exactly the person it is for: someone not
   * signed in yet (session 14).
   */
  let organizations: Array<{ id: string }>;
  try {
    organizations = await auth.api.listOrganizations({ headers: fromNodeHeaders(headers) });
  } catch {
    return undefined;
  }

  // Only a member of exactly one workspace can be scoped by their session. A
  // person holding two cannot have "the" organization derived from the session
  // alone, and guessing one would refuse a legitimate sign-in for a reason the
  // caller cannot see or act on.
  return organizations.length === 1 ? organizations[0]?.id : undefined;
}

export async function createSsoConnectionController(request: Request, response: Response): Promise<void> {
  const body = createSchema.safeParse(request.body);
  if (!body.success) {
    // The refinement's own message is returned rather than a generic one. A
    // connection that cannot be created has to say why in the words the
    // administrator will read while filling the form in, and "the details are not
    // usable" sends them back to a field that was already fine.
    //
    // `zodMessage` keeps that behaviour: a `custom` issue carries the author's
    // own sentence and is passed through, while a built-in constraint (a URL
    // that is not a URL, a string that is too short) is restated in words rather
    // than Zod's own generator text. Both shapes reached this response before,
    // so the form showed "String must contain at least 1 character(s)" next to
    // a field the administrator had filled in correctly.
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: zodMessage(body.error.issues) ?? 'The connection details are not usable.',
      },
    });
    return;
  }

  /**
   * An OIDC issuer is a discovery base URL, so it must not carry a path.
   *
   * The document is fetched by trimming a trailing slash and appending
   * `/.well-known/openid-configuration`, and a base URL carrying a path relocates
   * that request to a subdirectory of wherever the administrator happened to
   * point. SAML is deliberately exempt: a SAML entity id conventionally *is* a
   * path, and this check would refuse an ordinary Okta configuration.
   *
   * Checked here rather than in the schema because the two fields have to be read
   * together, which a per-field zod refine cannot see.
   */
  // An OIDC issuer is fetched, so it has to be https; a URN is a SAML shape.
  if (body.data.protocol === 'OIDC' && !isHttpsUrl(body.data.issuer)) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'The OIDC issuer must be an absolute https URL, for example https://accounts.example.com.',
      },
    });
    return;
  }

  if (body.data.protocol === 'OIDC' && (!body.data.clientId || !body.data.clientSecret)) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'OIDC needs the client ID and client secret your provider gave this application.' },
    });
    return;
  }

  // Checked here rather than at the first sign-in, where a missing certificate
  // fails closed with "the sign in response could not be verified".
  if (body.data.protocol === 'SAML' && !/-----BEGIN CERTIFICATE-----/.test(body.data.idpCertificate ?? '')) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: "SAML needs your provider's signing certificate, the PEM text that starts -----BEGIN CERTIFICATE-----.",
      },
    });
    return;
  }

  if (body.data.protocol === 'OIDC' && !isBareOrigin(body.data.issuer)) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message:
          'The OIDC issuer must be your provider base URL with no path, for example https://accounts.example.com.',
      },
    });
    return;
  }

  const organizationId = response.locals.organizationId;

  try {
    const created = await createSsoConnection({ organizationId, ...body.data });

    // A connection is a standing door into the workspace, so who opened it and
    // which provider it trusts are both things a reviewer will ask for later.
    await recordAuditEvent({
      organizationId,
      actorUserId: response.locals.session?.user?.id,
      action: 'SSO_CONNECTION_CREATED',
      targetType: 'sso_connection',
      targetId: created.id,
      detail: { label: body.data.label, protocol: body.data.protocol, domains: body.data.allowedEmailDomains },
    });

    response.status(201).json({ id: created.id });
  } catch (error) {
    fail(response, error);
  }
}

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    label: z.string().trim().min(1).max(120).optional(),
    allowedEmailDomains: z.array(z.string().trim().min(1).max(255)).max(50).optional(),
    provisioning: z.enum(['JIT', 'DISABLED']).optional(),
    defaultRole: z.enum(['analyst', 'viewer', 'admin']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Send at least one field to change.' });

/**
 * PATCH a connection. The identity provider details are not editable here (see
 * `updateSsoConnection`); an unknown field is refused rather than ignored, so a
 * request that tries to change the issuer is told it cannot.
 */
export async function updateSsoConnectionController(request: Request, response: Response): Promise<void> {
  const body = updateSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message:
          zodMessage(body.error.issues) ??
          'Only enabled, label, allowedEmailDomains, provisioning and defaultRole can be changed. To change the provider, add a new connection.',
      },
    });
    return;
  }

  const organizationId = response.locals.organizationId;
  const connectionId = request.params.connectionId as string;

  try {
    const { before, after } = await updateSsoConnection(organizationId, connectionId, body.data);
    const changed = Object.fromEntries(
      (Object.keys(body.data) as Array<keyof typeof body.data>).map((key) => [
        key,
        { from: before[key as keyof typeof before] ?? null, to: after[key as keyof typeof after] ?? null },
      ]),
    );
    await recordAuditEvent({
      organizationId,
      actorUserId: response.locals.session?.user?.id,
      action: 'SSO_CONNECTION_UPDATED',
      targetType: 'sso_connection',
      targetId: connectionId,
      detail: { label: after.label, changed },
    });
    response.json(after);
  } catch (error) {
    fail(response, error);
  }
}

export async function deleteSsoConnectionController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const connectionId = request.params.connectionId as string;

  try {
    await deleteSsoConnection(organizationId, connectionId);
  } catch (error) {
    fail(response, error);
    return;
  }

  await recordAuditEvent({
    organizationId,
    actorUserId: response.locals.session?.user?.id,
    action: 'SSO_CONNECTION_REMOVED',
    targetType: 'sso_connection',
    targetId: connectionId,
  });

  response.status(204).end();
}

/** Everything a user needs to sign in through a named connection, and nothing more. */
async function describeConnection(connectionId: string, organizationId?: string) {
  const connection = await prisma.ssoConnection.findFirst({
    // Scoped to the workspace when the caller has one, so a member of one tenant
    // cannot read another's connection details. Unscoped where a browser reaches
    // this directly, which is what `ssoInfoController` serves.
    where: { id: connectionId, enabled: true, ...(organizationId ? { organizationId } : {}) },
    select: { id: true, label: true, protocol: true, organization: { select: { name: true } } },
  });

  if (!connection) {
    // The same answer for an id that does not exist and one that belongs to a
    // workspace the caller knows nothing about, so this cannot be used to
    // discover which connections exist.
    throw new SsoError('No such single sign on connection.', 'SSO_NOT_FOUND', 404);
  }

  return { id: connection.id, label: connection.label, protocol: connection.protocol, organization: connection.organization.name };
}

/* ------------------------------------------------------- sign in (public) -- */

export async function ssoStartController(request: Request, response: Response): Promise<void> {
  const connectionId = request.params.connectionId as string;

  try {
    /**
     * Scoped to the caller's session when one is present, but never required.
     *
     * The endpoint is reached directly by a browser a provider has just
     * redirected, so it cannot use `requireSession`: the session is a legitimate
     * reason to be here and its absence is not. What it can do is use a session
     * when there is one, so a member of one workspace who is signed in and pokes
     * at another's connection id is refused rather than redirected to that
     * provider. The resolution check in `oidcConfiguration` is what bounds the
     * remainder.
     */
    const organizationId = await callerOrganizationId(request.headers);
    const connection = await describeConnection(connectionId, organizationId);
    const url = connection.protocol === 'OIDC'
      ? await beginOidcSignIn(connectionId, organizationId)
      : await samlEntryPoint(connectionId, organizationId);

    response.redirect(url);
  } catch (error) {
    failToSignIn(response, error);
  }
}

export async function ssoCallbackController(request: Request, response: Response): Promise<void> {
  const connectionId = request.params.connectionId as string;

  try {
    /**
     * RelayState is required and consumed on first use.
     *
     * It used to be ignored entirely and the connection id doubled as its value,
     * which is public in the URL, so there was nothing binding an incoming
     * assertion to the browser that started the sign in.
     */
    const body = (request.body ?? {}) as { SAMLResponse?: unknown; RelayState?: unknown };

    const result =
      request.method === 'POST'
        ? await completeSamlSignIn(
            connectionId,
            String(body.SAMLResponse ?? ''),
            typeof body.RelayState === 'string' ? body.RelayState : null,
          )
        : await finishOidcSignIn(connectionId, new URL(request.originalUrl, env.APP_URL));

    const { token, expiresAt } = await createSessionForUser(result.userId, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
    });

    // Signed the way Better Auth reads it back, so getSession recognises the
    // browser exactly as it would after a password sign in.
    const cookie = await ssoSessionCookie(token, expiresAt);
    response.cookie(cookie.name, cookie.value, cookie.options);

    // The workspace's own front page. Everyone who signs in through a
    // connection is a member of that workspace (staff, never a client
    // contact), and /portal told them "no report has been shared with that
    // address" (session 14). On an agency's own domain, / goes to the portal.
    response.redirect('/');
  } catch (error) {
    failToSignIn(response, error);
  }
}

/** Lets a sign in page show the workspace and connection before redirecting. */
export async function ssoInfoController(request: Request, response: Response): Promise<void> {
  try {
    response.json(await describeConnection(request.params.connectionId as string));
  } catch (error) {
    fail(response, error);
  }
}
