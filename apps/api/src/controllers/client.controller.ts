import type { Request, Response } from 'express';
import { DomainValidationError } from '../scanner/domain.js';
import { createClientSchema, createDomainSchema, resourceIdSchema } from '../models/client.model.js';
import { bulkDomainsSchema } from '../models/api.model.js';
import { bulkImportDomains, bulkLimits } from '../services/bulk-onboarding.service.js';
import { EntitlementError } from '../services/entitlements/entitlement.service.js';
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

/**
 * Adds many domains to a client in one request, and answers per row.
 *
 * This is the session-authenticated twin of `POST /api/v1/domains/bulk`. The
 * public endpoint exists and works, but it authenticates with a bearer API key,
 * which a browser signed in with a cookie cannot present. So the console could
 * not use the feature it already had, and onboarding an agency that sent eighty
 * domains meant calling the API by hand.
 *
 * The response shape is deliberately the one the API-key endpoint already
 * returns, so the screen this enables shows an integration what it would see,
 * and there is one set of per-row verdicts rather than two.
 *
 * `created` / `failed` / `planBlocked` stay separate on purpose: a duplicate the
 * operator can fix, and a row the plan will not allow, are different problems
 * and one screen should not flatten them into a single error count.
 */
export async function bulkCreateDomainsController(request: Request, response: Response): Promise<void> {
  const clientId = resourceIdSchema.safeParse(request.params.clientId);
  // The client is taken from the path, not the body. A second `clientId` in the
  // body would be a second, unchecked answer to a question the route already
  // answers, and the two could disagree.
  const parsed = bulkDomainsSchema.safeParse({
    ...(request.body as Record<string, unknown>),
    clientId: clientId.success ? clientId.data : '',
  });

  if (!clientId.success || !parsed.success) {
    response.status(400).json({ error: { message: 'Enter a client and at least one domain.' } });
    return;
  }

  try {
    const result = await bulkImportDomains({
      organizationId: response.locals.organizationId,
      actorUserId: response.locals.session?.user?.id,
      clientId: parsed.data.clientId,
      domains: parsed.data.domains,
    });

    response.status(201).json({
      created: result.created.length,
      failed: result.failed.length,
      planBlocked: result.planBlocked.length,
      domains: result.created,
      failures: result.failed,
      planLimitRejections: result.planBlocked,
      limits: bulkLimits,
    });
  } catch (error) {
    if (error instanceof DomainValidationError) {
      response.status(400).json({ error: { message: error.message } });
      return;
    }
    // A request over the per-call cap throws a typed entitlement error, and that
    // is a 402 rather than a 500: the caller is asking for more than one request
    // may carry, and saying so plainly is the whole answer. `details` carries
    // the limit and the requested count, which is what the screen needs to say
    // "a single import takes at most N".
    if (error instanceof EntitlementError) {
      response.status(402).json({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    response.status(500).json({ error: { message: 'Those domains could not be added.' } });
  }
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
