"use client";

/**
 * slack-client.tsx — Slack alerts.
 *
 * Three things this form must get right, from the brief:
 *
 * 1. The API never returns the webhook URL — maskedUrl is the host plus its
 *    last four characters. There is NOTHING to fetch into an edit form, so
 *    editing means the owner pastes a new URL and the PUT accepts it. The form
 *    never claims otherwise.
 * 2. consecutiveFailures and lastError are surfaced above everything else, so
 *    a broken webhook is visible before anyone wonders why alerts went quiet.
 * 3. Most people who reach this screen have never seen the word "webhook", so
 *    the form explains what it is, where to get one in Slack, that the URL is
 *    a CREDENTIAL (anyone holding it can post to that channel), and that they
 *    can revoke it in Slack.
 *
 * There is no 402 on this: it is the same notification an email alert already
 * produces, delivered where the team already watches.
 */

import { ActionButton } from "@/components/action-button";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  deleteSlackDestination,
  patchSlackDestinationEnabled,
  putSlackDestination,
} from "@/lib/ops-client";
import type { ApiErrorBody, SlackDestination } from "@/lib/types";

export function SlackForm({
  organizationId,
  destination,
}: {
  organizationId: string;
  destination: SlackDestination | null;
}) {
  const router = useRouter();
  const [webhookUrl, setWebhookUrl] = useState("");
  const [channelLabel, setChannelLabel] = useState(destination?.channelLabel ?? "");
  const [enabled, setEnabled] = useState(destination?.enabled ?? true);
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const failing = (destination?.consecutiveFailures ?? 0) > 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await putSlackDestination(organizationId, {
      webhookUrl,
      channelLabel: channelLabel.trim() || null,
    });
    setBusy(false);
    // The URL is a credential: clear it from component state the moment it has
    // been delivered. The API never echoes it back.
    setWebhookUrl("");
    if (!res.ok) setError(res.error);
    else {
      setNote("Slack destination saved.");
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Delivery health FIRST: a broken webhook must be visible before anyone
          wonders why alerts went quiet. */}
      {destination ? (
        failing || destination.lastError ? (
          <div
            role="alert"
            data-testid="slack-failures"
            className="rounded-[2px] border px-4 py-3"
            style={{
              borderColor: "var(--color-block)",
              background: "var(--color-block-soft)",
            }}
          >
            <p
              className="num text-[11px] font-semibold tracking-[0.12em] uppercase"
              style={{ color: "var(--color-block)" }}
            >
              Delivery failing · {destination.consecutiveFailures} consecutive failure
              {destination.consecutiveFailures === 1 ? "" : "s"}
            </p>
            {destination.lastError ? (
              <p className="mt-1.5 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                {destination.lastError}
              </p>
            ) : null}
            <p className="mt-1.5 text-[12px]" style={{ color: "var(--color-ink-3)" }}>
              Alerts raised by your rules are not reaching Slack. Paste a fresh
              webhook URL below: the old one may have been revoked in Slack.
            </p>
          </div>
        ) : (
          <div
            data-testid="slack-health"
            className="rounded-[2px] border px-4 py-3"
            style={{
              borderColor: "var(--color-line-strong)",
              background: "var(--color-surface)",
            }}
          >
            <p className="num text-[11px] tracking-[0.12em] uppercase" style={{ color: "var(--color-ink-3)" }}>
              Delivery healthy
            </p>
            <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
              Last delivered{" "}
              {destination.lastDeliveredAt
                ? new Date(destination.lastDeliveredAt).toLocaleString("en-GB")
                : "(nothing delivered yet)"}
              {destination.channelLabel ? ` to ${destination.channelLabel}` : ""}.
            </p>
          </div>
        )
      ) : null}

      <section
        className="lift rounded-[2px] border p-5"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      >
        <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
          Send alerts to Slack
        </h2>

        <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--color-ink-2)" }}>
          This delivers <strong style={{ color: "var(--color-ink)" }}>the same
          alerts your email rules already raise</strong> into a Slack channel,
          where your team already watches. It needs no extra plan.
        </p>

        <div
          className="mt-4 rounded-[2px] border p-4"
          style={{ borderColor: "var(--color-line-strong)", background: "var(--color-raised)" }}
        >
          <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--color-ink-2)" }}>
            <strong style={{ color: "var(--color-ink)" }}>What a webhook URL is,
            and where to get one.</strong> A webhook is an address Slack gives a
            channel so other tools can post into it. To create one:
          </p>
          <ol className="mt-2.5 flex flex-col gap-1.5 text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
            <li>1 · In Slack, open the channel alerts should arrive in.</li>
            <li>2 · Integrations → Incoming Webhooks → Add to Slack.</li>
            <li>3 · Copy the Webhook URL it gives you and paste it below.</li>
          </ol>
          <p className="mt-3 text-[12.5px] leading-relaxed" style={{ color: "var(--color-unverified)" }}>
            <strong>Treat that URL like a password.</strong> Anyone who has it can
            post to that channel, so paste it only somewhere you trust. You can
            revoke it at any time in the same Slack screen: and if you do, paste
            a fresh one here.
          </p>
        </div>

        {error ? (
          <p
            role="alert"
            data-testid="slack-error"
            className="mt-4 text-[13px]"
            style={{ color: "var(--color-block)" }}
          >
            {error.code === "INVALID_WEBHOOK_URL"
              ? "That doesn't look like a Slack webhook URL. It should start with https://hooks.slack.com/services/: copy the full Webhook URL from the Incoming Webhooks screen in Slack and paste it here."
              : error.message}
          </p>
        ) : null}
        {note ? (
          <p role="status" className="mt-4 text-[13px]" style={{ color: "var(--color-pass)" }}>
            {note}
          </p>
        ) : null}

        <form onSubmit={save} className="mt-4 flex flex-col gap-4">
          <div>
            <div className="label">
              {destination ? "Replace the webhook URL" : "Webhook URL"}
            </div>
            {destination ? (
              <p className="mt-1 text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                Currently connected:{" "}
                <span className="num" data-testid="slack-masked">
                  {destination.maskedUrl}
                </span>
                . The full URL is stored securely and cannot be shown again. To
                change it, paste a new one below.
              </p>
            ) : (
              <p className="mt-1 text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                Paste the full Webhook URL from Slack.
              </p>
            )}
            <input
              type="password"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://hooks.slack.com/services/…"
              required
              data-testid="slack-webhook"
              className="mt-2 w-full rounded-[2px] border px-3.5 py-2.5 text-[13.5px] outline-none"
              style={{
                background: "var(--color-elevate)",
                borderColor: "var(--color-line-strong)",
                color: "var(--color-ink)",
              }}
            />
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div>
              <div className="label">Channel label (for your reference)</div>
              <input
                value={channelLabel}
                onChange={(e) => setChannelLabel(e.target.value)}
                placeholder="#security-alerts"
                data-testid="slack-label"
                className="mt-2 rounded-[2px] border px-3.5 py-2.5 text-[13.5px] outline-none"
                style={{
                  background: "var(--color-elevate)",
                  borderColor: "var(--color-line-strong)",
                  color: "var(--color-ink)",
                }}
              />
            </div>

            {destination ? (
              <label className="flex items-center gap-2 pb-2.5 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={async (e) => {
                    setEnabled(e.target.checked);
                    await patchSlackDestinationEnabled(organizationId, e.target.checked);
                    router.refresh();
                  }}
                  data-testid="slack-enabled"
                />
                delivery enabled
              </label>
            ) : null}

            <ActionButton
              type="submit"
              label={destination ? "Replace webhook" : "Connect Slack"}
              loadingLabel={"Saving…"}
              busy={busy}
              disabled={!webhookUrl.trim()}
              testId="slack-save"
            />

            {destination ? (
              <button
                type="button"
                onClick={async () => {
                  await deleteSlackDestination(organizationId);
                  router.refresh();
                }}
                className="pb-2.5 text-[12px] underline"
                style={{ color: "var(--color-block)" }}
                data-testid="slack-delete"
              >
                disconnect
              </button>
            ) : null}
          </div>
        </form>
      </section>
    </div>
  );
}
