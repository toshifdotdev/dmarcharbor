"use client";

/**
 * policy-proposals.tsx — ask the client to approve a stricter DMARC policy.
 *
 * Beside the policy ladder on a domain's page. The agency picks the next step,
 * adds a line for the client, and sends it; the client approves or declines in
 * their portal. The latest request's state is shown in words: waiting, live,
 * ready to publish (with the exact record), declined with the client's reason,
 * or approved but not applied (with why, and a retry).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { DomainPolicyProposals, PolicyProposalRow, PolicyReadiness } from "@/lib/types";
import { createPolicyProposal, retryPolicyProposal, withdrawPolicyProposal } from "@/lib/ops-client";
import { instantLabel } from "@/lib/instant";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/choice";
import { CopyValue } from "@/components/ui/copy";
import { Field, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { UpgradeNotice } from "@/components/ui/states";
import { ActionRefusal, type ActionError } from "./plan-refusal";

type Step = { policy: "quarantine" | "reject"; testing: boolean };

const STEPS: Array<Step & { key: string; label: string }> = [
  { key: "quarantine-trial", policy: "quarantine", testing: true, label: "p=quarantine as a trial (t=y)" },
  { key: "quarantine", policy: "quarantine", testing: false, label: "p=quarantine" },
  { key: "reject-trial", policy: "reject", testing: true, label: "p=reject as a trial (t=y)" },
  { key: "reject", policy: "reject", testing: false, label: "p=reject" },
];

/** The rollout ladder, trials included: the same order the API enforces. */
function strictness(policy: string, testing: boolean): number {
  const base = policy === "reject" ? 2 : policy === "quarantine" ? 1 : 0;
  const applied = testing && base > 0 ? base - 1 : base;
  return applied * 3 + base;
}

const STATE: Record<PolicyProposalRow["state"], { tone: Tone; label: string }> = {
  pending: { tone: "neutral", label: "Waiting for the client" },
  expired: { tone: "neutral", label: "Expired" },
  approved: { tone: "ok", label: "Approved" },
  declined: { tone: "warn", label: "Declined" },
  withdrawn: { tone: "neutral", label: "Withdrawn" },
  superseded: { tone: "neutral", label: "Replaced" },
};

function day(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}

export function PolicyProposals({
  organizationId,
  domainId,
  domainName,
  data,
  readiness,
  canEdit,
  hasPortal,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  /** null when the read failed. */
  data: DomainPolicyProposals | null;
  readiness: PolicyReadiness;
  canEdit: boolean;
  /** null when the plan could not be read. */
  hasPortal: boolean | null;
}) {
  const router = useRouter();
  const current = { policy: readiness.currentPolicy === "unknown" ? "none" : readiness.currentPolicy, testing: readiness.testing ?? false };
  const steps = STEPS.filter((step) => strictness(step.policy, step.testing) > strictness(current.policy, current.testing));
  const suggested =
    steps.find((step) => step.policy === readiness.level && !step.testing) ?? steps.find((step) => !step.testing) ?? steps[0];
  const [stepKey, setStepKey] = useState(suggested?.key ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [blockers, setBlockers] = useState<string[] | null>(null);

  const latest = data?.proposals[0] ?? null;
  const earlier = data?.proposals.slice(1, 5) ?? [];
  const step = steps.find((entry) => entry.key === stepKey) ?? null;

  async function send(event: FormEvent | null, acceptBlockers = false) {
    event?.preventDefault();
    if (!step) return;
    setBusy(acceptBlockers ? "send-anyway" : "send");
    setError(null);
    const res = await createPolicyProposal(organizationId, domainId, {
      policy: step.policy,
      testing: step.testing,
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(acceptBlockers ? { acceptBlockers: true } : {}),
    });
    setBusy(null);
    if (!res.ok) {
      if (res.error.code === "POLICY_NOT_READY" && res.error.blockers?.length) {
        setBlockers(res.error.blockers);
        return;
      }
      setError({ ...res.error, message: res.error.message ?? "The request was not sent." });
      return;
    }
    setBlockers(null);
    setNote("");
    router.refresh();
  }

  async function withdraw(id: string) {
    setBusy(`withdraw:${id}`);
    setError(null);
    const res = await withdrawPolicyProposal(organizationId, id);
    setBusy(null);
    if (!res.ok) {
      setError({ message: res.error.message ?? "The request could not be withdrawn." });
      return;
    }
    router.refresh();
  }

  async function retry(id: string) {
    setBusy(`retry:${id}`);
    setError(null);
    const res = await retryPolicyProposal(organizationId, id);
    setBusy(null);
    if (!res.ok) {
      setError({ message: res.error.message ?? "The change did not go through." });
      return;
    }
    router.refresh();
  }

  const open = latest?.state === "pending";

  return (
    <section aria-labelledby="approval-head" className="flex flex-col gap-3 border-t border-rule pt-3" data-testid="policy-proposals">
      <h3 id="approval-head" className="text-ui font-bold text-fg">
        Client approval
      </h3>

      {data === null ? (
        <Notice tone="warn" title="Approval requests could not be read">
          This is not the same as there being none. Reload the page to try again.
        </Notice>
      ) : null}

      {latest ? <LatestProposal proposal={latest} domainName={domainName} canEdit={canEdit} busy={busy} onWithdraw={withdraw} onRetry={retry} /> : null}
      <ActionRefusal error={error} />

      {data && !open && canEdit ? (
        hasPortal === false ? (
          <UpgradeNotice
            feature="portal.client"
            message="Client approval runs through the client portal, included from Harbor."
            context="You can still change the policy yourself."
          />
        ) : data.contacts === 0 ? (
          <p className="text-meta text-fg-2" data-testid="proposal-no-contacts">
            Nobody at this client can approve a change yet.{" "}
            <Link href="/settings/portal" className="link">
              Invite a contact to the client portal
            </Link>{" "}
            and they can approve the next step here.
          </p>
        ) : steps.length === 0 ? (
          <p className="text-meta text-fg-3">This domain is at p=reject. There is no stricter step to ask for.</p>
        ) : (
          <form onSubmit={(event) => send(event)} className="flex flex-col gap-2.5" data-testid="proposal-form">
            <p className="text-meta text-fg-3">
              The client approves in their portal, from the email we send to {data.contacts === 1 ? "their contact" : `their ${data.contacts} contacts`}.{" "}
              {data.applyVia === "hosted"
                ? "The hosted record changes the moment they approve."
                : "Once they approve, you publish the record we give you."}
            </p>
            <Field label="Step to ask for">
              <Select value={stepKey} onChange={(event) => { setStepKey(event.target.value); setBlockers(null); }} data-testid="proposal-step">
                {steps.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="A line for the client (optional)" hint="Shown above the request and in the email.">
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={600} className="min-h-[64px]" data-testid="proposal-note" />
            </Field>
            {blockers ? (
              <Notice tone="warn" title="The evidence does not support this step yet" testId="proposal-blockers">
                <ul className="list-disc pl-4">
                  {blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
                <p className="mt-1.5">If you send it anyway, the client sees these points in the request before deciding.</p>
                <div className="mt-2">
                  <Button busy={busy === "send-anyway"} busyLabel="Sending" onClick={() => send(null, true)} data-testid="proposal-send-anyway">
                    Send with these points shown
                  </Button>
                </div>
              </Notice>
            ) : (
              <div>
                <Button type="submit" variant="primary" busy={busy === "send"} busyLabel="Sending" disabled={!step} data-testid="proposal-send">
                  Ask the client to approve
                </Button>
              </div>
            )}
          </form>
        )
      ) : null}

      {data && !latest && !canEdit ? (
        <p className="text-meta text-fg-3">No request has been sent. An owner, admin or analyst can ask the client to approve the next step.</p>
      ) : null}

      {earlier.length > 0 ? (
        <ul className="flex flex-col text-meta" aria-label="Earlier requests">
          {earlier.map((row) => (
            <li key={row.id} className="flex flex-wrap items-baseline gap-x-2 border-b border-rule py-1.5 last:border-b-0">
              <span className="data text-fg-2">{row.to.label}</span>
              <span className="text-fg-3">{STATE[row.state].label.toLowerCase()}</span>
              <span className="text-fg-3">{day(row.decidedAt ?? row.createdAt)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function LatestProposal({
  proposal,
  domainName,
  canEdit,
  busy,
  onWithdraw,
  onRetry,
}: {
  proposal: PolicyProposalRow;
  domainName: string;
  canEdit: boolean;
  busy: string | null;
  onWithdraw: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const state = STATE[proposal.state];
  return (
    <div className="flex flex-col gap-2" data-testid="proposal-latest" data-state={proposal.state}>
      <p className="flex flex-wrap items-center gap-2 text-ui">
        <Badge tone={state.tone}>{state.label}</Badge>
        <span className="data text-fg">
          {proposal.from.label} → {proposal.to.label}
        </span>
      </p>

      {proposal.state === "pending" ? (
        <>
          <p className="text-meta text-fg-2">
            Sent {instantLabel(proposal.createdAt)}
            {proposal.createdBy ? ` by ${proposal.createdBy.name}` : ""}. Open until {day(proposal.expiresAt)}.
            {proposal.blockers.length > 0 ? ` Sent with ${proposal.blockers.length} open point${proposal.blockers.length === 1 ? "" : "s"} shown to the client.` : ""}
          </p>
          {canEdit ? (
            <div>
              <Button size="sm" variant="ghost" busy={busy === `withdraw:${proposal.id}`} busyLabel="Withdrawing" onClick={() => onWithdraw(proposal.id)} data-testid="proposal-withdraw">
                Withdraw the request
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {proposal.state === "declined" ? (
        <p className="text-meta text-fg-2">
          {proposal.decidedByEmail ?? "The client"} declined on {day(proposal.decidedAt ?? proposal.createdAt)}.
          {proposal.declineReason ? <> Their reason: &ldquo;{proposal.declineReason}&rdquo;</> : null} Nothing was changed.
        </p>
      ) : null}

      {proposal.state === "approved" ? (
        <>
          <p className="text-meta text-fg-2">
            Approved by {proposal.decidedByEmail ?? "the client"} on {day(proposal.decidedAt ?? proposal.createdAt)}.
          </p>
          {proposal.published ? (
            <p className="text-meta font-semibold text-ok">
              {domainName} now publishes {proposal.to.label}.
            </p>
          ) : proposal.applyVia === "hosted" ? (
            <Notice tone="fail" title="The hosted record was not changed" testId="proposal-apply-error">
              {proposal.applyError ?? "The change did not go through."}
              {canEdit ? (
                <div className="mt-2">
                  <Button size="sm" busy={busy === `retry:${proposal.id}`} busyLabel="Retrying" onClick={() => onRetry(proposal.id)} data-testid="proposal-retry">
                    Try the change again
                  </Button>
                </div>
              ) : null}
            </Notice>
          ) : (
            <div className="flex flex-col gap-1.5" data-testid="proposal-publish">
              <p className="text-meta text-fg-2">
                Publish this record at <span className="data">_dmarc.{domainName}</span>. It shows as live once a scan reads it.
              </p>
              <CopyValue value={proposal.recordValue} label="the approved DMARC record" />
            </div>
          )}
        </>
      ) : null}

      {proposal.state === "expired" ? (
        <p className="text-meta text-fg-3">The client did not answer by {day(proposal.expiresAt)}. Send it again if the change is still wanted.</p>
      ) : null}
    </div>
  );
}
