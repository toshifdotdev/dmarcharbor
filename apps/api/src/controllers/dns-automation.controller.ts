import type { Request, Response } from 'express';
import { z } from 'zod';
import { resourceIdSchema } from '../models/client.model.js';
import { getDomain } from '../services/client.service.js';
import { DnsAutomationError } from '../services/dns-automation/cloudflare.client.js';
import {
  createDnsConnection,
  deleteDnsConnection,
  DnsConnectionError,
  listDnsConnections,
} from '../services/dns-automation/connections.service.js';
import {
  DnsPublishError,
  previewDnsPublication,
  publishDnsRecord,
  restoreDnsPublication,
} from '../services/dns-automation/publish.service.js';

const recordSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('verification') }),
  z.object({ kind: z.literal('dmarc_suggested') }),
  z.object({
    kind: z.literal('dmarc_policy'),
    policy: z.enum(['none', 'quarantine', 'reject']),
    testing: z.boolean().optional().default(false),
    np: z.enum(['none', 'quarantine', 'reject']).nullable().optional(),
    pct: z
      .unknown()
      .optional()
      .refine((value) => value === undefined, {
        message: 'pct was retired by RFC 9989. Use testing=true for testing mode (t=y).',
      }),
  }),
  z.object({ kind: z.literal('switch_dual') }),
  z.object({ kind: z.literal('switch_cutover') }),
]);

const previewSchema = z.object({
  connectionId: z.string().trim().min(1).max(64),
  record: recordSchema,
});

const publishSchema = previewSchema.extend({
  expectedFingerprint: z.string().trim().regex(/^[a-f0-9]{64}$/i),
});

const connectionSchema = z.object({
  provider: z.literal('CLOUDFLARE'),
  token: z.string().trim().min(1).max(500),
  label: z.string().trim().max(80).optional().nullable(),
});

function organizationId(request: Request): string {
  return request.params.organizationId as string;
}

function domainId(request: Request): string | null {
  const parsed = resourceIdSchema.safeParse(request.params.domainId);
  return parsed.success ? parsed.data : null;
}

function sendError(response: Response, error: unknown): void {
  if (error instanceof DnsConnectionError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof DnsAutomationError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof DnsPublishError) {
    const { preview, ...details } = error.details ?? {};
    response.status(error.status).json({
      error: { code: error.code, message: error.message, ...details },
      ...(preview ? { preview } : {}),
    });
    return;
  }
  response.status(500).json({ error: { code: 'INTERNAL', message: 'The DNS change could not be completed.' } });
}

export async function listDnsConnectionsController(request: Request, response: Response): Promise<void> {
  try {
    response.json({ connections: await listDnsConnections(organizationId(request)) });
  } catch (error) {
    sendError(response, error);
  }
}

export async function createDnsConnectionController(request: Request, response: Response): Promise<void> {
  const parsed = connectionSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Send provider CLOUDFLARE and a Cloudflare API Token.',
      },
    });
    return;
  }

  try {
    const connection = await createDnsConnection({
      organizationId: organizationId(request),
      token: parsed.data.token,
      label: parsed.data.label ?? null,
      actorUserId: response.locals.session?.user?.id,
    });
    response.status(201).json(connection);
  } catch (error) {
    sendError(response, error);
  }
}

export async function deleteDnsConnectionController(request: Request, response: Response): Promise<void> {
  const connectionId = resourceIdSchema.safeParse(request.params.connectionId);
  if (!connectionId.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid connection identifier is required.' } });
    return;
  }

  try {
    await deleteDnsConnection({
      organizationId: organizationId(request),
      connectionId: connectionId.data,
      actorUserId: response.locals.session?.user?.id,
    });
    response.status(204).send();
  } catch (error) {
    sendError(response, error);
  }
}

async function domainFor(request: Request, response: Response) {
  const id = domainId(request);
  if (!id) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid domain identifier is required.' } });
    return null;
  }

  const domain = await getDomain(organizationId(request), id);
  if (!domain) {
    response.status(404).json({ error: { code: 'DOMAIN_NOT_FOUND', message: 'Domain not found in this workspace.' } });
    return null;
  }

  return domain;
}

export async function previewDnsController(request: Request, response: Response): Promise<void> {
  const parsed = previewSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Choose a connection and one of the records this service generates.',
      },
    });
    return;
  }

  const domain = await domainFor(request, response);
  if (!domain) return;

  try {
    response.json(
      await previewDnsPublication({
        organizationId: organizationId(request),
        domain,
        connectionId: parsed.data.connectionId,
        record: parsed.data.record,
      }),
    );
  } catch (error) {
    sendError(response, error);
  }
}

export async function publishDnsController(request: Request, response: Response): Promise<void> {
  const parsed = publishSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Choose a connection, a generated record and the fingerprint from its preview.',
      },
    });
    return;
  }

  const domain = await domainFor(request, response);
  if (!domain) return;

  try {
    response.json(
      await publishDnsRecord({
        organizationId: organizationId(request),
        domain,
        connectionId: parsed.data.connectionId,
        record: parsed.data.record,
        expectedFingerprint: parsed.data.expectedFingerprint,
        actorUserId: response.locals.session?.user?.id,
      }),
    );
  } catch (error) {
    sendError(response, error);
  }
}

export async function restoreDnsController(request: Request, response: Response): Promise<void> {
  const publicationId = resourceIdSchema.safeParse(request.params.publicationId);
  if (!publicationId.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid publication identifier is required.' } });
    return;
  }

  try {
    response.json(
      await restoreDnsPublication({
        organizationId: organizationId(request),
        publicationId: publicationId.data,
        actorUserId: response.locals.session?.user?.id,
      }),
    );
  } catch (error) {
    sendError(response, error);
  }
}
