import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../database/prisma.js';
import { env } from '../config/env.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { SsoError, createSsoConnection, deleteSsoConnection, listSsoConnections } from '../services/sso/sso.service.js';
import {
  SESSION_COOKIE,
  beginOidcSignIn,
  completeSamlSignIn,
  createSessionForUser,
  finishOidcSignIn,
  samlEntryPoint,
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
  issuer: z.string().trim().min(1).max(500),
  entryPoint: z.string().trim().url(),
  clientId: z.string().trim().min(1).max(300),
  clientSecret: z.string().min(1).max(1000),
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

export async function listSsoConnectionsController(_request: Request, response: Response): Promise<void> {
  response.json({ connections: await listSsoConnections(response.locals.organizationId) });
}

export async function createSsoConnectionController(request: Request, response: Response): Promise<void> {
  const body = createSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'The connection details are not usable.' } });
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
async function describeConnection(connectionId: string) {
  const connection = await prisma.ssoConnection.findFirst({
    where: { id: connectionId, enabled: true },
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
    const connection = await describeConnection(connectionId);
    const url = connection.protocol === 'OIDC'
      ? await beginOidcSignIn(connectionId)
      : await samlEntryPoint(connectionId);

    response.redirect(url);
  } catch (error) {
    fail(response, error);
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

    // Signed in the same way as after a password sign in, so the rest of the
    // product cannot tell the difference and needs no special case.
    response.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: request.secure,
      path: '/',
      expires: expiresAt,
    });

    response.redirect('/portal');
  } catch (error) {
    fail(response, error);
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
