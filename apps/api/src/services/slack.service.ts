import { URL } from 'node:url';
import { prisma } from '../database/prisma.js';
import { decryptSensitive, encryptSensitive } from './privacy.service.js';

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
  channelLabel: string | null;
  enabled: boolean;
  maskedUrl: string;
  lastDeliveredAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export async function getSlackDestination(
  organizationId: string,
): Promise<SlackDestinationView | null> {
  const destination = await prisma.slackDestination.findUnique({
    where: { organizationId },
  });

  if (!destination) {
    return null;
  }

  return {
    channelLabel: destination.channelLabel,
    enabled: destination.enabled,
    maskedUrl: maskWebhookUrl(destination.encryptedWebhookUrl),
    lastDeliveredAt: destination.lastDeliveredAt,
    consecutiveFailures: destination.consecutiveFailures,
    lastError: destination.lastError,
  };
}

export async function configureSlackDestination(input: {
  organizationId: string;
  webhookUrl: string;
  channelLabel?: string | null;
}): Promise<SlackDestinationView> {
  const url = parseSlackWebhookUrl(input.webhookUrl);

  await prisma.slackDestination.upsert({
    where: { organizationId: input.organizationId },
    create: {
      organizationId: input.organizationId,
      channelLabel: input.channelLabel ?? null,
      encryptedWebhookUrl: encryptSensitive(url.toString()),
    },
    update: {
      channelLabel: input.channelLabel ?? null,
      encryptedWebhookUrl: encryptSensitive(url.toString()),
      // A new webhook is a fresh start. Carrying the old failure count across
      // would leave a working integration showing as broken until enough alerts
      // fired to climb back past the old number.
      consecutiveFailures: 0,
      lastError: null,
    },
  });

  const view = await getSlackDestination(input.organizationId);
  if (!view) {
    throw new SlackError('The destination could not be saved.', 'SLACK_ERROR', 500);
  }

  return view;
}

export async function setSlackDestinationEnabled(input: {
  organizationId: string;
  enabled: boolean;
}): Promise<void> {
  const result = await prisma.slackDestination.updateMany({
    where: { organizationId: input.organizationId },
    data: { enabled: input.enabled },
  });

  if (result.count === 0) {
    throw new SlackError('No Slack destination is configured.', 'NO_DESTINATION', 404);
  }
}

export async function deleteSlackDestination(organizationId: string): Promise<void> {
  await prisma.slackDestination.deleteMany({ where: { organizationId } });
}

/**
 * Is there a channel this workspace actually wants posts in?
 *
 * Checked before a delivery row is written rather than after. A delivery row
 * exists to record and deduplicate an attempt; with no destination there is no
 * attempt, no reminder level to protect, and nothing to audit. Writing one
 * anyway would put a row per alert per workspace in the table forever, and would
 * make an alert look like it had been delivered somewhere.
 */
export async function hasEnabledSlackDestination(organizationId: string): Promise<boolean> {
  const destination = await prisma.slackDestination.findFirst({
    where: { organizationId, enabled: true },
    select: { id: true },
  });

  return destination !== null;
}

export interface SlackAlertMessage {
  subject: string;
  body: string;
  domainName: string;
  risk: 'high' | 'medium' | 'low';
}

/**
 * Posts one alert, or records why it could not.
 *
 * Failure is swallowed into the destination row rather than thrown, because the
 * caller is an alert evaluation tick that must go on to the other rules. An
 * unreachable Slack channel is a problem for one workspace, not a reason to
 * abandon every remaining rule in the tick.
 */
export async function deliverSlackAlert(input: {
  organizationId: string;
  message: SlackAlertMessage;
}): Promise<{ delivered: boolean; error?: string }> {
  const destination = await prisma.slackDestination.findFirst({
    where: { organizationId: input.organizationId, enabled: true },
    select: { id: true, encryptedWebhookUrl: true },
  });

  if (!destination) {
    return { delivered: false };
  }

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
    const message = error instanceof SlackError ? error.message : 'Stored webhook URL is invalid.';
    await recordSlackFailure(destination.id, message);
    return { delivered: false, error: message };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `${input.message.subject}\n${input.message.body}`.slice(0, 3000),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${escapeSlack(input.message.subject)}*\n${escapeSlack(input.message.body)}`.slice(
                0,
                2900,
              ),
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `DMARC Harbor - ${escapeSlack(input.message.domainName)} - ${input.message.risk} risk`,
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
    const message = error instanceof Error ? error.message : 'Unknown Slack delivery error.';
    await recordSlackFailure(destination.id, message);
    return { delivered: false, error: message };
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