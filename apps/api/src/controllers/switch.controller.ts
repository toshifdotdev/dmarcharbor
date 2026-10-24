import type { Request, Response } from 'express';
import { resourceIdSchema } from '../models/client.model.js';
import { switchKitImportSchema } from '../models/switch.model.js';
import {
  checkClientSwitches,
  checkSwitch,
  deleteSwitch,
  getSwitch,
  importSwitchKit,
  startSwitch,
  SwitchKitError,
} from '../services/switch-kit/switch.service.js';

function parseId(value: string | string[] | undefined): string | null {
  const parsed = resourceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function sendSwitchError(response: Response, error: unknown): void {
  if (error instanceof SwitchKitError) {
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }
  throw error;
}

export async function importSwitchKitController(request: Request, response: Response): Promise<void> {
  const clientId = parseId(request.params.clientId);
  const parsed = switchKitImportSchema.safeParse(request.body);

  if (!clientId || !parsed.success) {
    response.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Enter between 1 and 100 domains, one per line or separated by commas or spaces.',
        details: { maxDomains: 100 },
      },
    });
    return;
  }

  try {
    const result = await importSwitchKit({
      organizationId: response.locals.organizationId,
      actorUserId: response.locals.session?.user?.id,
      clientId,
      domains: parsed.data.domains,
    });
    response.status(201).json(result);
  } catch (error) {
    sendSwitchError(response, error);
  }
}

export async function startSwitchController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  if (!domainId) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }

  try {
    const result = await startSwitch({
      organizationId: response.locals.organizationId,
      actorUserId: response.locals.session?.user?.id,
      domainIdOrSlug: domainId,
    });

    if (!result) {
      response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
      return;
    }

    response.status(201).json(result);
  } catch (error) {
    sendSwitchError(response, error);
  }
}

export async function getSwitchController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  if (!domainId) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }

  const result = await getSwitch(response.locals.organizationId, domainId);
  if (!result) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  response.json(result);
}

export async function checkSwitchController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  if (!domainId) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }

  const result = await checkSwitch({
    organizationId: response.locals.organizationId,
    actorUserId: response.locals.session?.user?.id,
    domainIdOrSlug: domainId,
  });

  if (!result) {
    response.status(404).json({ error: { message: 'This domain has no switch to check.' } });
    return;
  }

  response.json(result);
}

export async function checkClientSwitchesController(request: Request, response: Response): Promise<void> {
  const clientId = parseId(request.params.clientId);
  if (!clientId) {
    response.status(400).json({ error: { message: 'A valid client identifier is required.' } });
    return;
  }

  try {
    const result = await checkClientSwitches({
      organizationId: response.locals.organizationId,
      actorUserId: response.locals.session?.user?.id,
      clientId,
    });
    response.json(result);
  } catch (error) {
    sendSwitchError(response, error);
  }
}

export async function deleteSwitchController(request: Request, response: Response): Promise<void> {
  const domainId = parseId(request.params.domainId);
  if (!domainId) {
    response.status(400).json({ error: { message: 'A valid domain identifier is required.' } });
    return;
  }

  const deleted = await deleteSwitch({
    organizationId: response.locals.organizationId,
    actorUserId: response.locals.session?.user?.id,
    domainIdOrSlug: domainId,
  });

  if (!deleted) {
    response.status(404).json({ error: { message: 'This domain has no switch to stop.' } });
    return;
  }

  response.status(204).send();
}
