"use client";

/**
 * slack.tsx — one Slack channel that receives the alerts your rules raise.
 *
 * Read in the order an MSP checks it: is it connected and getting through (the
 * line at the top, with the state in a word), what it holds (the masked
 * webhook and the last delivery, which is the only proof alerts arrive), then
 * how to connect or replace it, with Slack's own steps drawn beside the form.
 *
 * The webhook URL is the credential: whoever holds it can post into the
 * channel. So it goes in, is stored encrypted, and never comes back: the
 * field is uncontrolled (no value attribute is ever written into the page),
 * clears on save, and the page shows only the masked form the API returns.
 *
 * There is no test-send endpoint, so the page does not pretend to have one;
 * "last delivered" is the proof that alerts get through.
 *
 * Plan: connecting, replacing and switching on need alerts.email. On a plan
 * without it the form is not offered at all: the upgrade notice says which
 * plan carries it, and a kept destination stays listed as paused, with its
 * removal, because removing is allowed on every plan.
 *
 * Test hooks: slack-webhook, slack-label, slack-save, slack-masked, slack-error, slack-test, slack-test-result;
 * the plan gate is the UpgradeNotice carrying data-feature="alerts.email".
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { deleteSlackDestination, patchSlackDestinationEnabled, putSlackDestination, testSlackDestination } from "@/lib/ops-client";
import type { FeatureStatus } from "@/lib/entitlements";
import type { SlackDestination } from "@/lib/types";
import { ActionRefusal, isPlanRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/choice";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { KeyValue, Notice } from "@/components/ui/notice";
import { UpgradeNotice } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { ConnectionLine, SetupSteps, type LineState } from "./lines";
import { Panel } from "./parts";

/** The API's reasons, as guidance. Never the code itself. */
function slackMessage(code: string | undefined, apiMessage: string | undefined): string {
  if (code === "INVALID_WEBHOOK_URL" || code === "REQUEST_FAILED" || code === "400") {
    const reason = apiMessage && !/^[A-Z_]+$/.test(apiMessage) ? apiMessage : "That is not a Slack webhook URL.";
    return `${reason} Paste the webhook URL exactly as Slack's Incoming Webhooks page shows it: it starts with https://hooks.slack.com/services/.`;
  }
  return apiMessage ?? "The Slack webhook could not be saved. Nothing changed.";
}

export function SlackBoard({
  organizationId,
  destination,
  canManage,
  lastDeliveredLabel,
  alerting = null,
  includedFrom = "included on a higher plan",
}: {
  organizationId: string;
  destination: SlackDestination | null;
  canManage: boolean;
  lastDeliveredLabel: string | null;
  /** alerts.email on this plan; null when the plan could not be read (the API decides). */
  alerting?: FeatureStatus;
  /** "included from Fairway", from the catalog. */
  includedFrom?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const form = useRef<HTMLFormElement | null>(null);
  const urlInput = useRef<HTMLInputElement | null>(null);
  const [channel, setChannel] = useState(destination?.channelLabel ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<ActionError | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [enabled, setEnabled] = useState(destination?.enabled ?? false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const offPlan = alerting === false;

  async function sendTest() {
    setTestBusy(true);
    setTestResult(null);
    const res = await testSlackDestination(organizationId);
    setTestBusy(false);
    if (!res.ok) {
      if (isPlanRefusal(res.error)) {
        setPlanError(res.error);
        return;
      }
      setTestResult(
        res.error.message && !/^[A-Z_]+$/.test(res.error.message)
          ? res.error.message
          : "The test message could not be sent. Nothing else changed.",
      );
      return;
    }
    setTestResult(
      res.data.delivered
        ? "Sent. Check the channel: the message comes from the app the webhook belongs to."
        : `Slack refused the message: ${res.data.error ?? "no reason given"}. The webhook may have been removed, or the channel archived.`,
    );
    router.refresh();
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const webhookUrl = urlInput.current?.value.trim() ?? "";
    if (busy || offPlan) return;
    setBusy(true);
    setError(null);
    setPlanError(null);
    const res = await putSlackDestination(organizationId, { webhookUrl, channelLabel: channel.trim() || null });
    setBusy(false);
    // The URL leaves the page whatever happened: a refused one is pasted again.
    if (urlInput.current) urlInput.current.value = "";
    if (!res.ok) {
      if (isPlanRefusal(res.error)) setPlanError(res.error);
      else setError(slackMessage(res.error.code, res.error.message));
      return;
    }
    form.current?.reset();
    setEnabled(res.data.enabled);
    toast({ title: "Slack destination saved", body: `Alerts go to ${res.data.channelLabel ?? "the channel"} from the next one raised.`, tone: "ok" });
    router.refresh();
  }

  async function toggle(next: boolean) {
    setToggleBusy(true);
    setError(null);
    setPlanError(null);
    const res = await patchSlackDestinationEnabled(organizationId, next);
    setToggleBusy(false);
    if (!res.ok) {
      if (isPlanRefusal(res.error)) setPlanError(res.error);
      else setError(res.error.message ?? "The change did not go through.");
      return;
    }
    setEnabled(next);
    router.refresh();
  }

  async function remove() {
    setRemoveBusy(true);
    const res = await deleteSlackDestination(organizationId);
    setRemoveBusy(false);
    if (!res.ok) {
      setError(res.error.message ?? "The destination could not be removed.");
      setRemoveOpen(false);
      return;
    }
    setRemoveOpen(false);
    toast({ title: "Slack destination removed", tone: "ok" });
    router.refresh();
  }

  const failures = destination?.consecutiveFailures ?? 0;
  const state: LineState = !destination
    ? "none"
    : offPlan
      ? "paused"
      : failures > 0
        ? "failing"
        : enabled
          ? "live"
          : "paused";
  const word = { none: "Not connected", failing: "Failing", live: "Delivering", paused: "Paused", unknown: "Unknown" }[state];
  const detail =
    state === "none"
      ? offPlan
        ? `Slack alerts are ${includedFrom}.`
        : "Alerts go by email only."
      : offPlan
        ? `Kept, not sent on this plan: Slack alerts are ${includedFrom}.`
        : state === "failing"
          ? `Slack refused the last ${failures === 1 ? "attempt" : `${failures} attempts in a row`}.`
          : state === "paused"
            ? "Switched off here: nothing is sent to Slack until it is on again."
            : lastDeliveredLabel
              ? `Last alert delivered ${lastDeliveredLabel}.`
              : "Connected. No alert has been raised since, so nothing has been delivered yet.";

  return (
    <div className="flex flex-col gap-10">
      {offPlan ? (
        <UpgradeNotice
          feature="alerts.email"
          message={`Slack alerts are not included in this workspace's plan. They are ${includedFrom}.`}
          context={
            destination
              ? "The channel you connected is kept, but nothing is sent to it on this plan. You can still remove it below; upgrading starts delivery again without pasting the webhook again."
              : "Nothing is connected, and nothing about this workspace changes."
          }
        />
      ) : null}
      <section aria-label="Slack status" className="flex flex-col gap-4">
        <ConnectionLine
          state={state}
          word={word}
          detail={detail}
          label={
            destination
              ? `Alert rules to ${destination.channelLabel ?? "the Slack channel"}: ${word.toLowerCase()}.`
              : "Alert rules to Slack: not connected."
          }
          aside={
            destination && canManage && !offPlan ? (
              <>
                <Switch checked={enabled} onChange={toggle} busy={toggleBusy} label="Send alerts to Slack" />
                <span className="text-ui font-medium text-fg-2">{enabled ? "On" : "Off"}</span>
              </>
            ) : null
          }
          from={{ name: "Alert rules", kind: "every alert they raise" }}
          to={
            destination
              ? { name: destination.channelLabel ?? "Slack channel", kind: "Slack, by incoming webhook" }
              : { name: "Slack channel", kind: "not connected" }
          }
        />
        {destination ? (
          <KeyValue
            labelWidth={140}
            rows={[
              [
                "Webhook",
                <code key="m" data-testid="slack-masked" className="data break-all text-fg">
                  {destination.maskedUrl}
                </code>,
              ],
              ["Sends", "Every alert a rule raises, as it is raised, as well as to the rule's email recipients."],
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
        {failures > 0 && !offPlan ? (
          <Notice tone="warn" title="Slack is refusing the alerts">
            The webhook may have been removed in Slack, or the channel archived. Paste a fresh webhook URL below; saving
            resets the failure count.
          </Notice>
        ) : null}
        <ActionRefusal error={planError} />
        {destination && canManage && !offPlan ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button variant="secondary" busy={testBusy} busyLabel="Sending a test message" onClick={sendTest} data-testid="slack-test">
              Send test message
            </Button>
            <p className="min-w-0 flex-1 text-meta text-fg-3" data-testid="slack-test-result">
              {testResult ?? (
                <>
                  A test is the only way to know the webhook works before a real{" "}
                  <Link href="/alerts" className="link">
                    alert
                  </Link>{" "}
                  depends on it.
                </>
              )}
            </p>
          </div>
        ) : null}
        {error && offPlan ? (
          <p role="alert" data-testid="slack-error" className="text-ui font-medium text-fail">
            {error}
          </p>
        ) : null}
      </section>

      {offPlan ? null : (
      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
        <Panel
          id="slack-set"
          title={destination ? "Replace the webhook" : "Connect a channel"}
          why={
            destination
              ? "Paste a new webhook URL to move the alerts to another channel, or to recover from a removed webhook."
              : "One channel per workspace. Alerts keep going by email either way."
          }
        >
          {canManage ? (
            <form ref={form} onSubmit={save} className="grid max-w-[640px] gap-4">
              <Field
                label="Webhook URL"
                hint="Treat it like a password: it is a credential that lets anyone holding it post to the channel. It is stored encrypted and only its last four characters are ever shown."
              >
                <Input
                  ref={urlInput}
                  type="text"
                  mono
                  name="webhookUrl"
                  defaultValue=""
                  required
                  placeholder="https://hooks.slack.com/services/…"
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="slack-webhook"
                />
              </Field>
              <Field label="Channel name" hint="For your reference on this page. Slack decides the channel from the URL.">
                <Input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="#security-alerts" maxLength={80} data-testid="slack-label" />
              </Field>
              {error ? (
                <p role="alert" data-testid="slack-error" className="text-ui font-medium text-fail">
                  {error}
                </p>
              ) : null}
              <div>
                <Button type="submit" variant="primary" busy={busy} busyLabel="Saving the Slack destination" data-testid="slack-save">
                  {destination ? "Replace webhook" : "Connect Slack"}
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-ui text-fg-2">An owner or admin can connect or change the Slack channel.</p>
          )}
        </Panel>

        <SetupSteps
          title="Getting the URL from Slack"
          done={Boolean(destination)}
          className="lg:pt-1"
          steps={[
            { key: "app", name: "Open the Incoming Webhooks app", detail: "In Slack, from the workspace's apps." },
            { key: "add", name: "Choose Add to Slack", detail: "Pick the channel the alerts should land in." },
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
          ]}
        />
      </div>
      )}

      {destination && canManage ? (
        <section aria-labelledby="slack-stop" className="flex flex-col gap-2 border-t border-rule pt-5">
          <h2 id="slack-stop" className="text-h3 font-bold tracking-[-0.01em] text-fg">
            Stop using Slack
          </h2>
          <p className="text-ui text-fg-2">Alerts stop going to Slack and the stored webhook is deleted. Email alerts carry on as before.</p>
          <div>
            <Button variant="secondary" onClick={() => setRemoveOpen(true)}>
              Remove Slack destination
            </Button>
          </div>
        </section>
      ) : null}

      <ConfirmDialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        onConfirm={remove}
        title="Remove the Slack destination?"
        body={<p>Alerts stop going to Slack at once. The stored webhook is deleted; connecting again needs the URL again.</p>}
        confirmLabel="Remove destination"
        busy={removeBusy}
        danger
      />
    </div>
  );
}
