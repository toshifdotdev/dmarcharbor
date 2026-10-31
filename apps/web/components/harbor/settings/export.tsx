"use client";

/**
 * export.tsx — a copy of the data held here, as JSON or CSV.
 *
 * Free on every plan, because it is a data-protection right, not a feature.
 * The download link is the sensitive part: it is shown once on this page
 * (only its hash is stored) and emailed to the person who asked, works for a
 * fixed number of days, and can be killed early. The page draws that life as
 * three stops on one line before the form, and revoking one says it kills the
 * emailed copy too. The list below is the record of every link handed out.
 *
 * Test hooks: export-request, export-download.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createExportJob, revokeExportJob } from "@/lib/ops-client";
import type { ExportJob } from "@/lib/types";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Segmented, Select } from "@/components/ui/field";
import { Table, TBody, Td, TEmptyRow, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { LineStateWord, StopLine } from "./lines";
import { Panel } from "./parts";

type Scope = "ORGANIZATION" | "CLIENT" | "DOMAIN";

export interface ExportView {
  id: string;
  scopeLabel: string;
  format: "JSON" | "CSV";
  state: "READY" | "REVOKED" | "EXPIRED";
  requestedLabel: string;
  linkEndsLabel: string | null;
  downloadedLabel: string | null;
}

export function ExportBoard({
  organizationId,
  jobs,
  linkDays,
  clients,
  canRevoke,
}: {
  organizationId: string;
  jobs: ExportView[];
  linkDays: number;
  clients: Array<{ id: string; name: string; domains: Array<{ id: string; name: string }> }>;
  canRevoke: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [scope, setScope] = useState<Scope>("ORGANIZATION");
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const domains = clients.flatMap((c) => c.domains.map((d) => ({ ...d, clientName: c.name })));
  const [domainId, setDomainId] = useState(domains[0]?.id ?? "");
  const [format, setFormat] = useState<"JSON" | "CSV">("JSON");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [ready, setReady] = useState<ExportJob | null>(null);
  const [revoking, setRevoking] = useState<ExportView | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const targetId = scope === "CLIENT" ? clientId : scope === "DOMAIN" ? domainId : undefined;
  const live = jobs.filter((j) => j.state === "READY").length;

  async function request(e: FormEvent) {
    e.preventDefault();
    if (busy || (scope !== "ORGANIZATION" && !targetId)) return;
    setBusy(true);
    setError(null);
    const res = await createExportJob(organizationId, { scope, format, ...(targetId ? { targetId } : {}) });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setReady(res.data);
    router.refresh();
  }

  async function revoke() {
    if (!revoking) return;
    setRevokeBusy(true);
    const res = await revokeExportJob(organizationId, revoking.id);
    setRevokeBusy(false);
    if (!res.ok && res.status !== 404) {
      setError(res.error);
      setRevoking(null);
      return;
    }
    if (ready?.id === revoking.id) setReady(null);
    toast({ title: "Download link revoked", body: "The emailed copy stops working too.", tone: "ok" });
    setRevoking(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-10">
      <Panel
        id="ex-new"
        title="Request an export"
        why={`It is prepared from the data held at that moment, then available to download for ${linkDays} days from a link shown once here and emailed to you. Free on every plan.`}
      >
        <StopLine
          label="What happens to an export"
          className="my-3 max-w-[760px]"
          segments={["planned", "planned"]}
          stops={[
            { key: "prepare", name: "Prepared", note: "From what is held when you ask" },
            { key: "link", name: "Link shown once", note: "Here, and in an email to you" },
            { key: "end", name: "Link ends", note: `After ${linkDays} days, or when revoked`, terminus: true },
          ]}
        />

        <form onSubmit={request} className="flex max-w-[680px] flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <span aria-hidden className="text-meta font-semibold text-fg-2">
              What to export
            </span>
            <div>
              <Segmented
                label="What to export"
                value={scope}
                onChange={setScope}
                options={[
                  { value: "ORGANIZATION", label: "The whole workspace" },
                  { value: "CLIENT", label: "One client" },
                  { value: "DOMAIN", label: "One domain" },
                ]}
              />
            </div>
          </div>
          {scope === "CLIENT" ? (
            <Field label="Client">
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
            <Field label="Domain">
              <Select value={domainId} onChange={(e) => setDomainId(e.target.value)} className="w-full max-w-[420px]">
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.clientName})
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-meta font-semibold text-fg-2">Format</span>
            <Segmented
              label="Format"
              size="sm"
              value={format}
              onChange={setFormat}
              options={[
                { value: "JSON", label: "JSON" },
                { value: "CSV", label: "CSV" },
              ]}
            />
            <span className="text-meta text-fg-3">{format === "JSON" ? "Everything, nested as it is held." : "Flat tables for a spreadsheet."}</span>
          </div>
          <ActionRefusal error={error} />
          <div>
            <Button type="submit" variant="primary" busy={busy} busyLabel="Preparing the export" data-testid="export-request">
              Prepare export
            </Button>
          </div>
        </form>

        {ready?.downloadUrl ? (
          <div role="status" className="mt-2 flex max-w-[680px] flex-col gap-2 rounded-sheet border border-fg px-4 py-3.5">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <LineStateWord state="live">Ready</LineStateWord>
              <span className="text-meta font-semibold text-fg-2">shown once</span>
            </p>
            <p className="text-ui text-fg-2">
              The {ready.format} export of {ready.scopeLabel || "this workspace"} is prepared. This link is not shown on this page
              again; the same link is in the email.
            </p>
            <div>
              <a href={ready.downloadUrl} className="link text-body font-semibold" data-testid="export-download">
                Download the export
              </a>
            </div>
          </div>
        ) : null}
      </Panel>

      <Panel
        id="ex-list"
        title="Exports"
        why="Every link handed out, newest first. Each works until it expires or is revoked. Revoke one you sent to the wrong person."
        aside={jobs.length > 0 ? <span className="tnum">{live} of {jobs.length} still work</span> : null}
      >
        <Table caption="Export requests" minWidth={680} dense>
          <THead>
            <tr>
              <Th>Requested</Th>
              <Th>What</Th>
              <Th>Format</Th>
              <Th>Link</Th>
              <Th align="right">
                <span className="sr-only">Action</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {jobs.length === 0 ? (
              <TEmptyRow colSpan={5}>No export has been requested.</TEmptyRow>
            ) : (
              jobs.map((j) => (
                <Tr key={j.id}>
                  <Td className="tnum whitespace-nowrap text-meta">{j.requestedLabel}</Td>
                  <Td>{j.scopeLabel}</Td>
                  <Td mono className="text-meta">
                    {j.format}
                  </Td>
                  <Td className="text-meta">
                    {j.state === "READY" ? (
                      <>
                        <LineStateWord state="live">Works until {j.linkEndsLabel ?? "its end date"}</LineStateWord>
                        <span className="block text-fg-3">{j.downloadedLabel ? `Downloaded ${j.downloadedLabel}` : "Not downloaded yet"}</span>
                      </>
                    ) : j.state === "REVOKED" ? (
                      <LineStateWord state="none">Revoked</LineStateWord>
                    ) : (
                      <LineStateWord state="paused">Expired</LineStateWord>
                    )}
                  </Td>
                  <Td align="right">
                    {j.state === "READY" && canRevoke ? (
                      <Button size="sm" variant="ghost" onClick={() => setRevoking(j)}>
                        Revoke link
                      </Button>
                    ) : null}
                  </Td>
                </Tr>
              ))
            )}
          </TBody>
        </Table>
      </Panel>

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={revoke}
        title="Revoke this download link?"
        body={<p>The link stops working at once, including the copy in the email. Request a new export if it is still needed.</p>}
        confirmLabel="Revoke link"
        busy={revokeBusy}
        danger
      />
    </div>
  );
}
