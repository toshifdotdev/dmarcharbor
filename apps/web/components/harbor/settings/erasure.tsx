"use client";

/**
 * erasure.tsx — permanently erasing personal data, for the workspace, one
 * client, or one domain.
 *
 * Irreversible once it runs, so everything here is arranged so nobody runs it
 * by accident or without knowing exactly what goes: the API's own preview of
 * every record class (deleted, anonymised, or kept, and why) as figures and a
 * table, the grace period the API holds a request for drawn as the line a
 * request travels (scheduled, then the grace period, then erased), a typed
 * ERASE, and a pending request that can be cancelled until the grace period
 * ends. Dangerous, stated plainly, without alarm: the colour marks the edge,
 * the words carry it.
 *
 * Test hooks: erasure-preview, erasure-confirm, erasure-submit, erasure-pending,
 * erasure-cancel.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { cancelErasureJob, previewErasure, requestErasureJob } from "@/lib/ops-client";
import type { ErasurePreview } from "@/lib/types";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/choice";
import { Field, Input, Segmented, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Readout, ReadoutStrip } from "@/components/ui/readout";
import { Table, TBody, Td, TEmptyRow, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { LineStateWord, StopLine } from "./lines";
import { DangerZone, Panel } from "./parts";

type Scope = "ORGANIZATION" | "CLIENT" | "DOMAIN";

export interface ErasureView {
  id: string;
  scope: Scope;
  targetId: string | null;
  scopeLabel: string;
  state: "PENDING" | "EXECUTING" | "COMPLETED" | "CANCELLED";
  reason: string | null;
  requestedLabel: string | null;
  runsAfterLabel: string;
}

const ACTION_WORDS = {
  delete: ["Deleted", "font-bold text-fg"],
  anonymize: ["Anonymised", "font-semibold text-fg-2"],
  retain: ["Kept", "font-medium text-fg-3"],
} as const;

function PreviewTable({ preview }: { preview: ErasurePreview }) {
  const rows = preview.actions.filter((a) => a.count > 0 || a.action !== "retain");
  return (
    <div data-testid="erasure-preview" className="flex flex-col gap-4">
      <ReadoutStrip>
        <Readout label="Deleted" value={preview.totals.recordsDeleted.toLocaleString("en-GB")} unit="records" note="Gone for good once it runs." />
        <Readout label="Anonymised" value={preview.totals.recordsAnonymised.toLocaleString("en-GB")} unit="records" note="Kept, with identifying fields cleared." />
        <Readout label="Kept" value={preview.totals.evidenceRetained.toLocaleString("en-GB")} unit="records" note="For the reasons given below." />
      </ReadoutStrip>
      <Table caption="What the erasure would do, by record type" minWidth={680} dense>
        <THead>
          <tr>
            <Th>Records</Th>
            <Th numeric>How many</Th>
            <Th>What happens</Th>
            <Th>Why</Th>
          </tr>
        </THead>
        <TBody>
          {rows.map((a) => {
            const [word, cls] = ACTION_WORDS[a.action];
            return (
              <Tr key={a.key}>
                <Td>
                  {a.label}
                  {a.containsPersonalData ? <span className="block text-meta text-fg-3">holds personal data</span> : null}
                </Td>
                <Td numeric>{a.count.toLocaleString("en-GB")}</Td>
                <Td>
                  <span className={`text-ui ${cls}`}>{word}</span>
                </Td>
                <Td className="max-w-[380px] text-meta text-fg-2">
                  {a.reason}
                  {a.basis ? <span className="block text-fg-3">{a.basis}</span> : null}
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
      {preview.statement ? <p className="max-w-[80ch] text-meta text-fg-3">{preview.statement}</p> : null}
    </div>
  );
}

export function ErasureBoard({
  organizationId,
  initialPreview,
  requests,
  clients,
  isOwner,
}: {
  organizationId: string;
  initialPreview: ErasurePreview | null;
  requests: ErasureView[];
  clients: Array<{ id: string; name: string; domains: Array<{ id: string; name: string }> }>;
  /** null when the role could not be read: the API decides. */
  isOwner: boolean | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [scope, setScope] = useState<Scope>("ORGANIZATION");
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const domains = clients.flatMap((c) => c.domains.map((d) => ({ ...d, clientName: c.name })));
  const [domainId, setDomainId] = useState(domains[0]?.id ?? "");
  const [preview, setPreview] = useState<ErasurePreview | null>(initialPreview);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const first = useRef(true);
  const hadInitial = useRef(initialPreview !== null);

  const targetId = scope === "CLIENT" ? clientId : scope === "DOMAIN" ? domainId : undefined;
  const pending = requests.filter((r) => r.state === "PENDING" || r.state === "EXECUTING");
  // A second request for a scope already scheduled would only run twice.
  const alreadyScheduled = pending.some((r) => r.scope === scope && (scope === "ORGANIZATION" || r.targetId === targetId));
  const past = requests.filter((r) => r.state === "COMPLETED" || r.state === "CANCELLED");
  const graceDays = preview?.graceDays ?? null;
  const graceWords = graceDays === null ? "several days" : `${graceDays} day${graceDays === 1 ? "" : "s"}`;

  useEffect(() => {
    // The server already read the workspace preview; re-read only when the
    // scope or target changes (not when a refresh hands down a new object).
    if (first.current) {
      first.current = false;
      if (scope === "ORGANIZATION" && hadInitial.current) return;
    }
    if (scope !== "ORGANIZATION" && !targetId) return;
    let live = true;
    setPreviewing(true);
    setPreviewError(null);
    previewErasure(organizationId, scope, targetId).then((res) => {
      if (!live) return;
      setPreviewing(false);
      if (!res.ok) {
        setPreview(null);
        setPreviewError(res.error.message ?? "What it would erase could not be read.");
        return;
      }
      setPreview(res.data);
    });
    return () => {
      live = false;
    };
  }, [organizationId, scope, targetId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || typed !== "ERASE" || !preview) return;
    setBusy(true);
    setError(null);
    const res = await requestErasureJob(organizationId, { scope, ...(targetId ? { targetId } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setTyped("");
    setReason("");
    toast({ title: "Erasure scheduled", body: "It waits out the grace period first, and can be cancelled until then.", tone: "ok" });
    router.refresh();
  }

  async function cancel(id: string) {
    setCancelling(id);
    const res = await cancelErasureJob(organizationId, id);
    setCancelling(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    toast({ title: "Erasure cancelled", body: "Nothing was erased.", tone: "ok" });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-10">
      {pending.length > 0 ? (
        <section
          data-testid="erasure-pending"
          aria-labelledby="er-pending-head"
          className="flex flex-col gap-2 rounded-sheet border border-fail/40 bg-fail-wash px-4 py-3.5"
        >
          <h2 id="er-pending-head" className="flex items-center gap-2 text-ui font-bold text-fail">
            <span aria-hidden className="size-2 rotate-45 bg-fail" />
            Scheduled, inside the grace period
          </h2>
          <ul className="flex flex-col">
            {pending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-fail/20 py-2.5">
                <span className="text-body font-semibold text-fg">{r.scopeLabel}</span>
                <span className="text-ui text-fg-2">
                  {r.state === "EXECUTING" ? "Running now: it can no longer be cancelled." : `Runs after ${r.runsAfterLabel}. Until then, cancelling it erases nothing.`}
                </span>
                {r.reason ? <span className="text-meta text-fg-3">Reason: {r.reason}</span> : null}
                <span className="flex-1" />
                {r.state === "PENDING" && isOwner !== false ? (
                  <Button size="sm" onClick={() => cancel(r.id)} busy={cancelling === r.id} busyLabel="Cancelling" data-testid="erasure-cancel">
                    Cancel this erasure
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Panel
        id="er-what"
        title="What would be erased"
        why="The API's own count, for the scope chosen. Reports and forensic samples are deleted with the domains; audit and billing records are kept with identifying fields cleared, as the record of what was done."
      >
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <Segmented
            label="Erase personal data for"
            value={scope}
            onChange={setScope}
            options={[
              { value: "ORGANIZATION", label: "The whole workspace" },
              { value: "CLIENT", label: "One client" },
              { value: "DOMAIN", label: "One domain" },
            ]}
          />
          {scope === "CLIENT" ? (
            <Field label="Client" className="min-w-[min(100%,260px)]">
              <Select value={clientId} onChange={(e) => setClientId(e.target.value)} className="w-full max-w-[420px]">
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {scope === "DOMAIN" ? (
            <Field label="Domain" className="min-w-[min(100%,260px)]">
              <Select value={domainId} onChange={(e) => setDomainId(e.target.value)} className="w-full max-w-[420px]">
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.clientName})
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
        {previewing ? <p className="text-ui text-fg-3">Counting for the scope chosen…</p> : null}
        {previewError ? (
          <Notice tone="fail" title="What it would erase could not be read">
            {previewError} An erasure is not offered without it.
          </Notice>
        ) : null}
        {preview ? (
          <div className={previewing ? "opacity-40 transition-opacity" : "transition-opacity"} aria-busy={previewing || undefined}>
            <PreviewTable preview={preview} />
          </div>
        ) : null}
      </Panel>

      <DangerZone
        title="Schedule the erasure"
        consequence={
          <>
            <p>
              Erasure is destructive and irreversible once it runs: real customer data is deleted, and nobody, including
              us, can bring it back. It waits a grace period of {graceWords} first, and can be cancelled until then.
            </p>
            <p className="mt-1">
              Free on every plan. If anyone will need the data,{" "}
              <Link href="/settings/export" className="link">
                export it first
              </Link>
              .
            </p>
          </>
        }
      >
        <StopLine
          label="What happens to an erasure request"
          className="my-2 max-w-[640px]"
          segments={["planned", "planned"]}
          stops={[
            { key: "scheduled", name: "Scheduled", note: "By the owner, with ERASE typed" },
            { key: "grace", name: "Grace period", note: `${graceWords}: cancel it and nothing is erased` },
            { key: "erased", name: "Erased", note: "Cannot be undone", terminus: true },
          ]}
        />
        {isOwner === false ? (
          <p className="text-ui text-fg-3">Only the workspace owner can schedule an erasure.</p>
        ) : (
          <form onSubmit={submit} className="flex max-w-[640px] flex-col gap-4">
            <Field label="Reason" hint="Optional, up to 280 characters. Kept on the request, for whoever audits it later.">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={280} rows={2} placeholder="Client offboarded; erasure requested in writing on 20 Oct" />
            </Field>
            <Field label={<>Type <code className="data text-fg">ERASE</code> to confirm</>}>
              <Input mono value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className="max-w-[200px]" data-testid="erasure-confirm" />
            </Field>
            <ActionRefusal error={error} />
            {alreadyScheduled ? (
              <p className="text-ui font-medium text-fg-2">This scope is already scheduled above. Cancel that one first to change it.</p>
            ) : null}
            <div>
              <Button type="submit" variant="danger" busy={busy} busyLabel="Scheduling the erasure" disabled={typed !== "ERASE" || !preview || previewing || alreadyScheduled} data-testid="erasure-submit">
                Schedule erasure of {preview?.scopeLabel === "workspace" || scope === "ORGANIZATION" ? "the whole workspace" : scope === "CLIENT" ? "this client" : "this domain"}
              </Button>
            </div>
          </form>
        )}
      </DangerZone>

      {past.length > 0 ? (
        <Panel id="er-past" title="Earlier requests" why="The record of every erasure asked for here, and what became of it.">
          <Table caption="Earlier erasure requests" minWidth={620} dense>
            <THead>
              <tr>
                <Th>Requested</Th>
                <Th>Scope</Th>
                <Th>Outcome</Th>
                <Th>Reason</Th>
              </tr>
            </THead>
            <TBody>
              {past.length === 0 ? (
                <TEmptyRow colSpan={4}>No earlier request.</TEmptyRow>
              ) : (
                past.map((r) => (
                  <Tr key={r.id}>
                    <Td className="tnum whitespace-nowrap text-meta">{r.requestedLabel ?? "not recorded"}</Td>
                    <Td className="font-semibold">{r.scopeLabel}</Td>
                    <Td>
                      {r.state === "COMPLETED" ? (
                        <span className="text-ui font-bold text-fg">Erased</span>
                      ) : (
                        <LineStateWord state="none">Cancelled</LineStateWord>
                      )}
                    </Td>
                    <Td className="max-w-[360px] text-meta text-fg-2">{r.reason ?? <span className="text-fg-4">none given</span>}</Td>
                  </Tr>
                ))
              )}
            </TBody>
          </Table>
        </Panel>
      ) : null}
    </div>
  );
}
