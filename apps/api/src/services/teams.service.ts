import { URL } from 'node:url';
import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { decryptSensitive, encryptSensitive } from './privacy.service.js';

/**
 * Microsoft Teams delivery for domain alerts, through a Workflows webhook.
 *
 * **What changed under us.** Teams used to accept messages at an "Incoming
 * Webhook" issued by the Office 365 connector, and those addresses looked like
 * `https://outlook.office.com/webhook/...`. Microsoft retired that connector, and
 * the final shutdown ran 18–22 May 2026 (Microsoft 365 Dev Blog). Those URLs do
 * not work any more, at all, for anybody. The replacement is a Power Automate
 * flow created from the Teams template "Post to a channel when a webhook request
 * is received", which hands back an address on `*.logic.azure.com` (public cloud)
 * or `*.environment.api.powerplatform.com` (newer and government environments).
 *
 * So the validation here is not "is this a Teams URL" in the loose sense. There
 * are exactly two host families, each with a path prefix that identifies the
 * Workflows trigger, and a pasted legacy address gets its own message saying what
 * happened and what to do instead. A generic "that is not a URL" would send an
 * MSP to a support ticket about a product Microsoft already replaced.
 *
 * **Why the address is a secret.** It is the ability to post, exactly as Slack's
 * is: no token, no revocation short of deleting the flow in Teams. Anyone who
 * sees it can write to the channel and nobody can tell it was not us. It is
 * encrypted at rest, never returned, and masked down to the host plus four
 * characters of the path.
 */

export class TeamsError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_WEBHOOK_URL'
      | 'LEGACY_WEBHOOK_URL'
      | 'NO_DESTINATION'
      | 'DESTINATION_PAUSED'
      | 'DELIVERY_FAILED'
      | 'TEAMS_ERROR',
    readonly status: number,
  ) {
    super(message);
    this.name = 'TeamsError';
  }
}

/**
 * The two host families a Workflows trigger can live on, each with the path
 * prefix that belongs to it.
 *
 * A suffix match on the host, but compared on a label boundary rather than with
 * `endsWith`. `endsWith('.logic.azure.com')` is already safe for
 * `evillogic.azure.com.attacker.net` (it ends in `.attacker.net`), but it would
 * accept `logic.azure.com.evil` only if that string ended with our suffix, which
 * it does not — the danger is the reverse shape, a host we control being a
 * prefix. Comparing the last N labels explicitly, and requiring at least one
 * label in front of them, is the version that cannot be talked around.
 */
const TEAMS_HOSTS: ReadonlyArray<{ suffix: string[]; pathPrefix: string }> = [
  { suffix: ['logic', 'azure', 'com'], pathPrefix: '/workflows/' },
  { suffix: ['environment', 'api', 'powerplatform', 'com'], pathPrefix: '/powerautomate/' },
];

/**
 * Addresses Microsoft has switched off.
 *
 * Listed so they can be refused with their own sentence. This is not a security
 * control — they fail validation on the host family anyway — it is the difference
 * between "that is not a URL I recognise" and "that address stopped working in
 * May 2026, here is where the new one comes from".
 */
const LEGACY_HOSTS = ['outlook.office.com', 'outlook.office365.com', 'webhook.office.com'];

function hostLabels(hostname: string): string[] {
  return hostname.toLowerCase().split('.').filter((label) => label.length > 0);
}

function endsWithLabels(labels: string[], suffix: string[]): boolean {
  if (labels.length <= suffix.length) {
    // Equal length means the host IS the suffix with nothing in front of it,
    // which is not an address Microsoft issues and not a name we would accept.
    return false;
  }

  const tail = labels.slice(labels.length - suffix.length);
  return tail.every((label, index) => label === suffix[index]);
}

function isLegacyHost(labels: string[]): boolean {
  const host = labels.join('.');
  return LEGACY_HOSTS.some((legacy) => host === legacy || host.endsWith(`.${legacy}`));
}

/**
 * Validates a pasted Teams Workflows address.
 *
 * The threat is server-side request forgery: this feature takes a URL from an
 * authenticated user and makes the server post to it. The fixed host families are
 * the control, exactly as Slack's single fixed host is, and the checks below
 * refuse everything that could aim the request somewhere else — a non-https
 * scheme, a port (the host may be genuine but `prod-00.logic.azure.com:8080` is
 * somebody else's listener), and credentials in the URL.
 */
export function parseTeamsWebhookUrl(value: string): URL {
  const trimmed = (value ?? '').trim();

  if (!trimmed) {
    throw new TeamsError('Paste the address Teams gave you.', 'INVALID_WEBHOOK_URL', 400);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TeamsError('That is not a URL.', 'INVALID_WEBHOOK_URL', 400);
  }

  if (url.protocol !== 'https:') {
    throw new TeamsError('The address must start with https.', 'INVALID_WEBHOOK_URL', 400);
  }

  const labels = hostLabels(url.hostname);

  if (isLegacyHost(labels)) {
    throw new TeamsError(
      'That is an old Teams connector address, which Microsoft switched off in May 2026. In the Teams channel choose ⋯ › Workflows › \'Post to a channel when a webhook request is received\' and paste the address it gives you.',
      'LEGACY_WEBHOOK_URL',
      400,
    );
  }

  const family = TEAMS_HOSTS.find((entry) => endsWithLabels(labels, entry.suffix));

  if (!family) {
    throw new TeamsError(
      'That is not a Teams Workflows address. It must end with logic.azure.com or environment.api.powerplatform.com.',
      'INVALID_WEBHOOK_URL',
      400,
    );
  }

  // An explicit :443 is what Teams often prints and is harmless; anything else is
  // not a port Microsoft serves this on.
  if (url.port && url.port !== '443') {
    throw new TeamsError('Remove the port from the address, or use 443.', 'INVALID_WEBHOOK_URL', 400);
  }

  if (url.username || url.password) {
    throw new TeamsError(
      'The address must not contain a username or password.',
      'INVALID_WEBHOOK_URL',
      400,
    );
  }

  if (!url.pathname.startsWith(family.pathPrefix)) {
    throw new TeamsError(
      `That address is on the right host but not a Workflows trigger: its path must start with ${family.pathPrefix}`,
      'INVALID_WEBHOOK_URL',
      400,
    );
  }

  return url;
}

/**
 * Shows enough of the address to recognise it and not enough to use it.
 *
 * The path carries the trigger id and the `sig` query parameter is the secret
 * itself, so only the host and four characters of the path survive. The query
 * string is never included — that is the part that would let a reader post.
 */
export function maskTeamsWebhookUrl(encryptedUrl: string): string {
  const plain = decryptSensitive(encryptedUrl);
  if (!plain) {
    return 'https://logic.azure.com/...';
  }

  try {
    const url = new URL(plain);
    const tail = url.pathname.slice(-4);
    return `${url.protocol}//${url.host}/...${tail}`;
  } catch {
    return 'https://logic.azure.com/...';
  }
}

export interface TeamsDestinationView {
  channelLabel: string | null;
  enabled: boolean;
  maskedUrl: string;
  lastDeliveredAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export async function getTeamsDestination(
  organizationId: string,
): Promise<TeamsDestinationView | null> {
  const destination = await prisma.teamsDestination.findUnique({
    where: { organizationId },
  });

  if (!destination) {
    return null;
  }

  return {
    channelLabel: destination.channelLabel,
    enabled: destination.enabled,
    maskedUrl: maskTeamsWebhookUrl(destination.encryptedWebhookUrl),
    lastDeliveredAt: destination.lastDeliveredAt,
    consecutiveFailures: destination.consecutiveFailures,
    lastError: destination.lastError,
  };
}

export async function configureTeamsDestination(input: {
  organizationId: string;
  webhookUrl: string;
  channelLabel?: string | null;
}): Promise<TeamsDestinationView> {
  const url = parseTeamsWebhookUrl(input.webhookUrl);

  await prisma.teamsDestination.upsert({
    where: { organizationId: input.organizationId },
    create: {
      organizationId: input.organizationId,
      channelLabel: input.channelLabel ?? null,
      encryptedWebhookUrl: encryptSensitive(url.toString()),
    },
    update: {
      channelLabel: input.channelLabel ?? null,
      encryptedWebhookUrl: encryptSensitive(url.toString()),
      // A fresh address is a fresh start: carrying the old failure count across
      // would leave a working integration showing as broken.
      consecutiveFailures: 0,
      lastError: null,
    },
  });

  const view = await getTeamsDestination(input.organizationId);
  if (!view) {
    throw new TeamsError('The destination could not be saved.', 'TEAMS_ERROR', 500);
  }

  return view;
}

export async function setTeamsDestinationEnabled(input: {
  organizationId: string;
  enabled: boolean;
}): Promise<void> {
  const result = await prisma.teamsDestination.updateMany({
    where: { organizationId: input.organizationId },
    data: { enabled: input.enabled },
  });

  if (result.count === 0) {
    throw new TeamsError('No Teams destination is configured.', 'NO_DESTINATION', 404);
  }
}

export async function deleteTeamsDestination(organizationId: string): Promise<void> {
  await prisma.teamsDestination.deleteMany({ where: { organizationId } });
}

/**
 * Is there a channel this workspace actually wants posts in?
 *
 * Checked before a delivery row is written, for the same reason as Slack: a
 * delivery row exists to record and deduplicate an attempt, and with no
 * destination there is no attempt.
 */
export async function hasEnabledTeamsDestination(organizationId: string): Promise<boolean> {
  const destination = await prisma.teamsDestination.findFirst({
    where: { organizationId, enabled: true },
    select: { id: true },
  });

  return destination !== null;
}

export interface TeamsAlertMessage {
  subject: string;
  body: string;
  domainName: string;
  workspaceName: string;
  risk: 'high' | 'medium' | 'low';
  /**
   * The page an "Open in DMARC Harbor" button should land on. Empty means no
   * button at all, which is what the test message wants: a card whose only
   * action goes nowhere is a worse first impression than one with no action.
   */
  linkPath: string;
}

/** Teams' own message ceiling is about 28 KB; this keeps us well inside it. */
const maximumBodyCharacters = 3000;

/** Cuts text to `limit` characters at the last whole line, and says it was cut. */
function capOnLine(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = '\n… (shortened; open DMARC Harbor for the rest)';
  const room = limit - marker.length;
  const cut = text.slice(0, room);
  const lastBreak = cut.lastIndexOf('\n');
  return `${lastBreak > 0 ? cut.slice(0, lastBreak) : cut}${marker}`;
}

/**
 * The card Teams renders.
 *
 * Three deliberate choices, each of which is about a customer's DNS record
 * reaching a chat client:
 *
 * 1. The body is a **RichTextBlock of TextRuns**, not a TextBlock. A TextRun does
 *    not parse markdown, so a summary containing `[click](https://evil)` — which
 *    is text a customer controls, through a TXT record — renders as those
 *    characters rather than becoming a link that says "click".
 * 2. The heading is our own fixed wording. Nothing from the report or the DNS
 *    record goes in it.
 * 3. The facts are three fields we name ourselves, not a free-form dump.
 */
export function buildTeamsCard(input: {
  message: TeamsAlertMessage;
  appUrl: string;
}): Record<string, unknown> {
  /**
   * Only a character cap, cut on a line boundary.
   *
   * The callers already shorten their own lists (the DNS summary lists ten
   * changes and says "and N more"; an alert lists at most ten spoofing
   * sources). A second line cap here cut every alert body at ten lines, which
   * dropped the reminder level and the "move to p=reject" advice, and turned the
   * DNS summary's own "and 5 more" into "and 1 more".
   */
  const body = capOnLine(input.message.body, maximumBodyCharacters);

  const riskWord = input.message.risk === 'high' ? 'High' : input.message.risk === 'medium' ? 'Medium' : 'Low';

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: 'DMARC Harbor alert',
              weight: 'Bolder',
              size: 'Medium',
              wrap: true,
            },
            {
              type: 'RichTextBlock',
              inlines: [
                {
                  type: 'TextRun',
                  text: input.message.subject,
                  weight: 'Bolder',
                  wrap: true,
                },
                {
                  type: 'TextRun',
                  text: `\n\n${body}`,
                  wrap: true,
                },
              ],
            },
            {
              type: 'FactSet',
              facts: [
                { title: 'Domain', value: input.message.domainName },
                { title: 'Risk', value: riskWord },
                { title: 'Workspace', value: input.message.workspaceName },
              ],
            },
          ],
          actions:
            input.message.linkPath && input.appUrl
              ? [
                  {
                    type: 'Action.OpenUrl',
                    title: 'Open in DMARC Harbor',
                    url: `${input.appUrl}${input.message.linkPath}`,
                  },
                ]
              : [],
        },
      },
    ],
  };
}

async function postTeams(url: string, payload: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      // A redirect is an error rather than something to follow: the host family
      // check is what makes this request safe, and a redirect moves the request
      // to a host that was never checked.
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // Microsoft's body can be long and is not ours to keep; 200 characters is
      // enough to tell an operator what it objected to.
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      return { ok: false, error: `Teams returned ${response.status}${detail ? `: ${detail}` : ''}` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown Teams delivery error.' };
  }
}

/**
 * Posts one alert, or records why it could not.
 *
 * Failure is swallowed into the destination row rather than thrown, because the
 * caller is an alert evaluation tick that must go on to the other rules. This is
 * also why Teams and Slack are independent: one channel refusing the message is a
 * problem for one workspace's chat, not a reason to abandon the other channel or
 * the remaining rules.
 */
export async function deliverTeamsAlert(input: {
  organizationId: string;
  message: TeamsAlertMessage;
}): Promise<{ delivered: boolean; error?: string }> {
  const destination = await prisma.teamsDestination.findFirst({
    where: { organizationId: input.organizationId, enabled: true },
    select: { id: true, encryptedWebhookUrl: true },
  });

  if (!destination) {
    return { delivered: false };
  }

  const url = decryptSensitive(destination.encryptedWebhookUrl);
  if (!url) {
    const error = 'The stored Teams address could not be read.';
    await recordTeamsFailure(destination.id, error);
    return { delivered: false, error };
  }

  // Re-validated at send time. The row may have been written by an older build
  // or restored from a backup, and the check is cheap next to what it prevents.
  try {
    parseTeamsWebhookUrl(url);
  } catch (error) {
    const message = error instanceof TeamsError ? error.message : 'The stored Teams address is invalid.';
    await recordTeamsFailure(destination.id, message);
    return { delivered: false, error: message };
  }

  const result = await postTeams(url, buildTeamsCard({ message: input.message, appUrl: env.APP_URL }));

  if (!result.ok) {
    await recordTeamsFailure(destination.id, result.error);
    return { delivered: false, error: result.error };
  }

  await prisma.teamsDestination.update({
    where: { id: destination.id },
    data: {
      consecutiveFailures: 0,
      lastError: null,
      lastDeliveredAt: new Date(),
    },
  });

  return { delivered: true };
}

/**
 * Posts the fixed test message.
 *
 * A Workflows setup is easy to get wrong in ways that only show up at the worst
 * moment — the wrong template, a flow that was never turned on, an address from a
 * different channel — so the settings page has a button that finds out now rather
 * than during an incident.
 */
export async function sendTeamsTestMessage(
  organizationId: string,
): Promise<{ delivered: boolean; error?: string }> {
  const destination = await prisma.teamsDestination.findFirst({
    where: { organizationId },
    select: { id: true, enabled: true },
  });

  if (!destination) {
    throw new TeamsError('No Teams destination is configured.', 'NO_DESTINATION', 404);
  }

  // A paused destination posts nothing, so the delivery below would come back
  // "not delivered" with no reason, and the panel would blame Microsoft.
  if (!destination.enabled) {
    throw new TeamsError(
      'Teams alerts are paused. Turn them on, then send the test message.',
      'DESTINATION_PAUSED',
      409,
    );
  }

  return deliverTeamsAlert({
    organizationId,
    message: {
      subject: 'DMARC Harbor test message',
      body: 'This is a test. Alerts for your domains will appear in this channel.',
      domainName: 'test',
      workspaceName: 'test',
      risk: 'low',
      linkPath: '',
    },
  });
}

async function recordTeamsFailure(destinationId: string, error: string): Promise<void> {
  /**
   * Incremented by the database rather than in JavaScript.
   *
   * Read-then-write means two alerts failing at the same moment both read N and
   * both write N+1, so the count under-reports and a dead channel never reaches
   * the number that would make somebody look.
   */
  await prisma.teamsDestination.update({
    where: { id: destinationId },
    data: {
      consecutiveFailures: { increment: 1 },
      lastError: error,
    },
  });
}
