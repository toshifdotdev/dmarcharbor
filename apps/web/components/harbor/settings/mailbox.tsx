"use client";

/**
 * mailbox.tsx — a mailbox you run, that DMARC reports are collected from.
 *
 * Most people never need this. It exists for one case, which the page leads
 * with because it is the reason anyone arrives: a domain whose reports go to
 * a mailbox of yours, or to a web endpoint nothing here can read. Then the
 * status (when it last collected, and why it failed if it did), then the
 * connection form.
 *
 * The password is write-only: sent once, stored encrypted, never returned,
 * and the field empties after every save.
 *
 * Test hooks: rua-thread; the connection form is the first <form> on the page
 * with host, then username, as its first two text fields; the button reads
 * "Connect mailbox" or "Update mailbox"; "Last polled" appears once saved.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { pollInboxNow, removeReportInbox, setReportInbox, type InboxPollOutcome } from "@/lib/ops-client";
import type { ReportInboxSettings } from "@/lib/types";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { KeyValue, Notice } from "@/components/ui/notice";
import { useToast } from "@/components/ui/toast";
import { Panel } from "./parts";

const PORTS = [
  { port: 993, secure: true, label: "993: TLS from the start (most providers)" },
  { port: 143, secure: false, label: "143: STARTTLS" },
  { port: 2525, secure: true, label: "2525: TLS, alternative port" },
];

export function RuaThread() {
  return (
    <section data-testid="rua-thread" className="rounded-ctl border border-rule bg-paper-2 px-4 py-3.5">
      <p className="legend">When you need this</p>
      <p className="mt-1 max-w-[76ch] text-ui text-fg-2">
        Receivers send each domain&rsquo;s reports wherever the <code className="data text-fg">rua=</code> tag in its DMARC
        record points. You need a mailbox here when that is a mailbox you run, or when a domain publishes its reports to a{" "}
        <span className="font-semibold text-fg">web endpoint</span> (an <code className="data text-fg">https://</code>{" "}
        address): that record is correctly configured, but those reports cannot be collected. Point its rua at a mailbox,
        connect the mailbox here, and the reports are read from it. Each domain&rsquo;s setup page shows the record it
        should publish.
      </p>
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

  return (
    <div className="flex flex-col gap-10">
      {paused ? null : (
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
      )}

      {inbox.configured ? (
        <Panel
          id="mb-status"
          title="Collection"
          aside={
            paused ? <Badge tone="warn">Not read on this plan</Badge> : inbox.enabled ? <Badge tone="ok">Collecting</Badge> : <Badge tone="warn">Stopped</Badge>
          }
          why="The mailbox is read on a schedule. Reports for domains in this workspace are filed under them; the rest are counted and left alone."
        >
          <KeyValue
            rows={[
              ["Mailbox", <span key="u" className="data">{inbox.username ?? "not recorded"} on {inbox.host ?? "not recorded"}</span>],
              ["Last polled", lastPolledLabel ?? <span className="text-fg-3">not yet: the first run has not happened</span>],
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
          {canManage ? (
            <div className="flex flex-wrap items-center gap-3">
              {paused ? null : (
                <Button onClick={poll} busy={polling} busyLabel="Reading the mailbox">
                  Collect now
                </Button>
              )}
              <Button variant="ghost" onClick={() => setRemoveOpen(true)}>
                Disconnect mailbox
              </Button>
            </div>
          ) : null}
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
        </Panel>
      ) : null}

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
