"use client";

/**
 * domain-switch.tsx — the provider switch for one domain.
 *
 * The record decides the state, so this panel never offers "mark as cut over":
 * it offers "check DNS now" and shows what the record says. The cutover record
 * stays visible before it is recommended, labelled as such, because seeing the
 * destination is part of deciding whether to go.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { checkDomainSwitch, startDomainSwitch, stopDomainSwitch } from "@/lib/ops-client";
import { fmtVolume } from "@/lib/posture";
import type { DomainSwitchStatus, DomainSwitchView } from "@/lib/types";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { DnsHandoff } from "./dns-handoff";
import { ActionRefusal, type ActionError } from "./plan-refusal";

const STEP_ORDER: DomainSwitchStatus[] = ["PLANNED", "DUAL_REPORTING", "CUT_OVER"];
const STEP_LABEL: Record<DomainSwitchStatus, string> = {
  PLANNED: "Planned",
  DUAL_REPORTING: "Dual reporting",
  CUT_OVER: "Cut over",
};
const STATUS_TONE: Record<DomainSwitchStatus, Tone> = {
  PLANNED: "neutral",
  DUAL_REPORTING: "ok",
  CUT_OVER: "ok",
};

function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function DomainSwitchPanel({
  organizationId,
  domainId,
  domainName,
  state,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  state: { data: DomainSwitchView | null; failed: boolean };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"start" | "check" | "stop" | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [throttled, setThrottled] = useState(false);

  if (state.failed) {
    return (
      <Notice tone="fail" title="The switch state could not be read" testId="switch-read-failed">
        Nothing was changed. Reload the page to try again; the domain&rsquo;s reports are still on record.
      </Notice>
    );
  }

  const view = state.data;
  if (!view) {
    return null;
  }

  async function start() {
    setBusy("start");
    setError(null);
    const response = await startDomainSwitch(organizationId, domainId);
    setBusy(null);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    router.refresh();
  }

  async function check() {
    setBusy("check");
    setError(null);
    const response = await checkDomainSwitch(organizationId, domainId);
    setBusy(null);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setThrottled(response.data.throttled === true);
    router.refresh();
  }

  async function stop() {
    setBusy("stop");
    setError(null);
    const response = await stopDomainSwitch(organizationId, domainId);
    setBusy(null);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setStopOpen(false);
    router.refresh();
  }

  if (!view.switch) {
    if (!view.eligible) {
      return null;
    }

    return (
      <section aria-labelledby="switch-head" className="flex flex-col gap-3 border-t border-rule-2 pt-4" data-testid="switch-eligible">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="switch-head" className="text-h3 font-bold tracking-[-0.01em]">
              Switching from another provider
            </h2>
            <p className="mt-1 max-w-[80ch] text-ui text-fg-2">
              This domain&rsquo;s DMARC record sends reports somewhere else as well. A switch adds our address next to
              the other provider&rsquo;s, so reports keep arriving while you confirm ours are steady, then removes
              theirs.
            </p>
          </div>
          <Button
            variant="primary"
            onClick={start}
            busy={busy === "start"}
            busyLabel="Reading the live record"
            data-testid="switch-start"
          >
            Start a switch
          </Button>
        </div>
        <ActionRefusal error={error} />
      </section>
    );
  }

  const current = view.switch;
  const stepIndex = STEP_ORDER.indexOf(current.status);
  const ready = view.readiness?.ready === true;
  // Once the record shows only our address the switch is finished: readiness
  // and a "not yet recommended" cutover record would read as doubts about it.
  const cutOver = current.status === "CUT_OVER";

  return (
    <section aria-labelledby="switch-head" className="flex flex-col gap-6 border-t border-rule-2 pt-4" data-testid="switch-panel">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="switch-head" className="text-h3 font-bold tracking-[-0.01em]">
            Switching from {current.incumbent.label}
          </h2>
          <p className="mt-1 max-w-[80ch] text-ui text-fg-2">
            The dual record keeps {current.incumbent.label}&rsquo;s report address and adds ours. Nothing else in the
            record changes, so enforcement stays exactly as published.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={check}
            busy={busy === "check"}
            busyLabel="Reading DNS"
            data-testid="switch-check"
          >
            Check DNS now
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setStopOpen(true)} data-testid="switch-stop">
            Stop switch
          </Button>
        </div>
      </div>

      <ActionRefusal error={error} />
      {throttled ? (
        <p className="text-meta text-fg-3" data-testid="switch-throttled">
          Checked recently, so no DNS lookup was made. The stored state is shown.
        </p>
      ) : null}

      <ol className="grid grid-cols-3 border border-rule-2" aria-label="Switch progress">
        {STEP_ORDER.map((step, index) => {
          const active = index === stepIndex;
          const passed = index < stepIndex;
          return (
            <li
              key={step}
              aria-current={active ? "step" : undefined}
              className={
                active
                  ? "bg-fg px-3 py-2 text-paper"
                  : "border-l border-rule px-3 py-2 first:border-l-0"
              }
            >
              <span className={active ? "legend text-paper-3!" : "legend"}>step {index + 1}</span>
              <span className="mt-0.5 block text-ui font-semibold">{STEP_LABEL[step]}</span>
              <span className={active ? "mt-0.5 block text-[10.5px] font-semibold uppercase tracking-[0.06em]" : "mt-0.5 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-3"}>
                {active ? "current" : passed ? "done" : "not yet"}
              </span>
            </li>
          );
        })}
      </ol>

      {current.issues.length > 0 ? (
        <div data-testid="switch-issues">
          <p className="legend pb-1">Needs attention</p>
          <ul className="flex flex-col gap-1 border-t border-rule-2 pt-2 text-ui text-fg-2">
            {current.issues.map((issue) => (
              <li key={issue.code} className="flex items-baseline gap-2">
                <span aria-hidden className="block size-1.5 shrink-0 translate-y-[-1px] rotate-45 bg-warn-mark" />
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {view.records ? (
        <div className="grid gap-8 xl:grid-cols-2">
          <div>
            <p className="legend pb-2">Dual reporting record</p>
            <DnsHandoff
              domain={domainName}
              records={[
                {
                  purpose: "Add our address next to the current provider",
                  host: view.records.dual.host,
                  value: view.records.dual.value,
                  testId: "switch-dual-record",
                },
              ]}
            />
          </div>
          <div>
            <p className="legend pb-2">
              Cutover record{" "}
              {ready || cutOver ? null : <span className="font-normal text-warn">&mdash; not yet recommended</span>}
            </p>
            <DnsHandoff
              domain={domainName}
              records={[
                {
                  purpose: cutOver
                    ? "The record with only our address"
                    : ready
                      ? "Replace the dual record with this"
                      : "Do not publish yet",
                  host: view.records.cutover.host,
                  value: view.records.cutover.value,
                  testId: "switch-cutover-record",
                },
              ]}
            />
            {view.records.cutover.warnings.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1 text-meta text-fg-2">
                {view.records.cutover.warnings.map((warning) => (
                  <li key={warning.code}>{warning.message}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}

      {view.overlap ? (
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="legend">Reports received since dual reporting began</p>
            <p className="text-meta text-fg-3">
              <span className="tnum font-semibold text-fg-2">{view.overlap.totals.dualDays}</span> days,{" "}
              <span className="tnum font-semibold text-fg-2">{fmtVolume(view.overlap.totals.messages)}</span> messages,{" "}
              <span className="tnum font-semibold text-fg-2">{view.overlap.totals.receivers}</span> receivers
            </p>
          </div>
          {view.overlap.receivers.length === 0 ? (
            <p className="border-y border-rule py-6 text-body text-fg-3" data-testid="switch-overlap-empty">
              No aggregate reports have arrived since dual reporting began. Receivers usually send within 24 to 48
              hours of the record being visible everywhere.
            </p>
          ) : (
            <Table caption="Receivers and what they sent" minWidth={720}>
              <THead>
                <tr>
                  <Th>Receiver</Th>
                  <Th>First report</Th>
                  <Th>Last report</Th>
                  <Th numeric>Days received of expected</Th>
                  <Th numeric>Coverage</Th>
                  <Th numeric>Share of messages</Th>
                </tr>
              </THead>
              <TBody>
                {view.overlap.receivers.map((receiver) => (
                  <Tr key={receiver.key} data-testid={`switch-receiver-${receiver.key}`}>
                    <Td className="font-semibold">{receiver.label}</Td>
                    <Td muted>{dayLabel(receiver.firstReportDay)}</Td>
                    <Td muted>{dayLabel(receiver.lastReportDay)}</Td>
                    <Td numeric>
                      {receiver.reportDays} of {receiver.expectedDays}
                    </Td>
                    <Td numeric>{receiver.coveragePercent}%</Td>
                    <Td numeric>{receiver.sharePercent}%</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
          <p className="mt-2 text-meta text-fg-3">{view.overlap.note}</p>
        </div>
      ) : null}

      {cutOver ? (
        <Notice tone="ok" title="Cut over" testId="switch-cut-over">
          {current.cutOverAt
            ? `DNS has shown only our report address since ${new Date(current.cutOverAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}.`
            : "DNS shows only our report address."}{" "}
          The switch is finished; stopping it now only removes this panel.
        </Notice>
      ) : view.readiness ? (
        <div data-testid="switch-readiness">
          {ready ? (
            <Notice tone="ok" title="Ready to cut over">
              Reports are steady from the receivers that matter. Publish the cutover record when convenient, then check
              DNS to confirm it.
            </Notice>
          ) : (
            <Notice tone="warn" title="Not ready to cut over yet">
              <ul className="flex flex-col gap-1">
                {view.readiness.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </Notice>
          )}
        </div>
      ) : null}

      <p className="text-meta text-fg-3">
        Current status: <Badge tone={STATUS_TONE[current.status]}>{STEP_LABEL[current.status]}</Badge>
        {current.externalAuthorization === "missing"
          ? " The report domain has not authorised this domain yet; the operator warning is on the client switch page."
          : null}
      </p>

      <ConfirmDialog
        open={stopOpen}
        onClose={() => setStopOpen(false)}
        onConfirm={stop}
        title="Stop this switch?"
        body="The switch is removed, and the domain and its reports stay exactly as they are. Nothing in DNS is changed. You can start a new switch later."
        confirmLabel="Stop the switch"
        busy={busy === "stop"}
        testId="switch-stop"
      />
    </section>
  );
}
