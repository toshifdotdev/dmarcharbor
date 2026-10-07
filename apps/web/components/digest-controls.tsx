"use client";

import { useState } from "react";
import {
  runAllReportDigests,
  sendReportDigestNow,
  type DigestSendResult,
} from "@/lib/notifications-client";
import { ConfirmAction } from "@/components/confirm-action";

/**
 * Sending a digest now, and running every digest.
 *
 * Both endpoints existed with no control anywhere in the interface, which left
 * the only way to prove a digest works as configuring it and waiting for the
 * scheduler. That is a bad first experience for a feature someone has just
 * subscribed to, and it is invisible: nothing says a digest was never tested.
 *
 * "Send now" renders the email it is about to send first. A digest goes to every
 * address on it, so the preview is the difference between checking the content
 * and taking it on trust.
 */
export function DigestRunControls({
  organizationId,
  digestId,
  digestLabel,
}: {
  organizationId: string;
  digestId: string;
  digestLabel: string;
}) {
  const [preview, setPreview] = useState<DigestSendResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendNow() {
    setBusy(true);
    const result = await sendReportDigestNow(organizationId, digestId);
    setBusy(false);

    if (!result.ok) {
      setFailed(result.error.message ?? "The digest could not be built.");
      return;
    }
    setFailed(null);
    setPreview(result.data);
    setNotice(
      `Sent to ${result.data.recipients} recipient${result.data.recipients === 1 ? "" : "s"}.`,
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ConfirmAction
        label={`Send "${digestLabel}" now`}
        confirmLabel="Send to every recipient on this digest"
        consequence="Sends the current contents immediately rather than waiting for the schedule, to every address on this digest."
        onConfirm={sendNow}
        busy={busy}
      />

      {notice ? (
        <p className="text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          {notice}
        </p>
      ) : null}
      {failed ? (
        <p className="text-[13px]" style={{ color: "var(--color-danger, #b4232a)" }}>
          {failed}
        </p>
      ) : null}

      {preview ? (
        <div className="mt-1 border p-3" style={{ borderColor: "var(--color-line)" }}>
          <p className="text-[12px] font-semibold" style={{ color: "var(--color-ink-3)" }}>
            WHAT WAS SENT
          </p>
          <p className="mt-1 text-[13px] font-semibold">{preview.subject}</p>
          <pre
            className="mt-2 max-h-64 overflow-auto text-[12px] whitespace-pre-wrap"
            style={{ color: "var(--color-ink-2)" }}
          >
            {preview.preview}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Runs every enabled digest for the account.
 *
 * Account-wide, not workspace-wide: the endpoint takes an organization id but
 * reports across every workspace it can find, so the button says so rather than
 * implying it is scoped to the workspace the reader happens to be in.
 */
export function RunAllDigestsButton({ organizationId }: { organizationId: string }) {
  const [outcome, setOutcome] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    const result = await runAllReportDigests(organizationId);
    setBusy(false);

    if (!result.ok) {
      setFailed(result.error.message ?? "The digests could not be run.");
      return;
    }
    setFailed(null);
    setOutcome(
      `Processed ${result.data.processed} digest${result.data.processed === 1 ? "" : "s"}, sent ${result.data.sent}.`,
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ConfirmAction
        label="Run all digests now"
        confirmLabel="Send every enabled digest, across all workspaces"
        consequence="Sends every enabled digest immediately, for every workspace on the account."
        onConfirm={run}
        busy={busy}
      />
      {outcome ? (
        <p className="text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          {outcome}
        </p>
      ) : null}
      {failed ? (
        <p className="text-[13px]" style={{ color: "var(--color-danger, #b4232a)" }}>
          {failed}
        </p>
      ) : null}
    </div>
  );
}