import type { Request, Response } from 'express';
import { recordAuditEvent } from '../services/audit.service.js';
import {
  TeamsError,
  configureTeamsDestination,
  deleteTeamsDestination,
  getTeamsDestination,
  sendTeamsTestMessage,
  setTeamsDestinationEnabled,
} from '../services/teams.service.js';

function organizationId(request: Request): string {
  return request.params.organizationId as string;
}

function handle(error: unknown, response: Response): void {
  if (error instanceof TeamsError) {
    // The same nested shape as every other route ({ error: { code, message } }).
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }

  throw error;
}

/**
 * The audit detail names the provider and the host, never the address.
 *
 * The audit log is read by more people than the settings page is — analysts,
 * auditors, an owner reviewing a departure — and the webhook URL is the whole
 * credential. A row that quoted it would hand posting rights to everyone who can
 * read the log.
 */
function hostOf(maskedUrl: string): string {
  try {
    return new URL(maskedUrl).host;
  } catch {
    return 'unknown';
  }
}

export async function getTeamsDestinationController(request: Request, response: Response) {
  try {
    response.json(await getTeamsDestination(organizationId(request)));
  } catch (error) {
    handle(error, response);
  }
}

export async function configureTeamsDestinationController(request: Request, response: Response) {
  try {
    const body = (request.body ?? {}) as { webhookUrl?: unknown; channelLabel?: unknown };
    const channelLabel =
      typeof body.channelLabel === 'string' ? body.channelLabel.trim().slice(0, 80) || null : null;
    const destination = await configureTeamsDestination({
      organizationId: organizationId(request),
      webhookUrl: typeof body.webhookUrl === 'string' ? body.webhookUrl : '',
      channelLabel,
    });

    await recordAuditEvent({
      organizationId: organizationId(request),
      actorUserId: response.locals.session?.user?.id,
      action: 'TEAMS_DESTINATION_CONFIGURED',
      targetType: 'teams_destination',
      detail: { channelLabel: destination.channelLabel, host: hostOf(destination.maskedUrl) },
      requestId: response.locals.requestId,
    });

    response.json(destination);
  } catch (error) {
    handle(error, response);
  }
}

export async function setTeamsDestinationEnabledController(request: Request, response: Response) {
  try {
    const body = (request.body ?? {}) as { enabled?: unknown };
    // A missing or non-boolean flag is refused rather than read as "off".
    if (typeof body.enabled !== 'boolean') {
      response
        .status(400)
        .json({ error: { code: 'INVALID_REQUEST', message: 'Send enabled as true or false.' } });
      return;
    }
    await setTeamsDestinationEnabled({
      organizationId: organizationId(request),
      enabled: body.enabled === true,
    });
    response.status(204).send();
  } catch (error) {
    handle(error, response);
  }
}

export async function deleteTeamsDestinationController(request: Request, response: Response) {
  try {
    const organizationIdValue = organizationId(request);
    const existing = await getTeamsDestination(organizationIdValue);
    await deleteTeamsDestination(organizationIdValue);

    if (existing) {
      await recordAuditEvent({
        organizationId: organizationIdValue,
        actorUserId: response.locals.session?.user?.id,
        action: 'TEAMS_DESTINATION_REMOVED',
        targetType: 'teams_destination',
        detail: { channelLabel: existing.channelLabel, host: hostOf(existing.maskedUrl) },
        requestId: response.locals.requestId,
      });
    }

    response.status(204).send();
  } catch (error) {
    handle(error, response);
  }
}

export async function testTeamsDestinationController(request: Request, response: Response) {
  try {
    const result = await sendTeamsTestMessage(organizationId(request));
    response.json(result);
  } catch (error) {
    handle(error, response);
  }
}
