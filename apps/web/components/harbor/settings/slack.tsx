"use client";

/**
 * slack.tsx — the Slack channels that receive the alerts your rules raise,
 * the DNS changes and the expiry warnings, each routed by client and kind.
 * The board itself is chat-channels.tsx, shared with Teams; this file is
 * Slack's words: the webhook, Slack's own steps, and its refusals.
 *
 * Test hooks: slack-webhook, slack-label, slack-save, slack-masked,
 * slack-error, slack-test, slack-test-result, slack-map, slack-channel,
 * slack-route-edit, slack-remove; the plan gate is the UpgradeNotice carrying
 * data-feature="alerts.email".
 */

import type { FeatureStatus } from "@/lib/entitlements";
import type { SlackDestination } from "@/lib/types";
import { ChatChannelsBoard, type ChatCopy } from "./chat-channels";
import type { ClientChoice } from "./webhook-parts";

/** The API's reasons, as guidance. Never the code itself. */
function slackMessage(code: string | undefined, apiMessage: string | undefined): string {
  if (code === "INVALID_WEBHOOK_URL" || code === "REQUEST_FAILED" || code === "400") {
    const reason = apiMessage && !/^[A-Z_]+$/.test(apiMessage) ? apiMessage : "That is not a Slack webhook URL.";
    return `${reason} Paste the webhook URL exactly as Slack's Incoming Webhooks page shows it: it starts with https://hooks.slack.com/services/.`;
  }
  return apiMessage && !/^[A-Z_]+$/.test(apiMessage) ? apiMessage : "The Slack webhook could not be saved. Nothing changed.";
}

const SLACK_COPY: ChatCopy = {
  service: "slack",
  prefix: "slack",
  name: "Slack",
  short: "Slack",
  addressLabel: "Webhook URL",
  addressHint:
    "Treat it like a password: it is a credential that lets anyone holding it post to the channel. It is stored encrypted and only its last four characters are ever shown.",
  placeholder: "https://hooks.slack.com/services/…",
  labelPlaceholder: "#security-alerts",
  kindOfChannel: "Slack, by incoming webhook",
  stepsTitle: "Getting the URL from Slack",
  steps: [
    { key: "app", name: "Open the Incoming Webhooks app", detail: "In Slack, from the workspace's apps." },
    { key: "add", name: "Choose Add to Slack", detail: "Pick the channel the alerts should land in. One webhook per channel." },
    {
      key: "copy",
      name: "Copy the Webhook URL",
      detail: (
        <>
          It starts with <code className="data break-all">https://hooks.slack.com/services/</code>
        </>
      ),
    },
    { key: "paste", name: "Paste it here", detail: "Stored encrypted, never shown again." },
  ],
  saveError: slackMessage,
  testSent: "Sent. Check the channel: the message comes from the app the webhook belongs to.",
  testRefused: (reason) => `Slack refused the message: ${reason}. The webhook may have been removed, or the channel archived.`,
};

export function SlackBoard({
  organizationId,
  destinations,
  clients,
  canManage,
  alerting = null,
  includedFrom = "included on a higher plan",
}: {
  organizationId: string;
  destinations: SlackDestination[];
  clients: ClientChoice[] | null;
  canManage: boolean;
  /** alerts.email on this plan; null when the plan could not be read (the API decides). */
  alerting?: FeatureStatus;
  /** "included from Fairway", from the catalog. */
  includedFrom?: string;
}) {
  return (
    <ChatChannelsBoard
      copy={SLACK_COPY}
      organizationId={organizationId}
      destinations={destinations}
      clients={clients}
      canManage={canManage}
      alerting={alerting}
      includedFrom={includedFrom}
    />
  );
}
