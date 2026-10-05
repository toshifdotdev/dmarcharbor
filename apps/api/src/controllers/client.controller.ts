import type { Request, Response } from 'express';
import { DomainValidationError } from '../scanner/domain.js';
import { createClientSchema, createDomainSchema, resourceIdSchema } from '../models/client.model.js';
import {
  createClient,
  createDomain,
  DomainNameTakenError,
  listClients,
  listDomains,
  verifyDomain,
} from '../services/client.service.js';

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export async function listClientsController(_request: Request, response: Response): Promise<void> {
  const clients = await listClients(response.locals.organizationId);
  response.json(clients);
}

export async function createClientController(request: Request, response: Response): Promise<void> {
  const parsed = createClientSchema.safeParse(request.body);

  if (!parsed.success) {
    response.status(400).json({ error: { message: 'Enter a valid client name and slug.' } });
    return;
  }

  try {
    const client = await createClient(response.locals.organizationId, parsed.data);
    response.status(201).json(client);
  } catch (error) {
    if (isUniqueConstraint(error)) {
      response.status(409).json({ error: { message: 'That client slug is already in this workspace.' } });
      return;
    }
    throw error;
  }
}

export async function listDomainsController(request: Request, response: Response): Promise<void> {
  const clientId = resourceIdSchema.safeParse(request.params.clientId);
  if (!clientId.success) {
    response.status(400).json({ error: { message: 'A valid client identifier is required.' } });
    return;
  }
  const domains = await listDomains(response.locals.organizationId, clientId.data);
  response.json(domains);
}

export async function createDomainController(request: Request, response: Response): Promise<void> {
  const clientId = resourceIdSchema.safeParse(request.params.clientId);
  const parsed = createDomainSchema.safeParse(request.body);

  if (!clientId.success || !parsed.success) {
    response.status(400).json({ error: { message: 'Enter a valid client and domain.' } });
    return;
  }

  try {
    const outcome = await createDomain(response.locals.organizationId, clientId.data, parsed.data);

    if (!outcome) {
      response.status(404).json({ error: { message: 'Client not found in this workspace.' } });
      return;
    }

    /**
     * 200 rather than 201 when nothing was created.
     *
     * Re-adding a name the client already holds returns that domain rather than
     * making a second one, because two rows for one name used to be what silently
     * blinded report routing. Answering "Created" for a row that already existed
     * would be a small lie on a route whose whole job is to be truthful about
     * uniqueness.
     */
    response.status(outcome.created ? 201 : 200).json(outcome.domain);
  } catch (error) {
    if (error instanceof DomainValidationError) {
      response.status(400).json({ error: { message: error.message } });
      return;
    }
    if (error instanceof DomainNameTakenError) {
      response.status(409).json({
        error: { message: error.message, code: error.code, domain: error.domainName },
      });
      return;
    }

    if (isUniqueConstraint(error)) {
      response.status(409).json({ error: { message: 'That domain is already attached to this client.' } });
      return;
    }
    throw error;
  }
}

export async function verifyDomainController(request: Request, response: Response): Promise<void> {
  const domainId = resourceIdSchema.safeParse(request.params.domainId);

  if (!domainId.success) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }

  const result = await verifyDomain(response.locals.organizationId, domainId.data);

  if (!result) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  response.json(result);
}
