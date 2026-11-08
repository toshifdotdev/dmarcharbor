import { URL } from 'node:url';
import { prisma } from '../database/prisma.js';
import { decryptSensitive, encryptSensitive } from './privacy.service.js';
import { maxChatDestinations, routeAllows, routeSentence, type ChatKind } from './chat-routing.js';

/**
 * Slack incoming-webhook delivery for domain alerts.
 *
 * **What Slack is, in the terms this code needs.** Slack is a team chat tool.
 * Each channel has an address, and Slack will hand you a URL that says "POST a
 * message here and it appears in that channel". That URL is all this feature
 * uses: there is no Slack app to install, no bot token, no OAuth handshake, and
 * no message history to read. A workspace owner clicks "Add Slack
 * integration", picks a channel, Slack shows a webhook URL, they paste it here.
 *
 * That simplicity is exactly why the webhook URL has to be treated as a secret.
 * The URL *is* the ability to post. There is no second factor and no revocation
 * short of deleting the webhook in Slack, so anyone who sees it can write to the
 * channel and nobody can tell it was not us.
 */

export class SlackError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_WEBHOOK_URL'
      | 'NO_DESTINATION'
      | 'DESTINATION_PAUSED'
      | 'DESTINATION_LIMIT'
      | 'DELIVERY_FAILED'
      | 'SLACK_ERROR',
    readonly status: number,
  ) {
    super(message);
    this.name = 'SlackError';
  }
}

/**
 * The only host a Slack incoming webhook can live on.
 *
 * Exact match, deliberately not a suffix check. `endsWith('hooks.slack.com')`
 * accepts `hooks.slack.com.attacker.example`, which is a host the customer
 * controls, which turns this feature into a request forwarder aimed at whatever
 * that host decides to return.
 */
const SLACK_WEBHOOK_HOST = 'hooks.slack.com';

/**
 * Validates a pasted webhook URL.
 *
 * The threat is server-side request forgery. This feature takes a URL from an
 * authenticated user and makes the server fetch it, so without these checks a
 * workspace owner could aim our outbound requests at the cloud metadata service,
 * at an internal admin port, or at a loopback listener and read the response
 * back through the delivery error message.
 *
 * Three things are refused for that reason: a non-https scheme, any host other
 * than Slack's, and any explicit port. A port is refused because the host is
 * otherwise genuine but `hooks.slack.com:8080` is somebody else's service.
 * Credentials in the URL are refused for the same reason they are refused on
 * the IMAP side: `user:pass@hooks.slack.com` parses as a host and would defeat
 * a naive read of what was pasted.
 */
export function parseSlackWebhookUrl(value: string): URL {
  const trimmed = (value ?? '').trim();

  if (!trimmed) {
    throw new SlackError('Paste the Slack webhook URL.', 'INVALID_WEBHOOK_URL', 400);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SlackError('That is not a URL.', 'INVALID_WEBHOOK_URL', 400);
  }

  if (url.protocol !== 'https:') {
    throw new SlackError(
      'The webhook URL must start with https.',
      'INVALID_WEBHOOK_URL',
      400,
    );
  }

  if (url.hostname.toLowerCase() !== SLACK_WEBHOOK_HOST) {
    throw new SlackError(
      `That is not a Slack webhook URL. It must be an address on ${SLACK_WEBHOOK_HOST}.`,
      'INVALID_WEBHOOK_URL',
      400,
    );
  }

  if (url.port) {
    throw new SlackError(
      'Remove the port from the webhook URL.',
      'INVALID_WEBHOOK_URL',
      400,
    );
  }

  if (url.username || url.password) {
    throw new SlackError(
      'The webhook URL must not contain a username or password.',
      'INVALID_WEBHOOK_URL',
      400,
    );
  }

  // /services/T…/B…/token is the shape Slack issues. Checking the prefix means a
  // real https://hooks.slack.com URL that is not actually an incoming webhook is
  // rejected at configuration time rather than failing on the first alert.
  if (!url.pathname.startsWith('/services/')) {
    throw new SlackError(
      'That does not look like a Slack incoming webhook URL.',
      'INVALID_WEBHOOK_URL',
      400,
    );
  }

  return url;
}

/**
 * Shows enough of the URL to recognise it and not enough to use it.
 *
 * The path is the entire secret, so what is left is the host and a shortened
 * tail. This is what the settings screen shows so an owner can tell which of
 * three pasted webhooks is which without the API ever handing back the ability
 * to post.
 */
export function maskWebhookUrl(encryptedUrl: string): string {
  const plain = decryptSensitive(encryptedUrl);
  if (!plain) {
    return 'https://hooks.slack.com/...';
  }

  try {
    const url = new URL(plain);
    const tail = url.pathname.slice(-4);
    return `${url.protocol}//${url.host}/...${tail}`;
  } catch {
    return 'https://hooks.slack.com/...';
  }
}

export interface SlackDestinationView {
  id: string;
  channelLabel: string | null;
  enabled: boolean;
  maskedUrl: string;
  /** Clients whose messages this channel receives; empty means every client. */
  clientIds: string[];
  /** Kinds of message it receives (chat-routing chatKinds); empty means all. */
  kinds: string[];
  lastDeliveredAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  createdAt: Date;
}

type SlackRow = {
  id: string;
  channelLabel: string | null;
  enabled: boolean;
  encryptedWebhookUrl: string;
  clientIds: string[];
  kinds: string[];
  lastDeliveredAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  createdAt: Date;
};

function slackView(row: SlackRow): SlackDestinationView {
  return {
    id: row.id,
    channelLabel: row.channelLabel,
    enabled: row.enabled,
    maskedUrl: maskWebhookUrl(row.encryptedWebhookUrl),
    clientIds: row.clientIds,
    kinds: row.kinds,
    lastDeliveredAt: row.lastDeliveredAt,
    consecutiveFailures: row.consecutiveFailures,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}

/** Every channel, oldest first: the first is the one the single-destination routes act on. */
export async function listSlackDestinations(organizationId: string): Promise<SlackDestinationView[]> {
  const rows = await prisma.slackDestination.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(slackView);
}

/**
 * The oldest channel, for the original single-destination routes
 * (/slack-destination). A workspace that connected one channel before routing
 * existed sees exactly what it saw before.
 */
export async function getSlackDestination(organizationId: string): Promise<SlackDestinationView | null> {
  return (await listSlackDestinations(organizationId))[0] ?? null;
}

/** Connects or replaces the oldest channel (PUT /slack-destination). */
export async function configureSlackDestination(input: {
  organizationId: string;
  webhookUrl: string;
  channelLabel?: string | null;
}): Promise<SlackDestinationView> {
  const existing = await getSlackDestination(input.organizationId);
  if (!existing) {
    return createSlackDestination(input);
  }
  return updateSlackDestination({
    organizationId: input.organizationId,
    destinationId: existing.id,
    webhookUrl: input.webhookUrl,
    channelLabel: input.channelLabel ?? null,
  });
}

/** Adds a channel, up to maxChatDestinations, routed by client and kind. */
export async function createSlackDestination(input: {
  organizationId: string;
  webhookUrl: string;
  channelLabel?: string | null;
  clientIds?: string[];
  kinds?: string[];
}): Promise<SlackDestinationView> {
  const url = parseSlackWebhookUrl(input.webhookUrl);
  const count = await prisma.slackDestination.count({ where: { organizationId: input.organizationId } });
  if (count >= maxChatDestinations) {
    throw new SlackError(
      `This workspace already has ${maxChatDestinations} Slack channels, the most it can hold. Remove one before adding another.`,
      'DESTINATION_LIMIT',
      409,
    );
  }
  const row = await prisma.slackDestination.create({
    data: {
      organizationId: input.organizationId,
      channelLabel: input.channelLabel ?? null,
      encryptedWebhookUrl: encryptSensitive(url.toString()),
      clientIds: input.clientIds ?? [],
      kinds: input.kinds ?? [],
    },
  });
  return slackView(row);
}

/** Changes one channel: its label, routing, on or off, or a new webhook URL. */
export async function updateSlackDestination(input: {
  organizationId: string;
  destinationId: string;
  webhookUrl?: string;
  channelLabel?: string | null;
  clientIds?: string[];
  kinds?: string[];
  enabled?: boolean;
}): Promise<SlackDestinationView> {
  const url = input.webhookUrl !== undefined ? parseSlackWebhookUrl(input.webhookUrl) : null;
  const result = await prisma.slackDestination.updateMany({
    where: { id: input.destinationId, organizationId: input.organizationId },
    data: {
      ...(input.channelLabel !== undefined ? { channelLabel: input.channelLabel } : {}),
      ...(input.clientIds !== undefined ? { clientIds: input.clientIds } : {}),
      ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      // A new webhook is a fresh start. Carrying the old failure count across
      // would leave a working integration showing as broken until enough alerts
      // fired to climb back past the old number.
      ...(url ? { encryptedWebhookUrl: encryptSensitive(url.toString()), consecutiveFailures: 0, lastError: null } : {}),
    },
  });
  if (result.count === 0) {
    throw new SlackError('No such Slack channel in this workspace.', 'NO_DESTINATION', 404);
  }
  const row = await prisma.slackDestination.findFirstOrThrow({ where: { id: input.destinationId } });
  return slackView(row);
}

/** Pauses or resumes one channel, or the oldest when no id is given. */
export async function setSlackDestinationEnabled(input: {
  organizationId: string;
  enabled: boolean;
  destinationId?: string;
}): Promise<void> {
  const destinationId = input.destinationId ?? (await getSlackDestination(input.organizationId))?.id;
  if (!destinationId) {
    throw new SlackError('No Slack destination is configured.', 'NO_DESTINATION', 404);
  }
  await updateSlackDestination({ organizationId: input.organizationId, destinationId, enabled: input.enabled });
}

/** Removes one channel, or the oldest when no id is given. True when one was removed. */
export async function deleteSlackDestination(organizationId: string, destinationId?: string): Promise<boolean> {
  const id = destinationId ?? (await getSlackDestination(organizationId))?.id;
  if (!id) return false;
  const result = await prisma.slackDestination.deleteMany({ where: { id, organizationId } });
  return result.count > 0;
}

/**
 * Is there a channel that wants this message?
 *
 * Checked before a delivery row is written rather than after. A delivery row
 * exists to record and deduplicate an attempt; with no destination there is no
 * attempt, no reminder level to protect, and nothing to audit. Writing one
 * anyway would put a row per alert per workspace in the table forever, and would
 * make an alert look like it had been delivered somewhere.
 */
export async function hasEnabledSlackDestination(
  organizationId: string,
  scope?: { kind: ChatKind; clientId: string | null },
): Promise<boolean> {
  const rows = await prisma.slackDestination.findMany({
    where: { organizationId, enabled: true },
    select: { clientIds: true, kinds: true },
  });
  return rows.some((row) => !scope || routeAllows(row, scope.kind, scope.clientId));
}

export interface SlackAlertMessage {
  subject: string;
  body: string;
  domainName: string;
  risk: 'high' | 'medium' | 'low';
}

/**
 * Posts one message to every channel that takes it, built per channel from
 * the items that channel is routed to (a DNS summary lists only its clients'
 * domains). Returns how many posts went through and why the others did not.
 *
 * Failure is swallowed into each destination row rather than thrown, because
 * the caller is an evaluation tick that must go on. An unreachable channel is
 * a problem for one channel, not a reason to skip the others.
 */
export async function deliverSlackRouted<T extends { clientId: string | null }>(input: {
  organizationId: string;
  kind: ChatKind;
  items: T[];
  build: (items: T[]) => SlackAlertMessage;
}): Promise<{ delivered: number; failed: number; errors: string[] }> {
  const destinations = await prisma.slackDestination.findMany({
    where: { organizationId: input.organizationId, enabled: true },
    select: { id: true, encryptedWebhookUrl: true, clientIds: true, kinds: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const outcome = { delivered: 0, failed: 0, errors: [] as string[] };
  for (const destination of destinations) {
    const items = input.items.filter((item) => routeAllows(destination, input.kind, item.clientId));
    if (items.length === 0) continue;
    const result = await postToSlackDestination(destination, input.build(items));
    if (result.delivered) outcome.delivered += 1;
    else {
      outcome.failed += 1;
      if (result.error) outcome.errors.push(result.error);
    }
  }
  return outcome;
}

/**
 * Posts one alert to every enabled channel that takes it: all of them when no
 * scope is given, or the one named by destinationId.
 */
export async function deliverSlackAlert(input: {
  organizationId: string;
  message: SlackAlertMessage;
  scope?: { kind: ChatKind; clientId: string | null };
  destinationId?: string;
}): Promise<{ delivered: boolean; error?: string }> {
  const destinations = await prisma.slackDestination.findMany({
    where: {
      organizationId: input.organizationId,
      enabled: true,
      ...(input.destinationId ? { id: input.destinationId } : {}),
    },
    select: { id: true, encryptedWebhookUrl: true, clientIds: true, kinds: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const targets = input.scope
    ? destinations.filter((d) => routeAllows(d, input.scope!.kind, input.scope!.clientId))
    : destinations;
  if (targets.length === 0) {
    return { delivered: false };
  }
  let delivered = false;
  const errors: string[] = [];
  for (const destination of targets) {
    const result = await postToSlackDestination(destination, input.message);
    if (result.delivered) delivered = true;
    else if (result.error) errors.push(result.error);
  }
  return errors.length ? { delivered, error: errors.join('; ') } : { delivered };
}

async function postToSlackDestination(
  destination: { id: string; encryptedWebhookUrl: string },
  message: SlackAlertMessage,
): Promise<{ delivered: boolean; error?: string }> {
  const url = decryptSensitive(destination.encryptedWebhookUrl);
  if (!url) {
    await recordSlackFailure(destination.id, 'The stored webhook URL could not be read.');
    return { delivered: false, error: 'The stored webhook URL could not be read.' };
  }

  // Re-validated at send time, not only at configuration time. The row may have
  // been written by an older build, or imported from a backup, and the guard is
  // cheap next to what it prevents.
  try {
    parseSlackWebhookUrl(url);
  } catch (error) {
    const reason = error instanceof SlackError ? error.message : 'Stored webhook URL is invalid.';
    await recordSlackFailure(destination.id, reason);
    return { delivered: false, error: reason };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `${message.subject}\n${message.body}`.slice(0, 3000),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${escapeSlack(message.subject)}*\n${escapeSlack(message.body)}`.slice(0, 2900),
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `DMARC Harbor - ${escapeSlack(message.domainName)} - ${message.risk} risk`,
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      const error = `Slack returned ${response.status}${detail ? `: ${detail}` : ''}`;
      await recordSlackFailure(destination.id, error);
      return { delivered: false, error };
    }

    await prisma.slackDestination.update({
      where: { id: destination.id },
      data: {
        consecutiveFailures: 0,
        lastError: null,
        lastDeliveredAt: new Date(),
        deliveryClaimedAt: null,
      },
    });

    return { delivered: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown Slack delivery error.';
    await recordSlackFailure(destination.id, reason);
    return { delivered: false, error: reason };
  }
}
async function recordSlackFailure(destinationId: string, error: string): Promise<void> {
  /**
   * Incremented by the database rather than in JavaScript.
   *
   * Read-then-write means two alerts failing at the same moment both read N and
   * both write N+1, so the count permanently under-reports and a dead channel
   * never reaches the threshold that would stop us posting to it. The webhook
   * delivery counter already did this correctly with `{ increment: 1 }`.
   */
  await prisma.slackDestination.update({
    where: { id: destinationId },
    data: {
      consecutiveFailures: { increment: 1 },
      lastError: error,
    },
  });
}

/**
 * Neutralises the characters Slack treats as markup.
 *
 * A domain name is customer-controlled and reaches this text through a DNS
 * record. Left alone, `<!channel>` in a domain or alert body makes Slack
 * mention everyone in the workspace, so an alert becomes a way to page the whole
 * company at will. The characters are replaced rather than stripped so the
 * original text stays readable in the message.
 */
export function escapeSlack(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Posts a test message to one channel (the oldest when no id is given), so a
 * setup mistake (a webhook for the wrong channel, an app that was uninstalled)
 * shows up now rather than during an incident. It names the real workspace,
 * the channel and what the channel is routed to, and goes through the same
 * delivery as an alert, so it updates the failure counter the same way.
 */
export async function sendSlackTestMessage(
  organizationId: string,
  destinationId?: string,
): Promise<{ delivered: boolean; error?: string }> {
  const destination = await prisma.slackDestination.findFirst({
    where: { organizationId, ...(destinationId ? { id: destinationId } : {}) },
    select: { id: true, enabled: true, channelLabel: true, clientIds: true, kinds: true, organization: { select: { name: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (!destination) {
    throw new SlackError('No Slack destination is configured.', 'NO_DESTINATION', 404);
  }
  if (!destination.enabled) {
    throw new SlackError('Slack alerts are paused. Turn them on, then send the test message.', 'DESTINATION_PAUSED', 409);
  }
  const workspace = destination.organization.name;
  const where = destination.channelLabel ? `#${destination.channelLabel.replace(/^#/, '')}` : 'here';
  const routed = await routeSentence(organizationId, destination);
  return deliverSlackAlert({
    organizationId,
    destinationId: destination.id,
    message: {
      subject: `Test message for ${workspace}`,
      body: `This is a test, and needs no action. ${routed} for ${workspace} will be posted ${where === 'here' ? 'here' : `to ${where}`}.`,
      domainName: 'no domain, a test',
      risk: 'low',
    },
  });
}
