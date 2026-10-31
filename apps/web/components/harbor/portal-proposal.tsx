"use client";

/**
 * portal-proposal.tsx — a request to tighten the domain's protection, as the
 * client reads it, with their approve and decline.
 *
 * The reader carries the risk and is rarely technical, so the request says
 * what changes for fake mail, what could happen to their own mail, and what
 * the agency is relying on, all in sentences the API wrote. Beside them, the
 * strip from monitoring to blocking shows where the domain is and, dashed, the
 * step being asked for: the map's line under construction. The record itself
 * is tucked away for whoever handles their IT. Approving asks once more, in
 * words, because it is the one choice here that can stop real mail.
 */

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { PortalPolicyProposal } from "@/lib/types";
import { decidePolicyProposal } from "@/lib/ops-client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/choice";
import { CopyValue } from "@/components/ui/copy";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { PolicyStrip, recordStage, StateWord, type Stage } from "./document-route";

function day(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

const STAGE_NAME = ["Monitor only", "Send to spam", "Block"] as const;

export function PortalProposal({
  proposal,
  org,
  current: currentStage = null,
}: {
  proposal: PortalPolicyProposal;
  org?: string | null;
  /** Where the domain's policy is now, for the strip. Optional; without it the strip starts unread. */
  current?: Stage;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(proposal);
  const [confirming, setConfirming] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agency = current.agencyName;
  const pending = current.state === "pending";
  const target = recordStage(current.recordValue);

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
      className="flex max-w-[60rem] flex-col gap-6 rounded-sheet border border-rule-2 px-5 py-6 sm:px-8 sm:py-7 print:border-fg"
    >
      <div className="grid gap-x-12 gap-y-5 min-[900px]:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0">
          <p className="text-[15px] leading-[1.4] text-fg-4">
            {pending ? (
              <>
                <span className="font-bold text-fg">{agency}</span> asks your approval
              </>
            ) : (
              <>
                A request from <span className="font-bold text-fg">{agency}</span>
              </>
            )}
          </p>
          <h2
            id={`proposal-${current.id}`}
            className="mt-2 text-[24px] font-[740] leading-[1.15] tracking-[-0.025em] text-fg [text-wrap:balance] sm:text-[28px]"
          >
            {current.words.headline}
          </h2>
          {current.note ? (
            <blockquote className="mt-4 max-w-[60ch] border-l-[3px] border-rule-2 pl-4 text-[16px] leading-[1.55] text-fg-2">
              &ldquo;{current.note}&rdquo;
            </blockquote>
          ) : null}
        </div>
        {target !== null ? (
          <div className="min-w-0 self-start min-[900px]:pt-1">
            <PolicyStrip at={currentStage} to={pending ? target : null} scale />
            <p className="mt-2 text-[13.5px] leading-[1.45] text-fg-4">
              {currentStage !== null && pending && target > currentStage ? (
                <>
                  From <span className="font-semibold text-fg-2">{STAGE_NAME[currentStage]}</span> to{" "}
                  <span className="font-semibold text-fg-2">{STAGE_NAME[target]}</span>, drawn dashed until you approve.
                </>
              ) : (
                <>
                  Asked for: <span className="font-semibold text-fg-2">{STAGE_NAME[target]}</span>
                </>
              )}
            </p>
          </div>
        ) : null}
      </div>

      <dl className="border-t border-rule">
        <Row label="What changes">
          <p>{current.words.effect}</p>
          {current.words.trial ? <p className="mt-1.5">{current.words.trial}</p> : null}
        </Row>
        {current.words.evidence ? (
          <Row label={`Why ${agency} thinks it is safe`}>
            <p>{current.words.evidence}</p>
          </Row>
        ) : null}
        {current.blockers.length > 0 ? (
          <Row label={`Points ${agency} has noted`} testId="portal-proposal-points">
            <p>{agency} is asking for this step before every check is complete. Ask them about these before approving:</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {current.blockers.map((blocker) => (
                <li key={blocker} className="relative pl-5">
                  <span aria-hidden className="absolute left-0.5 top-[0.62em] block size-[6px] rounded-full bg-fg-4" />
                  {blocker}
                </li>
              ))}
            </ul>
          </Row>
        ) : null}
        <Row label="The risk">
          <p className="text-fg">{current.words.risk}</p>
        </Row>
      </dl>

      <details>
        <summary className="link cursor-pointer text-[14px] font-semibold">The exact record, for your IT contact</summary>
        <div className="mt-2.5 max-w-[56rem]">
          <CopyValue value={current.recordValue} label="the proposed DMARC record" />
        </div>
      </details>

      {error ? <Notice tone="fail" title={error} /> : null}

      {pending ? (
        declining ? (
          <div className="flex max-w-[40rem] flex-col gap-2.5 border-t border-rule pt-5">
            <label className="text-[15px] font-semibold text-fg" htmlFor={`reason-${current.id}`}>
              Tell {agency} why (optional)
            </label>
            <Textarea
              id={`reason-${current.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={600}
              className="min-h-[72px]"
              placeholder="For example: our booking system sends email as us; check it first."
              data-testid="portal-proposal-reason"
            />
            <div className="flex flex-wrap gap-2">
              <Button size="lg" busy={busy === "decline"} busyLabel="Sending" onClick={() => decide("decline")} data-testid="portal-proposal-decline-send">
                Decline the change
              </Button>
              <Button size="lg" variant="ghost" onClick={() => setDeclining(false)}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 border-t border-rule pt-5 print:hidden">
            <div className="flex flex-wrap gap-2">
              <Button size="lg" variant="primary" onClick={() => setConfirming(true)} data-testid="portal-proposal-approve">
                Approve
              </Button>
              <Button size="lg" onClick={() => setDeclining(true)} data-testid="portal-proposal-decline">
                Decline
              </Button>
            </div>
            <p className="text-[14px] text-fg-4">The request stays open until {day(current.expiresAt)}. Nothing changes unless you approve.</p>
          </div>
        )
      ) : (
        <div className="flex flex-col gap-2 border-t border-rule pt-5">
          <p>
            {current.state === "approved" ? (
              <StateWord shape="square" tone="ok">
                Approved
              </StateWord>
            ) : (
              <StateWord shape="hatch" tone="void">
                {current.state === "declined" ? "Declined" : "Closed"}
              </StateWord>
            )}
          </p>
          <p className="text-[15px] leading-[1.55] text-fg-2" data-testid="portal-proposal-outcome">
            {current.state === "approved"
              ? `Approved by ${current.decidedByEmail ?? "your team"} on ${day(current.decidedAt ?? current.createdAt)}. ${agency} has been told.`
              : current.state === "declined"
                ? `Declined by ${current.decidedByEmail ?? "your team"} on ${day(current.decidedAt ?? current.createdAt)}. Nothing was changed.`
                : `This request expired on ${day(current.expiresAt)}. Nothing was changed.`}
          </p>
        </div>
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

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="grid gap-1 border-b border-rule py-3.5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-8">
      <dt className="text-[15px] font-bold text-fg">{label}</dt>
      <dd className="max-w-[64ch] text-[15.5px] leading-[1.55] text-fg-2">{children}</dd>
    </div>
  );
}
