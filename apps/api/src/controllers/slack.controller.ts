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
    response.status(error.status).json({ error: error.message, code: error.code });
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
    const body = request.body as { webhookUrl?: string; channelLabel?: string | null };
    const destination = await configureSlackDestination({
      organizationId: organizationId(request),
      webhookUrl: body.webhookUrl ?? '',
      channelLabel: body.channelLabel ?? null,
    });
    response.json(destination);
  } catch (error) {
    handle(error, response);
  }
}

export async function setSlackDestinationEnabledController(request: Request, response: Response) {
  try {
    const body = request.body as { enabled?: boolean };
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