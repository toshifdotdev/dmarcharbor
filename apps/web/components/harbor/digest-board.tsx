"use client";

/**
 * digest-board.tsx — the scheduled digests, with what each one does next.
 *
 * Per digest: the domain and its client, the schedule as a sentence, when it
 * goes next (the scheduler's own rule, worked out on the server) and when it
 * last went, who receives it, and whether forensic evidence rides along.
 *
 * Actions, in the order they are wanted:
 *   switch      pause or resume, effective at once
 *   Send now    sends this digest to every recipient immediately, confirmed
 *               first, and shows back the subject and text that went
 *   Edit        schedule, recipients, forensic evidence (the domain is fixed)
 *   Delete      confirmed; nothing already sent is recalled
 *
 * "Run the schedule now" asks the scheduler to do its pass for this workspace
 * immediately: digests that are due go out, the rest wait for their day. That
 * is what the endpoint does, so that is what the button says.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { patchReportDigest, removeReportDigest } from "@/lib/ops-client";
import { parseRecipients } from "@/lib/digest-schedule";
import { runAllReportDigests, sendReportDigestNow, type DigestSendResult } from "@/lib/notifications-client";
import type { ReportDigestRow } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Switch } from "@/components/ui/choice";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { RecipientsField, ScheduleFields, recipientsOk, type ScheduleValue } from "./digest-form";
import { ActionRefusal, type ActionError } from "./plan-refusal";

export interface DigestView extends ReportDigestRow {
  scheduleLabel: string;
  /** "now", a formatted instant, or null when paused. */
  nextLabel: string | null;
  lastSentLabel: string | null;
}

type Pending = { kind: "send"; digest: DigestView } | { kind: "delete"; digest: DigestView } | { kind: "run" } | null;

export function DigestBoard({
  organizationId,
  digests,
  forensicsOnPlan,
}: {
  organizationId: string;
  digests: DigestView[];
  forensicsOnPlan: boolean;
}) {
  const router = useRouter();
  const [toggling, setToggling] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: ActionError } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ domain: string; result: DigestSendResult } | null>(null);
  const [ran, setRan] = useState<{ processed: number; sent: number } | null>(null);
  const [editing, setEditing] = useState<DigestView | null>(null);

  async function toggle(d: DigestView, next: boolean) {
    setToggling(d.id);
    setRowError(null);
    const res = await patchReportDigest(organizationId, d.id, { enabled: next });
    setToggling(null);
    if (!res.ok) {
      setRowError({ id: d.id, error: res.error });
      return;
    }
    router.refresh();
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setConfirmError(null);
    if (pending.kind === "send") {
      const res = await sendReportDigestNow(organizationId, pending.digest.id);
      setBusy(false);
      if (!res.ok) {
        setConfirmError(res.error.message ?? "The digest could not be built.");
        return;
      }
      setSent({ domain: pending.digest.domain.name, result: res.data });
    } else if (pending.kind === "delete") {
      const res = await removeReportDigest(organizationId, pending.digest.id);
      setBusy(false);
      if (!res.ok) {
        setConfirmError(res.error.message ?? "The digest could not be deleted.");
        return;
      }
    } else {
      const res = await runAllReportDigests(organizationId);
      setBusy(false);
      if (!res.ok) {
        setConfirmError(res.error.message ?? "The schedule could not be run.");
        return;
      }
      setRan(res.data);
    }
    setPending(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {ran ? (
        <Notice tone="ok" title="The schedule ran" action={<Button size="sm" variant="ghost" onClick={() => setRan(null)}>Dismiss</Button>}>
          {ran.processed} digest{ran.processed === 1 ? "" : "s"} checked, {ran.sent} sent. The rest were not due yet.
        </Notice>
      ) : null}

      {digests.length === 0 ? (
        <div role="status" data-testid="state-empty" className="border-y border-rule py-6">
          <p className="text-body font-semibold text-fg">No digests scheduled yet</p>
          <p className="mt-1 max-w-[64ch] text-ui text-fg-2">
            Create the first with the form beside this: pick a domain, a day and an hour, and who should receive its
            summary. A weekly digest to the client&rsquo;s IT contact is the usual start.
          </p>
        </div>
      ) : (
        <>
          <ul className="hb-stagger flex flex-col border-y border-fg">
            {digests.map((d, i) => {
              const { valid } = parseRecipients(d.recipientEmails.join(","));
              return (
                <li
                  key={d.id}
                  data-digest-id={d.id}
                  style={{ "--i": Math.min(i, 10) } as React.CSSProperties}
                  className="grid gap-x-5 gap-y-2 border-b border-rule py-3 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                >
                  <div className="pt-0.5">
                    <Switch
                      checked={d.enabled}
                      onChange={(next) => toggle(d, next)}
                      label={`${d.enabled ? "Pause" : "Resume"} the digest for ${d.domain.name}`}
                      busy={toggling === d.id}
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <span className={d.enabled ? "data text-ui font-semibold text-fg" : "data text-ui font-semibold text-fg-3"}>
                        {d.domain.name}
                      </span>
                      <span className="text-meta text-fg-3">{d.domain.client.name}</span>
                      {!d.enabled ? <Badge tone="neutral">Paused</Badge> : null}
                      {d.includeForensics ? <Badge tone="warn" title="Recipients see failure detail from individual messages">Forensic evidence included</Badge> : null}
                    </p>
                    <p className="mt-0.5 text-ui text-fg-2">{d.scheduleLabel}</p>
                    <p className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-meta text-fg-3">
                      <span>
                        {d.nextLabel === null ? "Paused: not scheduled" : d.nextLabel === "now" ? <span className="font-semibold text-act">Due now</span> : `Next ${d.nextLabel}`}
                      </span>
                      <span>{d.lastSentLabel ? `Last sent ${d.lastSentLabel}` : "Not sent yet"}</span>
                    </p>
                    <p className="data mt-1 text-meta text-fg-2" title={valid.join(", ")}>
                      {valid.slice(0, 3).join(", ")}
                      {valid.length > 3 ? <span className="text-fg-3"> and {valid.length - 3} more</span> : null}
                    </p>
                    {rowError?.id === d.id ? <ActionRefusal error={rowError.error} className="mt-2" /> : null}
                  </div>
                  <div className="flex flex-wrap items-start gap-1">
                    <Button
                      size="sm"
                      onClick={() => {
                        setConfirmError(null);
                        setPending({ kind: "send", digest: d });
                      }}
                      data-testid={`send-digest-${d.id}`}
                    >
                      Send now
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(d)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setConfirmError(null);
                        setPending({ kind: "delete", digest: d });
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setConfirmError(null);
                setPending({ kind: "run" });
              }}
              data-testid="run-digests"
            >
              Run the schedule now
            </Button>
            <span className="text-meta text-fg-3">Sends whichever digests in this workspace are due; the rest wait for their day.</span>
          </div>
        </>
      )}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirm}
        busy={busy}
        error={confirmError}
        danger={pending?.kind === "delete"}
        testId={pending?.kind === "send" ? "send-digest" : pending?.kind === "delete" ? "delete-digest" : "run-digests"}
        title={
          pending?.kind === "send"
            ? `Send the ${pending.digest.domain.name} digest now?`
            : pending?.kind === "delete"
              ? `Delete the ${pending.digest.domain.name} digest?`
              : "Run the schedule now?"
        }
        confirmLabel={pending?.kind === "send" ? "Send to every recipient" : pending?.kind === "delete" ? "Delete digest" : "Run the schedule"}
        body={
          pending?.kind === "send" ? (
            <>
              It goes to all {pending.digest.recipientEmails.length} recipient{pending.digest.recipientEmails.length === 1 ? "" : "s"} straight away, outside the
              schedule. What was sent is shown afterwards.
            </>
          ) : pending?.kind === "delete" ? (
            "It stops being sent. Emails already sent are not recalled. To stop it for a while instead, pause it with its switch."
          ) : (
            "The scheduler's pass for this workspace runs now: every enabled digest that is due goes out. Digests not due today are left alone."
          )
        }
      />

      <Dialog open={sent !== null} onClose={() => setSent(null)} title="Digest sent" testId="digest-sent" footer={<Button onClick={() => setSent(null)}>Done</Button>}>
        {sent ? (
          <div className="flex flex-col gap-3">
            <p className="text-body text-fg-2">
              {sent.result.sent ? (
                <>
                  Sent to <span className="tnum font-semibold text-fg">{sent.result.recipients}</span> recipient
                  {sent.result.recipients === 1 ? "" : "s"} for <span className="data">{sent.domain}</span>.
                </>
              ) : (
                "The API built the digest but reported that it was not sent."
              )}
            </p>
            <div className="rounded-ctl border border-rule bg-paper-3">
              <p className="border-b border-rule px-3 py-2 text-ui">
                <span className="legend mr-2">Subject</span>
                <span className="font-semibold text-fg">{sent.result.subject}</span>
              </p>
              <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap px-3 py-2 font-[family-name:var(--font-ui)] text-meta text-fg-2">
                {sent.result.preview}
              </pre>
            </div>
          </div>
        ) : null}
      </Dialog>

      <EditDigest organizationId={organizationId} digest={editing} forensicsOnPlan={forensicsOnPlan} onClose={() => setEditing(null)} />
    </div>
  );
}

function EditDigest({
  organizationId,
  digest,
  forensicsOnPlan,
  onClose,
}: {
  organizationId: string;
  digest: DigestView | null;
  forensicsOnPlan: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleValue>({ frequency: "WEEKLY", sendHourUtc: 9, weekday: 1, dayOfMonth: 1 });
  const [recipients, setRecipients] = useState("");
  const [forensics, setForensics] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);

  if (digest && digest.id !== shownFor) {
    setShownFor(digest.id);
    setSchedule({ frequency: digest.frequency, sendHourUtc: digest.sendHourUtc, weekday: digest.weekday, dayOfMonth: digest.dayOfMonth });
    setRecipients(digest.recipientEmails.join(", "));
    setForensics(digest.includeForensics);
    setError(null);
  }

  async function save() {
    if (!digest || busy || !recipientsOk(recipients)) return;
    setBusy(true);
    setError(null);
    const res = await patchReportDigest(organizationId, digest.id, {
      ...schedule,
      recipientEmails: parseRecipients(recipients).valid,
      // Leaving forensic evidence on is allowed even if the plan lost it; it
      // can only be switched on where the plan carries it.
      includeForensics: forensicsOnPlan ? forensics : digest.includeForensics && forensics,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onClose();
    router.refresh();
  }

  return (
    <Dialog
      open={digest !== null}
      onClose={busy ? () => {} : onClose}
      title={digest ? `Edit the ${digest.domain.name} digest` : ""}
      testId="edit-digest"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!recipientsOk(recipients)} busy={busy} busyLabel="Saving">
            Save changes
          </Button>
        </>
      }
    >
      {digest ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex flex-col gap-3.5"
        >
          <ScheduleFields value={schedule} onChange={setSchedule} />
          <RecipientsField value={recipients} onChange={setRecipients} />
          <Checkbox
            checked={forensics}
            disabled={!forensicsOnPlan && !digest.includeForensics}
            onChange={(e) => setForensics(e.target.checked)}
            label="Include forensic evidence"
            hint={forensicsOnPlan ? "Every recipient sees failure detail from individual messages." : "Forensic evidence is not available on your current plan."}
          />
          <ActionRefusal error={error} />
        </form>
      ) : null}
    </Dialog>
  );
}
