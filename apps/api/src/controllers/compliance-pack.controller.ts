import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { EntitlementError } from '../services/entitlements/entitlement.service.js';
import { CompliancePackError, TrustCenterError, issueCompliancePack, listCompliancePacks } from '../services/trust/compliance-pack.service.js';

function sendError(response: Response, error: unknown): void {
  if (error instanceof CompliancePackError || error instanceof TrustCenterError || error instanceof EntitlementError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  response.status(500).json({ error: { code: 'INTERNAL', message: 'The compliance pack could not be produced.' } });
}

/**
 * Issues the pack and streams the PDF.
 *
 * The response carries both the file and its digest, so the client can be told
 * the value without a second round trip. The bytes streamed are the exact bytes
 * that were hashed, which is the property the whole scheme rests on.
 */
export async function createCompliancePackController(request: Request, response: Response): Promise<void> {
  const clientId = typeof request.params.clientId === 'string' ? request.params.clientId : '';
  const organizationId = response.locals.organizationId as string;

  try {
    const client = await assertClientInWorkspace(clientId, organizationId);

    const issued = await issueCompliancePack({
      clientId: client.id,
      organizationId,
      actorUserId: response.locals.session?.user?.id,
    });

    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Length', String(issued.buffer.length));
    response.setHeader('Content-Disposition', `attachment; filename="dmarc-compliance-${issued.id}.pdf"`);
    // The digest travels with the file so a reader never has to ask for it.
    response.setHeader('X-DMARC-Pack-Sha256', issued.hash);
    response.setHeader('X-DMARC-Pack-Reference', issued.id);
    response.setHeader('Cache-Control', 'no-store');

    response.status(200).end(issued.buffer);
  } catch (error) {
    sendError(response, error);
  }
}

export async function listCompliancePacksController(request: Request, response: Response): Promise<void> {
  const clientId = typeof request.params.clientId === 'string' ? request.params.clientId : '';
  const organizationId = response.locals.organizationId as string;

  try {
    const client = await assertClientInWorkspace(clientId, organizationId);
    response.json({ packs: await listCompliancePacks(client.id) });
  } catch (error) {
    sendError(response, error);
  }
}

/**
 * Public digest lookup, by document reference.
 *
 * This is what makes the scheme verifiable by somebody who has never heard of
 * us: they hash the file they were given and compare it with what we publish
 * here. Only the digest and the dates are returned, never the document.
 */
export async function verifyCompliancePackController(request: Request, response: Response): Promise<void> {
  const reference = typeof request.query.reference === 'string' ? request.query.reference : '';

  try {
    const rows = await prisma.compliancePack.findMany({
      where: { id: reference },
      select: {
        pdfHash: true,
        byteSize: true,
        pageCount: true,
        asOf: true,
        createdAt: true,
        supersededAt: true,
        documentVersion: true,
        organizationId: true,
      },
      take: 5,
    });

    // Nothing found is a 404, and the answer is otherwise purely about a
    // fingerprint. No client name, no domain, no personal data.
    response.status(rows.length > 0 ? 200 : 404).json({
      found: rows.length > 0,
      packs: rows.map((row) => ({
        reference: reference,
        sha256: row.pdfHash,
        byteSize: row.byteSize,
        pageCount: row.pageCount,
        documentVersion: row.documentVersion,
        dataAsOf: row.asOf.toISOString(),
        issuedAt: row.createdAt.toISOString(),
        superseded: row.supersededAt !== null,
      })),
      howToVerify:
        'Compute the SHA-256 digest of the downloaded file and compare it with sha256 above. A match means the file has not been altered since it was issued.',
      limitations:
        'This is a self attestation. It proves the document is unaltered, not that the provider is trustworthy, and it is not a third party audit.',
      trustCenter: `${env.BETTER_AUTH_URL.replace(/\/$/, '')}/trust`,
    });
  } catch (error) {
    sendError(response, error);
  }
}

async function assertClientInWorkspace(clientId: string, organizationId: string) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, organizationId: true },
  });

  if (!client || client.organizationId !== organizationId) {
    throw new TrustCenterError('That client is not in this workspace.', 'CLIENT_NOT_FOUND', 404);
  }

  return client;
}
