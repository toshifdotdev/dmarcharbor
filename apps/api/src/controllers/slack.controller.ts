import type { Request, Response } from 'express';
import {
  SlackError,
  configureSlackDestination,
  deleteSlackDestination,
  getSlackDestination,
  setSlackDestinationEnabled,
} from '../services/slack.service.js';

function organizationId(request: Request): string {
  return request.params.organizationId as string;
}

function handle(error: unknown, response: Response): void {
  if (error instanceof SlackError) {
    // The same nested shape as every other route ({ error: { code, message } });
    // this was the one controller that put the message where the object goes.
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }

  throw error;
}

/**
 * Slack channel configuration.
 *
 * One destination per workspace rather than per user, because a Slack channel is
 * shared by everyone in it. See `slack.service.ts` for why the webhook URL is
 * treated as a secret rather than a setting.
 */

export async function getSlackDestinationController(request: Request, response: Response) {
  try {
    const destination = await getSlackDestination(organizationId(request));
    response.json(destination);
  } catch (error) {
    handle(error, response);
  }
}

export async function configureSlackDestinationController(request: Request, response: Response) {
  try {
    const body = (request.body ?? {}) as { webhookUrl?: unknown; channelLabel?: unknown };
    // Read as strings or not at all: a non-string used to reach the service as
    // whatever the JSON held. The service validates the URL itself.
    const channelLabel = typeof body.channelLabel === 'string' ? body.channelLabel.trim().slice(0, 80) || null : null;
    const destination = await configureSlackDestination({
      organizationId: organizationId(request),
      webhookUrl: typeof body.webhookUrl === 'string' ? body.webhookUrl : '',
      channelLabel,
    });
    response.json(destination);
  } catch (error) {
    handle(error, response);
  }
}

export async function setSlackDestinationEnabledController(request: Request, response: Response) {
  try {
    const body = (request.body ?? {}) as { enabled?: unknown };
    // A missing or non-boolean flag is refused rather than read as "off".
    if (typeof body.enabled !== 'boolean') {
      response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Send enabled as true or false.' } });
      return;
    }
    await setSlackDestinationEnabled({
      organizationId: organizationId(request),
      enabled: body.enabled === true,
    });
    response.status(204).send();
  } catch (error) {
    handle(error, response);
  }
}

export async function deleteSlackDestinationController(request: Request, response: Response) {
  try {
    await deleteSlackDestination(organizationId(request));
    response.status(204).send();
  } catch (error) {
    handle(error, response);
  }
}