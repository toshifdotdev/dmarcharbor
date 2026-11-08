import type { Request, Response } from 'express';
import { z } from 'zod';
import { recordAuditEvent } from '../services/audit.service.js';
import { chatClientNames, checkedChatClientIds, chatScopeSchema } from '../services/chat-routing.js';
import * as slack from '../services/slack.service.js';
import * as teams from '../services/teams.service.js';

/**
 * Several Slack or Teams channels per workspace, each routed by client and kind
 * (/slack-destinations, /teams-destinations). One factory for both services,
 * because the two differ only in the service they call and the words they log.
 *
 * The single-destination routes (/slack-destination, /teams-destination) stay
 * as they were and act on the oldest channel, so nothing built against them
 * changes.
 *
 * Audit details name the channel label, the host and the routing, never the
 * webhook address: its path is the credential.
 */

type View = { id: string; channelLabel: string | null; maskedUrl: string; clientIds: string[]; kinds: string[] };

interface Provider {
  name: 'slack' | 'teams';
  targetType: 'slack_destination' | 'teams_destination';
  actions: {
    configured: 'SLACK_DESTINATION_CONFIGURED' | 'TEAMS_DESTINATION_CONFIGURED';
    removed: 'SLACK_DESTINATION_REMOVED' | 'TEAMS_DESTINATION_REMOVED';
    paused: 'SLACK_DESTINATION_PAUSED' | 'TEAMS_DESTINATION_PAUSED';
    resumed: 'SLACK_DESTINATION_RESUMED' | 'TEAMS_DESTINATION_RESUMED';
  };
  isError: (error: unknown) => error is { status: number; code: string; message: string };
  list: (organizationId: string) => Promise<View[]>;
  create: (input: { organizationId: string; webhookUrl: string; channelLabel: string | null; clientIds: string[]; kinds: string[] }) => Promise<View>;
  update: (input: {
    organizationId: string;
    destinationId: string;
    webhookUrl?: string;
    channelLabel?: string | null;
    clientIds?: string[];
    kinds?: string[];
    enabled?: boolean;
  }) => Promise<View>;
  remove: (organizationId: string, destinationId: string) => Promise<boolean>;
  test: (organizationId: string, destinationId: string) => Promise<{ delivered: boolean; error?: string }>;
}

const providers: Record<'slack' | 'teams', Provider> = {
  slack: {
    name: 'slack',
    targetType: 'slack_destination',
    actions: {
      configured: 'SLACK_DESTINATION_CONFIGURED',
      removed: 'SLACK_DESTINATION_REMOVED',
      paused: 'SLACK_DESTINATION_PAUSED',
      resumed: 'SLACK_DESTINATION_RESUMED',
    },
    isError: (error): error is slack.SlackError => error instanceof slack.SlackError,
    list: slack.listSlackDestinations,
    create: slack.createSlackDestination,
    update: slack.updateSlackDestination,
    remove: (organizationId, destinationId) => slack.deleteSlackDestination(organizationId, destinationId),
    test: (organizationId, destinationId) => slack.sendSlackTestMessage(organizationId, destinationId),
  },
  teams: {
    name: 'teams',
    targetType: 'teams_destination',
    actions: {
      configured: 'TEAMS_DESTINATION_CONFIGURED',
      removed: 'TEAMS_DESTINATION_REMOVED',
      paused: 'TEAMS_DESTINATION_PAUSED',
      resumed: 'TEAMS_DESTINATION_RESUMED',
    },
    isError: (error): error is teams.TeamsError => error instanceof teams.TeamsError,
    list: teams.listTeamsDestinations,
    create: teams.createTeamsDestination,
    update: teams.updateTeamsDestination,
    remove: (organizationId, destinationId) => teams.deleteTeamsDestination(organizationId, destinationId),
    test: (organizationId, destinationId) => teams.sendTeamsTestMessage(organizationId, destinationId),
  },
};

const label = z
  .string()
  .trim()
  .max(80)
  .transform((v) => v || null)
  .nullable();

const createSchema = chatScopeSchema.extend({
  webhookUrl: z.string().max(2000),
  channelLabel: label.optional(),
});

const updateSchema = chatScopeSchema.extend({
  webhookUrl: z.string().max(2000).optional(),
  channelLabel: label.optional(),
  enabled: z.boolean().optional(),
});

function hostOf(maskedUrl: string): string {
  try {
    return new URL(maskedUrl).host;
  } catch {
    return 'unknown';
  }
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * What an audit row stores about a channel: its name, host and routing, with
 * the clients by name as well as id. Session 19 found the trail showed ids a
 * reader could not use, and the same row for a channel added, renamed, rerouted
 * or given a new address.
 */
async function auditDetail(organizationId: string, view: View, change: string[]): Promise<Record<string, unknown>> {
  return {
    change,
    channelLabel: view.channelLabel,
    host: hostOf(view.maskedUrl),
    clients: view.clientIds.length ? await chatClientNames(organizationId, view.clientIds) : 'every client',
    kinds: view.kinds.length ? view.kinds : 'every kind',
    clientIds: view.clientIds,
  };
}

function invalid(response: Response, message: string): void {
  response.status(400).json({ error: { code: 'INVALID_REQUEST', message } });
}

function controllers(provider: Provider) {
  const fail = (error: unknown, response: Response) => {
    if (provider.isError(error)) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    throw error;
  };
  const audit = (request: Request, response: Response, action: string, detail?: Record<string, unknown>, targetId?: string) =>
    recordAuditEvent({
      organizationId: request.params.organizationId as string,
      actorUserId: response.locals.session?.user?.id,
      action: action as never,
      targetType: provider.targetType,
      ...(targetId ? { targetId } : {}),
      ...(detail ? { detail } : {}),
      requestId: response.locals.requestId,
    });

  return {
    async list(request: Request, response: Response) {
      try {
        response.json({ destinations: await provider.list(request.params.organizationId as string) });
      } catch (error) {
        fail(error, response);
      }
    },

    async create(request: Request, response: Response) {
      const body = createSchema.safeParse(request.body ?? {});
      if (!body.success) {
        invalid(response, 'Send webhookUrl, and optionally channelLabel, clientIds and kinds.');
        return;
      }
      const organizationId = request.params.organizationId as string;
      const clientIds = await checkedChatClientIds(organizationId, body.data.clientIds);
      if (clientIds && 'error' in clientIds) {
        invalid(response, clientIds.error);
        return;
      }
      try {
        const destination = await provider.create({
          organizationId,
          webhookUrl: body.data.webhookUrl,
          channelLabel: body.data.channelLabel ?? null,
          clientIds: clientIds ?? [],
          kinds: body.data.kinds ?? [],
        });
        await audit(request, response, provider.actions.configured, await auditDetail(organizationId, destination, ['added']), destination.id);
        response.status(201).json(destination);
      } catch (error) {
        fail(error, response);
      }
    },

    async update(request: Request, response: Response) {
      const body = updateSchema.safeParse(request.body ?? {});
      if (!body.success) {
        invalid(response, 'Send any of webhookUrl, channelLabel, clientIds, kinds and enabled.');
        return;
      }
      const organizationId = request.params.organizationId as string;
      const destinationId = request.params.destinationId as string;
      const clientIds = await checkedChatClientIds(organizationId, body.data.clientIds);
      if (clientIds && 'error' in clientIds) {
        invalid(response, clientIds.error);
        return;
      }
      try {
        const before = (await provider.list(organizationId)).find((d) => d.id === destinationId);
        const destination = await provider.update({
          organizationId,
          destinationId,
          ...(body.data.webhookUrl !== undefined ? { webhookUrl: body.data.webhookUrl } : {}),
          ...(body.data.channelLabel !== undefined ? { channelLabel: body.data.channelLabel } : {}),
          ...(clientIds !== undefined ? { clientIds } : {}),
          ...(body.data.kinds !== undefined ? { kinds: body.data.kinds } : {}),
          ...(body.data.enabled !== undefined ? { enabled: body.data.enabled } : {}),
        });
        const onlyToggle = Object.keys(body.data).every((k) => k === 'enabled');
        // What actually changed, compared with the channel as it was. The edit
        // form sends every field, so a key in the body is not a change.
        const change: string[] = [];
        if (body.data.webhookUrl !== undefined) change.push('address');
        if (before && body.data.channelLabel !== undefined && (before.channelLabel ?? null) !== destination.channelLabel) change.push('name');
        if (before && (!sameSet(before.clientIds, destination.clientIds) || !sameSet(before.kinds, destination.kinds))) change.push('routing');
        if (body.data.enabled !== undefined && !onlyToggle) change.push(body.data.enabled ? 'turned on' : 'turned off');
        await audit(
          request,
          response,
          onlyToggle && body.data.enabled !== undefined
            ? body.data.enabled
              ? provider.actions.resumed
              : provider.actions.paused
            : provider.actions.configured,
          await auditDetail(organizationId, destination, onlyToggle ? [body.data.enabled ? 'turned on' : 'turned off'] : change.length ? change : ['saved, nothing changed']),
          destination.id,
        );
        response.json(destination);
      } catch (error) {
        fail(error, response);
      }
    },

    async remove(request: Request, response: Response) {
      const organizationId = request.params.organizationId as string;
      const destinationId = request.params.destinationId as string;
      try {
        const existing = (await provider.list(organizationId)).find((d) => d.id === destinationId);
        if (!existing || !(await provider.remove(organizationId, destinationId))) {
          response.status(404).json({ error: { code: 'NO_DESTINATION', message: 'No such channel in this workspace.' } });
          return;
        }
        await audit(request, response, provider.actions.removed, { channelLabel: existing.channelLabel, host: hostOf(existing.maskedUrl) }, existing.id);
        response.status(204).send();
      } catch (error) {
        fail(error, response);
      }
    },

    async test(request: Request, response: Response) {
      try {
        response.json(await provider.test(request.params.organizationId as string, request.params.destinationId as string));
      } catch (error) {
        fail(error, response);
      }
    },
  };
}

export const slackDestinations = controllers(providers.slack);
export const teamsDestinations = controllers(providers.teams);

