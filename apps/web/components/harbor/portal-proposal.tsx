"use client";

/**
 * portal-proposal.tsx — a request to tighten the domain's protection, as the
 * client reads it, with their approve and decline.
 *
 * The reader carries the risk and is rarely technical, so the card says what
 * changes for fake mail, what could happen to their own mail, and what the
 * agency is relying on, all in sentences the API wrote. The record itself is
 * tucked away for whoever handles their IT. Approving asks once more, in
 * words, because it is the one choice here that can stop real mail.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PortalPolicyProposal } from "@/lib/types";
import { decidePolicyProposal } from "@/lib/ops-client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/choice";
import { CopyValue } from "@/components/ui/copy";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";

function day(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function PortalProposal({ proposal, org }: { proposal: PortalPolicyProposal; org?: string | null }) {
  const router = useRouter();
  const [current, setCurrent] = useState(proposal);
  const [confirming, setConfirming] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agency = current.agencyName;
  const pending = current.state === "pending";

  async function decide(decision: "approve" | "decline") {
    setBusy(decision);
    setError(null);
    const res = await decidePolicyProposal(current.id, decision, org, decision === "decline" ? reason.trim() || undefined : undefined);
    setBusy(null);
    if (!res.ok) {
      setError(res.error.message ?? "Your answer was not saved. Please try again.");
      return;
    }
    setCurrent(res.data.proposal);
    setConfirming(false);
    setDeclining(false);
    router.refresh();
  }

  return (
    <section
      aria-labelledby={`proposal-${current.id}`}
      data-testid="portal-proposal"
      data-state={current.state}
      className="flex flex-col gap-4 rounded-ctl border border-rule-2 bg-paper-2 px-5 py-5"
    >
      <div className="flex flex-col gap-1.5">
        <p className="legend">{pending ? `${agency} asks your approval` : `A request from ${agency}`}</p>
        <h2 id={`proposal-${current.id}`} className="text-h2 font-bold tracking-[-0.02em] text-fg">
          {current.words.headline}
        </h2>
        {current.note ? (
          <blockquote className="max-w-[70ch] border-l-2 border-rule-2 pl-3 text-body text-fg-2">&ldquo;{current.note}&rdquo;</blockquote>
        ) : null}
      </div>

      <dl className="grid max-w-[72ch] gap-3 text-ui">
        <div>
          <dt className="font-semibold text-fg">What changes</dt>
          <dd className="mt-0.5 text-fg-2">{current.words.effect}</dd>
          {current.words.trial ? <dd className="mt-1 text-fg-2">{current.words.trial}</dd> : null}
        </div>
        {current.words.evidence ? (
          <div>
            <dt className="font-semibold text-fg">Why {agency} thinks it is safe</dt>
            <dd className="mt-0.5 text-fg-2">{current.words.evidence}</dd>
          </div>
        ) : null}
        {current.blockers.length > 0 ? (
          <div data-testid="portal-proposal-points">
            <dt className="font-semibold text-fg">Points {agency} has noted</dt>
            <dd className="mt-0.5 text-fg-2">
              {agency} is asking for this step before every check is complete. Ask them about these before approving:
              <ul className="mt-1 list-disc pl-5">
                {current.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="font-semibold text-fg">The risk</dt>
          <dd className="mt-0.5 text-fg-2">{current.words.risk}</dd>
        </div>
      </dl>

      <details>
        <summary className="link cursor-pointer text-meta font-semibold">The exact record, for your IT contact</summary>
        <div className="mt-2">
          <CopyValue value={current.recordValue} label="the proposed DMARC record" />
        </div>
      </details>

      {error ? <Notice tone="fail" title={error} /> : null}

      {pending ? (
        declining ? (
          <div className="flex max-w-[60ch] flex-col gap-2">
            <label className="text-ui font-semibold text-fg" htmlFor={`reason-${current.id}`}>
              Tell {agency} why (optional)
            </label>
            <Textarea
              id={`reason-${current.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={600}
              className="min-h-[64px]"
              placeholder="For example: our booking system sends email as us; check it first."
              data-testid="portal-proposal-reason"
            />
            <div className="flex flex-wrap gap-2">
              <Button busy={busy === "decline"} busyLabel="Sending" onClick={() => decide("decline")} data-testid="portal-proposal-decline-send">
                Decline the change
              </Button>
              <Button variant="ghost" onClick={() => setDeclining(false)}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => setConfirming(true)} data-testid="portal-proposal-approve">
                Approve
              </Button>
              <Button onClick={() => setDeclining(true)} data-testid="portal-proposal-decline">
                Decline
              </Button>
            </div>
            <p className="text-meta text-fg-3">The request stays open until {day(current.expiresAt)}. Nothing changes unless you approve.</p>
          </div>
        )
      ) : (
        <p className="text-ui text-fg-2" data-testid="portal-proposal-outcome">
          {current.state === "approved"
            ? `Approved by ${current.decidedByEmail ?? "your team"} on ${day(current.decidedAt ?? current.createdAt)}. ${agency} has been told.`
            : current.state === "declined"
              ? `Declined by ${current.decidedByEmail ?? "your team"} on ${day(current.decidedAt ?? current.createdAt)}. Nothing was changed.`
              : `This request expired on ${day(current.expiresAt)}. Nothing was changed.`}
        </p>
      )}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => decide("approve")}
        title={`Approve: ${current.words.headline}?`}
        body={
          <div className="flex flex-col gap-2">
            <p>{current.words.effect}</p>
            <p className="font-semibold text-fg">{current.words.risk}</p>
            <p>Your approval is recorded under your name, and {agency} is told straight away.</p>
          </div>
        }
        confirmLabel="Approve the change"
        busy={busy === "approve"}
        error={error}
      />
    </section>
  );
}
