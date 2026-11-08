"use client";

/**
 * teams.tsx — the Microsoft Teams channels that receive alerts, routed by
 * client and kind exactly as Slack's are (chat-channels.tsx). This file is
 * Teams' words.
 *
 * **Why the copy is so specific.** Teams does not accept a webhook you can make
 * from the channel's own settings any more. Microsoft retired the Office 365
 * connector in May 2026, so the address now comes from a Power Automate flow
 * created from a named template. The steps are spelled out beside the form,
 * and the bot that messages appear from is named so nobody thinks it is
 * phishing.
 *
 * Test hooks: teams-webhook, teams-label, teams-save, teams-masked,
 * teams-error, teams-test, teams-test-result, teams-remove, teams-map,
 * teams-channel, teams-route-edit; the plan gate is the UpgradeNotice carrying
 * data-feature="alerts.email".
 */

import type { FeatureStatus } from "@/lib/entitlements";
import type { TeamsDestination } from "@/lib/types";
import { ChatChannelsBoard, type ChatCopy } from "./chat-channels";
import type { ClientChoice } from "./webhook-parts";

/** The API's reasons, as guidance. Never the code itself. */
function teamsMessage(code: string | undefined, apiMessage: string | undefined): string {
  // A refusal the API explained in words is shown as it wrote it: those
  // sentences name the actual problem (old connector address, wrong host, wrong
  // path), and rewriting them here would lose that.
  if (apiMessage && !/^[A-Z_]+$/.test(apiMessage)) {
    return apiMessage;
  }
  if (code === "LEGACY_WEBHOOK_URL") {
    return "That is an old Teams connector address, which Microsoft switched off in May 2026. In the Teams channel choose ⋯ › Workflows › 'Send webhook alerts to a channel' and paste the address it gives you.";
  }
  if (code === "INVALID_WEBHOOK_URL") {
    return "That is not a Teams Workflows address. It must start with https:// and be on logic.azure.com or environment.api.powerplatform.com.";
  }
  return "The Teams address could not be saved. Nothing changed.";
}

const TEAMS_COPY: ChatCopy = {
  service: "teams",
  prefix: "teams",
  name: "Microsoft Teams",
  short: "Teams",
  addressLabel: "Workflows address",
  addressHint:
    "Starts with https:// and is on logic.azure.com or environment.api.powerplatform.com; a :443 in it is fine. Stored encrypted; only the host and the last four characters are ever shown.",
  placeholder: "https://prod-00.westus.logic.azure.com/workflows/…",
  labelPlaceholder: "Alerts",
  kindOfChannel: "Microsoft Teams, through Workflows",
  stepsTitle: "Getting the address from Teams",
  steps: [
    { key: "open", name: "Open ⋯ › Workflows", detail: "In the Teams channel the alerts should go to." },
    { key: "template", name: "Choose the webhook template", detail: "“Send webhook alerts to a channel”, found by searching Workflows for webhook." },
    { key: "save", name: "Pick the team and channel", detail: "Then save the flow and leave it turned on. One flow per channel." },
    { key: "paste", name: "Paste the address here", detail: "The flow shows it once it is saved." },
  ],
  intro: (
    <>
      <p>
        The address comes from a Teams Workflows flow made from the template{" "}
        <span className="font-semibold">&ldquo;Send webhook alerts to a channel&rdquo;</span> (older Teams called it &ldquo;Post to
        a channel when a webhook request is received&rdquo;). Messages
        appear from <span className="font-semibold text-fg">Workflows</span>, a Microsoft bot. That is expected: Teams does not
        let the sender name or picture be changed.
      </p>
      <p>
        The address is a password. Anyone who has it can post to the channel, and there is no way to tell who sent what. If it
        leaks, delete the flow in Teams and create a new one.
      </p>
    </>
  ),
  saveError: teamsMessage,
  testSent: "Sent. Check the channel: the message comes from Workflows.",
  testRefused: (reason) =>
    `Microsoft refused the message: ${reason}. Check that the flow is turned on and that the address is the one this flow gave you.`,
};

export function TeamsBoard({
  organizationId,
  destinations,
  clients,
  canManage,
  alerting = null,
  includedFrom = "included on a higher plan",
}: {
  organizationId: string;
  destinations: TeamsDestination[];
  clients: ClientChoice[] | null;
  canManage: boolean;
  /** alerts.email on this plan; null when the plan could not be read (the API decides). */
  alerting?: FeatureStatus;
  /** "included from Fairway", from the catalog. */
  includedFrom?: string;
}) {
  return (
    <ChatChannelsBoard
      copy={TEAMS_COPY}
      organizationId={organizationId}
      destinations={destinations}
      clients={clients}
      canManage={canManage}
      alerting={alerting}
      includedFrom={includedFrom}
    />
  );
}
