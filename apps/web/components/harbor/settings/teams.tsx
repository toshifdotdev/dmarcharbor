"use client";

/**
 * teams.tsx — one Microsoft Teams channel that receives the alerts your rules
 * raise.
 *
 * Laid out like Slack, so the two read as one product: the line at the top
 * says whether alerts are getting through, the record below it is the masked
 * address and the last delivery, and the test message sits beside them because
 * a Workflows setup fails silently until a real alert does not arrive.
 *
 * **The address is the credential**, exactly as Slack's is: whoever holds it can
 * post into the channel, with no token and no revocation short of deleting the
 * flow in Teams. So it goes in, is stored encrypted, and never comes back — the
 * field is uncontrolled, clears on save, and the page shows only the masked form
 * the API returns.
 *
 * **Why the copy is so specific.** Teams does not accept a webhook you can make
 * from the channel's own settings any more. Microsoft retired the Office 365
 * connector in May 2026, so the address now comes from a Power Automate flow
 * created from a named template. The steps are spelled out beside the form,
 * and the bot that messages appear from is named so nobody thinks it is
 * phishing.
 *
 * Test hooks: teams-webhook, teams-label, teams-save, teams-masked, teams-error,
 * teams-test, teams-test-result, teams-remove.
 */

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import {
  deleteTeamsDestination,
  patchTeamsDestinationEnabled,
  putTeamsDestination,
  testTeamsDestination,
} from "@/lib/ops-client";
import type { TeamsDestination } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/choice";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { KeyValue, Notice } from "@/components/ui/notice";
import { useToast } from "@/components/ui/toast";
import { ConnectionLine, SetupSteps, type LineState } from "./lines";
import { Panel } from "./parts";

/** The API's reasons, as guidance. Never the code itself. */
function teamsMessage(code: string | undefined, apiMessage: string | undefined): string {
  // A refusal the API explained in words is shown as it wrote it: those
  // sentences name the actual problem (old connector address, wrong host, wrong
  // path), and rewriting them here would lose that.
  if (apiMessage && !/^[A-Z_]+$/.test(apiMessage)) {
    return apiMessage;
  }

  if (code === "LEGACY_WEBHOOK_URL") {
    return "That is an old Teams connector address, which Microsoft switched off in May 2026. In the Teams channel choose ⋯ › Workflows › 'Post to a channel when a webhook request is received' and paste the address it gives you.";
  }

  if (code === "INVALID_WEBHOOK_URL") {
    return "That is not a Teams Workflows address. It must start with https:// and be on logic.azure.com or environment.api.powerplatform.com.";
  }

  return "The Teams address could not be saved. Nothing changed.";
}

export function TeamsBoard({
  organizationId,
  destination,
  canManage,
  lastDeliveredLabel,
}: {
  organizationId: string;
  destination: TeamsDestination | null;
  canManage: boolean;
  lastDeliveredLabel: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const form = useRef<HTMLFormElement | null>(null);
  const urlInput = useRef<HTMLInputElement | null>(null);
  const [channel, setChannel] = useState(destination?.channelLabel ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [enabled, setEnabled] = useState(destination?.enabled ?? false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const webhookUrl = urlInput.current?.value.trim() ?? "";
    if (busy) return;
    setBusy(true);
    setError(null);
    setTestResult(null);
    const res = await putTeamsDestination(organizationId, {
      webhookUrl,
      channelLabel: channel.trim() || null,
    });
    setBusy(false);
    // The address leaves the page whatever happened: a refused one is pasted again.
    if (urlInput.current) urlInput.current.value = "";
    if (!res.ok) {
      setError(teamsMessage(res.error.code, res.error.message));
      return;
    }
    form.current?.reset();
    setEnabled(res.data.enabled);
    toast({
      title: "Teams destination saved",
      body: `Alerts go to ${res.data.channelLabel ?? "the channel"} from the next one raised. Send a test message to be sure.`,
      tone: "ok",
    });
    router.refresh();
  }

  async function toggle(next: boolean) {
    setToggleBusy(true);
    setError(null);
    const res = await patchTeamsDestinationEnabled(organizationId, next);
    setToggleBusy(false);
    if (!res.ok) {
      setError(res.error.message ?? "The change did not go through.");
      return;
    }
    setEnabled(next);
    router.refresh();
  }

  async function remove() {
    setRemoveBusy(true);
    const res = await deleteTeamsDestination(organizationId);
    setRemoveBusy(false);
    if (!res.ok) {
      setError(res.error.message ?? "The destination could not be removed.");
      setRemoveOpen(false);
      return;
    }
    setRemoveOpen(false);
    toast({ title: "Teams destination removed", tone: "ok" });
    router.refresh();
  }

  async function sendTest() {
    setTestBusy(true);
    setTestResult(null);
    const res = await testTeamsDestination(organizationId);
    setTestBusy(false);
    if (!res.ok) {
      setTestResult(
        res.error.message && !/^[A-Z_]+$/.test(res.error.message)
          ? res.error.message
          : "The test message could not be sent. Nothing else changed.",
      );
      return;
    }
    setTestResult(
      res.data.delivered
        ? "Sent. Check the channel: the message comes from Workflows."
        : `Microsoft refused the message: ${res.data.error ?? "no reason given"}. Check that the flow is turned on and that the address is the one this flow gave you.`,
    );
    router.refresh();
  }

  const failures = destination?.consecutiveFailures ?? 0;
  const state: LineState = !destination ? "none" : failures > 0 ? "failing" : enabled ? "live" : "paused";
  const word = { none: "Not connected", failing: "Failing", live: "Delivering", paused: "Paused", unknown: "Unknown" }[state];
  const detail =
    state === "none"
      ? "Alerts go by email, and to Slack if it is connected."
      : state === "failing"
        ? `Microsoft refused the last ${failures === 1 ? "attempt" : `${failures} attempts in a row`}.`
        : state === "paused"
          ? "Switched off here: nothing is sent to Teams until it is on again."
          : lastDeliveredLabel
            ? `Last alert delivered ${lastDeliveredLabel}.`
            : "Connected. Nothing delivered yet: send a test message to be sure the flow works.";

  return (
    <div className="flex flex-col gap-10">
      <section aria-label="Microsoft Teams status" className="flex flex-col gap-4">
        <ConnectionLine
          state={state}
          word={word}
          detail={detail}
          label={
            destination
              ? `Alert rules to ${destination.channelLabel ?? "the Teams channel"} through Workflows: ${word.toLowerCase()}.`
              : "Alert rules to Microsoft Teams: not connected."
          }
          aside={
            destination && canManage ? (
              <>
                <Switch checked={enabled} onChange={toggle} busy={toggleBusy} label="Send alerts to Microsoft Teams" />
                <span className="text-ui font-medium text-fg-2">{enabled ? "On" : "Off"}</span>
              </>
            ) : null
          }
          from={{ name: "Alert rules", kind: "every alert they raise" }}
          via={{ name: "Workflows", kind: "a Power Automate flow" }}
          to={
            destination
              ? { name: destination.channelLabel ?? "Teams channel", kind: "Microsoft Teams" }
              : { name: "Teams channel", kind: "not connected" }
          }
        />
        {destination ? (
          <KeyValue
            labelWidth={140}
            rows={[
              [
                "Address",
                <code key="m" data-testid="teams-masked" className="data break-all text-fg">
                  {destination.maskedUrl}
                </code>,
              ],
              ["Sends", "Every alert a rule raises, as well as to its email recipients and to Slack, if that is connected."],
              ["Last delivered", lastDeliveredLabel ?? <span className="text-fg-3">nothing delivered yet</span>],
              failures > 0
                ? [
                    "Refused",
                    <span key="f" className="text-fail">
                      {failures} attempt{failures === 1 ? "" : "s"} in a row
                      {destination.lastError ? `: ${destination.lastError}` : ""}
                    </span>,
                  ]
                : null,
            ]}
          />
        ) : null}
        {failures > 0 ? (
          <Notice tone="warn" title="Microsoft is refusing the messages">
            The flow may have been turned off, the template replaced, or the address regenerated. Paste the current address
            below; saving resets the failure count.
          </Notice>
        ) : null}
        {destination && canManage ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button variant="secondary" busy={testBusy} busyLabel="Sending a test message" onClick={sendTest} data-testid="teams-test">
              Send test message
            </Button>
            <p className="min-w-0 flex-1 text-meta text-fg-3" data-testid="teams-test-result">
              {testResult ?? "A test is the only way to know the flow is working before a real alert depends on it."}
            </p>
          </div>
        ) : null}
      </section>

      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
        <Panel
          id="teams-set"
          title={destination ? "Replace the address" : "Connect a channel"}
          why={
            <>
              The address comes from a Teams Workflows flow made from the template{" "}
              <span className="font-semibold">&ldquo;Post to a channel when a webhook request is received&rdquo;</span>. The
              steps are beside this form.
            </>
          }
        >
          <div className="flex flex-col gap-2 text-ui text-fg-2">
            <p>
              Messages appear from <span className="font-semibold text-fg">Workflows</span>, a Microsoft bot. That is
              expected: Teams does not let the sender name or picture be changed.
            </p>
            <p>
              The address is a password. Anyone who has it can post to the channel, and there is no way to tell who sent
              what. If it leaks, delete the flow in Teams and create a new one.
            </p>
          </div>
          {canManage ? (
            <form ref={form} onSubmit={save} className="mt-2 grid max-w-[640px] gap-4">
              <Field
                label="Workflows address"
                hint="Starts with https:// and ends with logic.azure.com or environment.api.powerplatform.com. Stored encrypted; only the host and the last four characters are ever shown."
              >
                <Input
                  ref={urlInput}
                  type="text"
                  mono
                  name="webhookUrl"
                  defaultValue=""
                  required
                  placeholder="https://prod-00.westus.logic.azure.com/workflows/…"
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="teams-webhook"
                />
              </Field>
              <Field label="Channel name" hint="For your reference on this page. Teams decides the channel from the address.">
                <Input
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  placeholder="Alerts"
                  maxLength={80}
                  data-testid="teams-label"
                />
              </Field>
              {error ? (
                <p role="alert" data-testid="teams-error" className="text-ui font-medium text-fail">
                  {error}
                </p>
              ) : null}
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  busy={busy}
                  busyLabel="Saving the Teams destination"
                  data-testid="teams-save"
                >
                  {destination ? "Replace address" : "Connect Teams"}
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-ui text-fg-2">An owner or admin can connect or change the Teams channel.</p>
          )}
        </Panel>

        <SetupSteps
          title="Getting the address from Teams"
          done={Boolean(destination)}
          className="lg:pt-1"
          steps={[
            { key: "open", name: "Open ⋯ › Workflows", detail: "In the Teams channel the alerts should go to." },
            {
              key: "template",
              name: "Choose the webhook template",
              detail: "“Post to a channel when a webhook request is received”.",
            },
            { key: "save", name: "Pick the team and channel", detail: "Then save the flow and leave it turned on." },
            { key: "paste", name: "Paste the address here", detail: "The flow shows it once it is saved." },
          ]}
        />
      </div>

      {destination && canManage ? (
        <section aria-labelledby="teams-stop" className="flex flex-col gap-2 border-t border-rule pt-5">
          <h2 id="teams-stop" className="text-h3 font-bold tracking-[-0.01em] text-fg">
            Stop using Microsoft Teams
          </h2>
          <p className="text-ui text-fg-2">Alerts stop going to Teams and the stored address is deleted. Email and Slack carry on as before.</p>
          <div>
            <Button variant="secondary" onClick={() => setRemoveOpen(true)} data-testid="teams-remove">
              Remove Teams destination
            </Button>
          </div>
        </section>
      ) : null}

      <ConfirmDialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        onConfirm={remove}
        title="Remove the Teams destination?"
        body={
          <p>
            Alerts stop going to Teams at once. The stored address is deleted; connecting again needs a new address from
            the flow.
          </p>
        }
        confirmLabel="Remove destination"
        busy={removeBusy}
        danger
      />
    </div>
  );
}
