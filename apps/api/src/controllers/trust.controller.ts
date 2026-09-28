import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { EntitlementError } from '../services/entitlements/entitlement.service.js';
import {
  TrustCenterError,
  buildTrustCenter,
  ensureTrustSlug,
  revokeTrustSlug,
  trustSlugStatus,
} from '../services/trust/trust-center.service.js';

function sendError(response: Response, error: unknown): void {
  if (error instanceof TrustCenterError || error instanceof EntitlementError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  response.status(500).json({ error: { code: 'INTERNAL', message: 'The Trust Center could not be read.' } });
}

/**
 * The public Trust Center.
 *
 * No authentication, and deliberately so: the recipient is an auditor at the
 * client's organisation who has never heard of this product and will not create
 * an account. The unguessable slug is the only thing protecting it, and rotating
 * the slug withdraws the link immediately.
 *
 * Served with a short cache lifetime so a CDN can absorb traffic, because this
 * is the one endpoint a procurement team may open from several offices.
 */
export async function publicTrustCenterController(request: Request, response: Response): Promise<void> {
  const slug = typeof request.params.slug === 'string' ? request.params.slug : '';

  try {
    const payload = await buildTrustCenter(slug);

    response.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
    response.setHeader('X-Robots-Tag', 'noindex');
    response.json(payload);
  } catch (error) {
    // A missing and a withdrawn slug produce the same answer, so the endpoint
    // cannot be used to discover that a client ever had one.
    if (error instanceof TrustCenterError && error.code === 'TRUST_CENTER_NOT_FOUND') {
      response.setHeader('Cache-Control', 'no-store');
      response.status(404).json({ error: { code: 'TRUST_CENTER_NOT_FOUND', message: 'No Trust Center at this address.' } });
      return;
    }
    sendError(response, error);
  }
}

/** Creates the link, or returns the existing one. */
export async function createTrustCenterController(request: Request, response: Response): Promise<void> {
  const clientId = typeof request.params.clientId === 'string' ? request.params.clientId : '';
  const organizationId = response.locals.organizationId as string;

  try {
    const client = await assertClientInWorkspace(clientId, organizationId);

    const slug = await ensureTrustSlug(client.id, response.locals.session?.user?.id);
    response.status(200).json({ url: `${env.BETTER_AUTH_URL.replace(/\/$/, '')}/trust/${slug}`, slug });
  } catch (error) {
    sendError(response, error);
  }
}

/** Withdraws the link. An agency that stops working with a client pulls the page. */
export async function revokeTrustCenterController(request: Request, response: Response): Promise<void> {
  const clientId = typeof request.params.clientId === 'string' ? request.params.clientId : '';
  const organizationId = response.locals.organizationId as string;

  try {
    const client = await assertClientInWorkspace(clientId, organizationId);
    await revokeTrustSlug(client.id, response.locals.session?.user?.id);
    response.json({ status: 'revoked' });
  } catch (error) {
    sendError(response, error);
  }
}

export async function trustCenterStatusController(request: Request, response: Response): Promise<void> {
  const clientId = typeof request.params.clientId === 'string' ? request.params.clientId : '';
  const organizationId = response.locals.organizationId as string;

  try {
    const client = await assertClientInWorkspace(clientId, organizationId);
    response.json(await trustSlugStatus(client.id));
  } catch (error) {
    sendError(response, error);
  }
}

/**
 * Confirms the client belongs to the caller's workspace before anything is
 * written. The workspace id is used only to prove ownership, never to scope the
 * write, so a client id from another agency cannot have its link overwritten.
 */
async function assertClientInWorkspace(clientId: string, organizationId: string) {
  const { prisma } = await import('../database/prisma.js');
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, organizationId: true },
  });

  if (!client || client.organizationId !== organizationId) {
    throw new TrustCenterError('That client is not in this workspace.', 'CLIENT_NOT_FOUND', 404);
  }

  return client;
}
