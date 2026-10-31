"use client";

/**
 * mailbox.tsx — a mailbox you run, that DMARC reports are collected from.
 *
 * Most people never need this. It exists for one case, which the page leads
 * with because it is the reason anyone arrives, drawn the way the rest of the
 * product draws mail: a domain's reports travel from the receivers along its
 * rua= tag and end at one of three places. The setup-page address is
 * collected on every plan; a mailbox you run is collected once it is connected
 * here; a web endpoint (https://) is a correct record whose reports cannot be
 * collected, so that branch ends at a closed station. Then the collection
 * status (when it last read the mailbox, and why it failed if it did), then
 * the connection form beside its steps.
 *
 * The password is write-only: sent once, stored encrypted, never returned,
 * and the field empties after every save.
 *
 * Test hooks: rua-thread; the connection form is the first <form> on the page
 * with host, then username, as its first two text fields; the button reads
 * "Connect mailbox" or "Update mailbox"; "Last polled" appears once saved.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { clsx } from "clsx";
import { pollInboxNow, removeReportInbox, setReportInbox, type InboxPollOutcome } from "@/lib/ops-client";
import type { ReportInboxSettings } from "@/lib/types";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { KeyValue, Notice } from "@/components/ui/notice";
import { useToast } from "@/components/ui/toast";
import { ConnectionLine, SetupSteps, type LineState } from "./lines";
import { Panel } from "./parts";

const PORTS = [
  { port: 993, secure: true, label: "993: TLS from the start (most providers)" },
  { port: 143, secure: false, label: "143: STARTTLS" },
  { port: 2525, secure: true, label: "2525: TLS, alternative port" },
];

type Stop = "origin" | "station" | "built" | "planned" | "closed";

/** One row of the report route: a mark on the trunk, or a branch off it. */
function RouteRow({ stop, last, name, kind }: { stop: Stop; last?: boolean; name: ReactNode; kind: ReactNode }) {
  const branch = stop === "built" || stop === "planned" || stop === "closed";
  return (
    <li className={clsx("relative min-h-[44px] py-2", branch ? "pl-[84px]" : "pl-[40px]")}>
      {/* The trunk: down from the origin, through the station, to the last branch. */}
      <span
        aria-hidden
        className={clsx("absolute left-[8px] w-[3px] bg-fg", stop === "origin" ? "top-[19px] bottom-0" : last ? "top-0 h-[19px]" : "inset-y-0")}
      />
      {stop === "origin" ? (
        <span aria-hidden className="absolute left-0 top-[10px] size-[19px] rounded-full border-[3px] border-fg bg-paper" />
      ) : null}
      {stop === "station" ? (
        <span aria-hidden className="absolute left-[-3px] top-[12px] h-[15px] w-[25px] rounded-full border-[3px] border-fg bg-paper" />
      ) : null}
      {branch ? (
        <>
          <span
            aria-hidden
            className={clsx(
              "absolute left-[9px] top-[18px] w-[38px] border-t-[3px]",
              stop === "built" && "border-solid border-fg",
              stop === "planned" && "border-dashed border-fg",
              stop === "closed" && "border-dotted border-rule-2",
            )}
          />
          <span
            aria-hidden
            className={clsx(
              "absolute top-[12px] rounded-full border-[3px] bg-paper",
              stop === "closed" ? "left-[46px] size-[15px] border-rule-2" : "left-[46px] h-[15px] w-[26px] border-fg",
            )}
          />
        </>
      ) : null}
      <p className="text-ui leading-[1.35]">
        <span className={clsx("font-bold", stop === "closed" ? "text-fg-2" : "text-fg")}>{name}</span>
        <span className="mt-0.5 block text-meta text-fg-3">{kind}</span>
      </p>
    </li>
  );
}

/**
 * Where a domain's reports go, drawn as a route. `mailbox` sets the middle
 * branch: built when a connected mailbox is being read, planned otherwise.
 */
export function RuaThread({ mailbox = "none" }: { mailbox?: "collecting" | "stopped" | "none" }) {
  return (
    <section data-testid="rua-thread" aria-labelledby="rua-head" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule pb-2">
        <h2 id="rua-head" className="text-h3 font-bold tracking-[-0.01em] text-fg">
          Where a domain&rsquo;s reports go
        </h2>
        <p className="text-meta text-fg-3">and when you need a mailbox here</p>
      </div>
      <div className="grid gap-x-12 gap-y-4 lg:grid-cols-[minmax(0,0.74fr)_minmax(0,1fr)]">
        <p className="max-w-[60ch] text-ui text-fg-2">
          Receivers send each domain&rsquo;s reports wherever the <code className="data text-fg">rua=</code> tag in its DMARC
          record points. You need a mailbox here when that is a mailbox you run, or when a domain publishes its reports to a{" "}
          <span className="font-semibold text-fg">web endpoint</span> (an <code className="data text-fg">https://</code>{" "}
          address): that record is correctly configured, but those reports cannot be collected. Point its rua at a mailbox,
          connect the mailbox here, and the reports are read from it. Each domain&rsquo;s setup page shows the record it
          should publish.
        </p>
        <ol aria-label="The routes a domain's reports can take" className="flex flex-col">
          <RouteRow stop="origin" name="Receivers" kind="Mailbox providers send a report for each domain, usually daily." />
          <RouteRow
            stop="station"
            name={
              <>
                <code className="data">rua=</code> in the domain&rsquo;s DMARC record
              </>
            }
            kind="The reports go wherever it points."
          />
          <RouteRow stop="built" name="The report address on its setup page" kind="Collected on every plan. Nothing to set up here." />
          <RouteRow
            stop={mailbox === "collecting" ? "built" : "planned"}
            name="A mailbox you run"
            kind={
              mailbox === "collecting"
                ? "Connected below and being read."
                : mailbox === "stopped"
                  ? "Connected below, but nothing is being read from it."
                  : "Connect it on this page and its reports are read from it."
            }
          />
          <RouteRow
            stop="closed"
            last
            name={
              <>
                A web endpoint, an <code className="data">https://</code> address
              </>
            }
            kind="A correct record, but those reports cannot be collected here."
          />
        </ol>
      </div>
    </section>
  );
}

export function MailboxBoard({
  organizationId,
  inbox,
  canManage,
  lastPolledLabel,
  paused = false,
}: {
  organizationId: string;
  inbox: ReportInboxSettings;
  canManage: boolean;
  lastPolledLabel: string | null;
  /** The plan no longer includes it: only the status and Disconnect are offered. */
  paused?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [host, setHost] = useState(inbox.host ?? "");
  const [username, setUsername] = useState(inbox.username ?? "");
  const [password, setPassword] = useState("");
  const [port, setPort] = useState(993);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [polling, setPolling] = useState(false);
  const [outcome, setOutcome] = useState<InboxPollOutcome | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const choice = PORTS.find((p) => p.port === port) ?? PORTS[0];
    setBusy(true);
    setError(null);
    const res = await setReportInbox(organizationId, {
      host: host.trim(),
      port: choice.port,
      secure: choice.secure,
      username: username.trim(),
      password,
    });
    setBusy(false);
    setPassword("");
    if (!res.ok) {
      setError(res.error);
      return;
    }
    toast({ title: inbox.configured ? "Mailbox updated" : "Mailbox connected", body: "It is read on the next collection run, or now with Collect now.", tone: "ok" });
    router.refresh();
  }

  async function poll() {
    setPolling(true);
    setPollError(null);
    setOutcome(null);
    const res = await pollInboxNow(organizationId);
    setPolling(false);
    if (!res.ok) {
      setPollError(res.error.message ?? "The mailbox could not be read.");
      router.refresh();
      return;
    }
    setOutcome(res.data);
    router.refresh();
  }

  async function remove() {
    setRemoveBusy(true);
    const res = await removeReportInbox(organizationId);
    setRemoveBusy(false);
    setRemoveOpen(false);
    if (!res.ok) {
      setPollError(res.error.message ?? "The mailbox could not be disconnected.");
      return;
    }
    toast({ title: "Mailbox disconnected", tone: "ok" });
    router.refresh();
  }

  const state: LineState = paused ? "paused" : !inbox.enabled ? "paused" : inbox.consecutiveFailures > 0 ? "failing" : "live";
  const word = paused ? "Not read on this plan" : !inbox.enabled ? "Stopped" : inbox.consecutiveFailures > 0 ? "Failing" : "Collecting";
  const detail = lastPolledLabel ? `Last polled ${lastPolledLabel}.` : "Not polled yet: the first run has not happened.";

  return (
    <div className="flex flex-col gap-10">
      {inbox.configured ? (
        <section aria-labelledby="mb-status" className="flex flex-col gap-4">
          <h2 id="mb-status" className="sr-only">
            Collection
          </h2>
          <ConnectionLine
            state={state}
            word={word}
            detail={detail}
            label={`Your mailbox to this workspace's reports: ${word.toLowerCase()}.`}
            aside={
              canManage ? (
                <>
                  {paused ? null : (
                    <Button size="sm" onClick={poll} busy={polling} busyLabel="Reading the mailbox">
                      Collect now
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setRemoveOpen(true)}>
                    Disconnect mailbox
                  </Button>
                </>
              ) : null
            }
            from={{ name: inbox.username ?? "Your mailbox", kind: inbox.host ?? "host not recorded", mono: Boolean(inbox.username) }}
            to={{ name: "Reports", kind: "filed under this workspace's domains" }}
          />
          <KeyValue
            labelWidth={140}
            rows={[
              ["Mailbox", <span key="u" className="data break-all">{inbox.username ?? "not recorded"} on {inbox.host ?? "not recorded"}</span>],
              ["Last polled", lastPolledLabel ?? <span className="text-fg-3">not yet: the first run has not happened</span>],
              ["Reads", "Report attachments only, on a schedule. Reports for domains in this workspace are filed under them; the rest are counted and left alone."],
              inbox.consecutiveFailures > 0
                ? [
                    "Failing",
                    <span key="f" className="text-fail">
                      {inbox.consecutiveFailures} run{inbox.consecutiveFailures === 1 ? "" : "s"} in a row
                      {inbox.lastError ? `: ${inbox.lastError}` : ""}
                    </span>,
                  ]
                : null,
            ]}
          />
          {outcome ? (
            <Notice tone={outcome.messages === 0 ? "info" : "ok"} title={outcome.messages === 0 ? "No new messages in the mailbox" : `${outcome.messages} message${outcome.messages === 1 ? "" : "s"} read`}>
              {outcome.messages > 0 ? (
                <span className="tnum">
                  {outcome.accepted} new report{outcome.accepted === 1 ? "" : "s"} filed, {outcome.duplicates} already had,{" "}
                  {outcome.unmatched} for domains not in this workspace.
                </span>
              ) : (
                "If another collection run was already in progress, this one waits its turn and reads nothing."
              )}
            </Notice>
          ) : null}
          {pollError ? <Notice tone="fail" title={pollError} /> : null}
        </section>
      ) : null}

      {paused ? null : (
        <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
          <Panel
            id="mb-set"
            title={inbox.configured ? "Change the connection" : "Connect a mailbox"}
            why="IMAP access to the mailbox the reports arrive in. A mailbox used only for DMARC reports is safest: the reader collects report attachments and ignores everything else."
          >
            {canManage ? (
              <form onSubmit={save} className="grid max-w-[640px] gap-4 sm:grid-cols-2">
                <Field label="Mail server" hint="The IMAP host, for example imap.youragency.example." className="sm:col-span-2">
                  <Input mono value={host} onChange={(e) => setHost(e.target.value)} required minLength={3} maxLength={253} autoComplete="off" spellCheck={false} />
                </Field>
                <Field label="Username" hint="Usually the full mailbox address.">
                  <Input mono value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} maxLength={320} autoComplete="off" spellCheck={false} />
                </Field>
                <Field
                  label="Password"
                  hint={inbox.configured ? "Enter it again to save any change. It is never shown." : "An app password if your provider offers one. Stored encrypted, never shown."}
                >
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
                </Field>
                <Field label="Port" hint="The API accepts 993, 143 and 2525." className="sm:col-span-2">
                  <Select value={String(port)} onChange={(e) => setPort(Number(e.target.value))} className="w-full max-w-[380px]">
                    {PORTS.map((p) => (
                      <option key={p.port} value={p.port}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex flex-col gap-2 sm:col-span-2">
                  <ActionRefusal error={error} />
                  <div>
                    <Button type="submit" variant="primary" busy={busy} busyLabel="Saving the mailbox">
                      {inbox.configured ? "Update mailbox" : "Connect mailbox"}
                    </Button>
                  </div>
                </div>
              </form>
            ) : (
              <p className="text-ui text-fg-2">An owner or admin can connect or change the mailbox.</p>
            )}
          </Panel>

          <SetupSteps
            title="Getting a mailbox ready"
            done={inbox.configured}
            className="lg:pt-1"
            steps={[
              { key: "own", name: "A mailbox for reports only", detail: "The reader takes report attachments and ignores everything else." },
              { key: "imap", name: "IMAP on, with an app password", detail: "If your provider offers app passwords, use one here." },
              { key: "rua", name: "Point each domain's rua at it", detail: "Its setup page shows the record to publish." },
              { key: "connect", name: "Connect it here", detail: "Read on a schedule, or now with Collect now." },
            ]}
          />
        </div>
      )}

      <ConfirmDialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        onConfirm={remove}
        title="Disconnect the mailbox?"
        body={
          <p>
            Collection stops and the stored password is deleted. Reports already collected stay. Domains whose rua points at
            this mailbox stop getting new reports here until it is connected again.
          </p>
        }
        confirmLabel="Disconnect"
        busy={removeBusy}
        danger
      />
    </div>
  );
}
