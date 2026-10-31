"use client";

/**
 * prospect-board.tsx — check a prospect's domain, and follow up on the
 * reports already sent.
 *
 * A report is a scan of a domain the workspace does not manage yet, kept as it
 * was and shared as a link the agency sends with its pitch. The check comes
 * first, because it is what a salesperson opens the page to do: the domain,
 * the button, and (optionally) who it is for, a line from the agency and a
 * reply-to address. Beside it, the route the report takes, from the domain
 * typed here to the prospect's reply.
 *
 * Below, the reports sent, as a table set like a timetable: which prospect,
 * how risky their domain read, whether they have opened it and when, whether
 * the link still works, and the link itself to copy into an email. Opened
 * counts are the API's own; nothing here guesses at interest.
 *
 * Every timestamp on first paint arrives as a string formatted on the server
 * (the page does it), so the browser never disagrees with the server's HTML.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { ProspectReportRow, ProspectUsage } from "@/lib/types";
import { createProspectReport, deleteProspectReport, revokeProspectReport } from "@/lib/ops-client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/choice";
import { CopyButton } from "@/components/ui/copy";
import { Field, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { OpsSection, RouteList, StateWord, StepLine, type MarkShape } from "./ops-parts";
import { ActionRefusal, type ActionError } from "./plan-refusal";

const LEVEL: Record<ProspectReportRow["level"], { tone: "fail" | "warn" | "ok"; shape: MarkShape; label: string }> = {
  high: { tone: "fail", shape: "diamond", label: "High risk" },
  medium: { tone: "warn", shape: "ring", label: "Some risk" },
  low: { tone: "ok", shape: "square", label: "Low risk" },
};

const STATE: Record<ProspectReportRow["state"], string> = {
  active: "Link live",
  expired: "Expired",
  revoked: "Revoked",
};

/** A report row with its timestamps already in words. */
export interface ProspectView extends ProspectReportRow {
  createdLabel?: string;
  lastViewedLabel?: string | null;
  expiresLabel?: string;
}

function readable(message: string | undefined, fallback: string): string {
  return message && !/^[A-Z_]+$/.test(message.trim()) ? message : fallback;
}

export function ProspectBoard({
  organizationId,
  reports,
  usage,
  canCreate,
  canManage,
}: {
  organizationId: string;
  reports: ProspectView[];
  usage: ProspectUsage;
  /** On the plan and allowed by role. */
  canCreate: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [prospectName, setProspectName] = useState("");
  const [note, setNote] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<(ActionError & { scope: "form" | "row" }) | null>(null);
  const [created, setCreated] = useState<ProspectReportRow | null>(null);
  const left = Math.max(usage.limit - usage.used, 0);
  const opened = reports.filter((r) => r.viewCount > 0).length;

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy("create");
    setError(null);
    setCreated(null);
    const res = await createProspectReport(organizationId, {
      domain: domain.trim(),
      ...(prospectName.trim() ? { prospectName: prospectName.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(contactEmail.trim() ? { contactEmail: contactEmail.trim() } : {}),
    });
    setBusy(null);
    if (!res.ok) {
      setError({
        ...res.error,
        // The monthly allowance is a plan limit; the shared refusal names it as one.
        code: res.error.code === "PROSPECT_LIMIT_REACHED" ? "PLAN_LIMIT_REACHED" : res.error.code,
        message: readable(res.error.message, "The report could not be created. Nothing was saved."),
        scope: "form",
      });
      return;
    }
    setCreated(res.data.report);
    setDomain("");
    setProspectName("");
    setNote("");
    router.refresh();
  }

  async function revoke(id: string) {
    setBusy(`revoke:${id}`);
    setError(null);
    const res = await revokeProspectReport(organizationId, id);
    setBusy(null);
    if (!res.ok) {
      setError({ message: readable(res.error.message, "The link could not be revoked. It still works."), scope: "row" });
      return;
    }
    router.refresh();
  }

  async function remove(id: string) {
    setBusy(`delete:${id}`);
    setError(null);
    const res = await deleteProspectReport(organizationId, id);
    setBusy(null);
    if (!res.ok) {
      setError({ message: readable(res.error.message, "The report could not be removed."), scope: "row" });
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-12">
      <OpsSection
        id="new-head"
        title="Check a prospect"
        meta={
          <span data-testid="prospects-usage">
            {usage.limit > 0
              ? `${usage.used} of ${usage.limit} used this month; ${left} left until ${new Date(usage.resetsAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })}.`
              : "Not on this workspace's plan."}
          </span>
        }
      >
        <div className="grid gap-x-14 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.62fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            {created ? (
              <Notice tone="ok" title={`The report for ${created.domain} is ready to send`}>
                <div className="mt-1 flex flex-col gap-2">
                  <div data-copy-scope className="flex flex-wrap items-center gap-2">
                    <span data-copy-value className="data break-all text-meta text-fg">
                      {created.url}
                    </span>
                    <CopyButton value={created.url} label="Copy link" testId="prospect-created-copy" />
                  </div>
                  <p className="text-meta text-fg-2">
                    Paste it into your email to them.{" "}
                    <a className="link font-semibold" href={created.url} target="_blank" rel="noreferrer">
                      Open the page
                    </a>{" "}
                    to see what they will see.
                  </p>
                </div>
              </Notice>
            ) : null}
            {canCreate ? (
              <form onSubmit={create} className="flex flex-col gap-4" data-testid="prospect-form">
                <div className="grid items-start gap-x-3 gap-y-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <Field label="Their domain" hint="Any public domain. They do not need to be a client or to verify anything.">
                    <Input
                      mono
                      size="lg"
                      value={domain}
                      onChange={(event) => setDomain(event.target.value)}
                      placeholder="prospect.example"
                      data-testid="prospect-domain"
                      autoCapitalize="none"
                      spellCheck={false}
                      required
                    />
                  </Field>
                  <div className="sm:pt-[25px]">
                    <Button
                      type="submit"
                      variant="primary"
                      size="lg"
                      busy={busy === "create"}
                      busyLabel="Checking DNS"
                      disabled={!domain.trim() || left === 0}
                      data-testid="prospect-create"
                    >
                      Check and create the link
                    </Button>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Who it is for" hint="Optional. Shown at the top of the report.">
                    <Input value={prospectName} onChange={(event) => setProspectName(event.target.value)} placeholder="Their company name" maxLength={120} />
                  </Field>
                  <Field label="Reply-to address" hint="Optional. The report asks them to reply here.">
                    <Input
                      type="email"
                      value={contactEmail}
                      onChange={(event) => setContactEmail(event.target.value)}
                      placeholder="sales@youragency.example"
                    />
                  </Field>
                </div>
                <Field label="A note from you" hint="Optional, up to 600 characters.">
                  <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={600} className="min-h-[64px]" />
                </Field>
                {error?.scope === "form" ? <ActionRefusal error={error} /> : null}
                {left === 0 && usage.limit > 0 ? (
                  <p className="text-meta font-semibold text-fg-2">
                    This month&rsquo;s allowance is used. Reports already sent keep working; new checks open again on the reset date above.
                  </p>
                ) : null}
              </form>
            ) : (
              <p className="max-w-[60ch] text-ui text-fg-3">
                New checks cannot be made from this workspace just now; the notice above says why. The reports already sent
                stay below and can still be revoked.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-3 lg:border-l lg:border-rule lg:pl-10">
            <p className="text-meta font-semibold text-fg-2">What happens when you check</p>
            <RouteList
              label="What happens to a prospect report"
              stops={[
                { key: "domain", shape: "origin", name: "Their domain", kind: "typed here" },
                { key: "dns", shape: "station", name: "Public DNS", kind: "read once, now, and kept as it was" },
                { key: "page", shape: "station", name: "The report page", kind: "in plain language, under your name; the link lasts 30 days" },
                { key: "reply", shape: "terminus", planned: true, name: "Their reply", kind: "to your reply-to address" },
              ]}
            />
            <p className="text-meta text-fg-3">
              The page never checks again, so what they read is what you saw. Revoke the link here at any time.
            </p>
          </div>
        </div>
      </OpsSection>

      <OpsSection
        id="sent-head"
        title="Sent"
        meta={
          reports.length > 0 ? (
            <>
              <span className="tnum">{reports.length}</span> report{reports.length === 1 ? "" : "s"},{" "}
              <span className="tnum">{opened}</span> opened
            </>
          ) : null
        }
      >
        {error?.scope === "row" ? <ActionRefusal error={error} /> : null}
        {reports.length === 0 ? (
          <div role="status" className="flex flex-col gap-6 border-y border-rule py-6">
            <p className="max-w-[68ch] text-ui text-fg-2" data-testid="prospects-empty">
              No prospect reports yet. Check a prospect&rsquo;s domain above and send them the link; whether they open it
              shows here.
            </p>
            <StepLine
              steps={[
                { title: "Check their domain", body: "Their domain and company name, and a line from you." },
                { title: "Send the link", body: "Copy it into your email. It lasts 30 days." },
                { title: "See it opened", body: "How often and when, so you know when to call." },
              ]}
            />
          </div>
        ) : (
          <div data-testid="prospects-list">
            <Table caption="Prospect reports sent from this workspace" minWidth={940}>
              <THead>
                <tr>
                  <Th>Prospect</Th>
                  <Th>Their domain read</Th>
                  <Th numeric>Opened</Th>
                  <Th>Link</Th>
                  <Th>Sent</Th>
                  <Th align="right">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </THead>
              <TBody>
                {reports.map((report) => {
                  const level = LEVEL[report.level];
                  const live = report.state === "active";
                  return (
                    <Tr key={report.id} data-testid={`prospect-row-${report.id}`}>
                      <Td className="max-w-[260px]">
                        <p className="data truncate font-semibold text-fg" title={report.domain}>
                          {report.domain}
                        </p>
                        <p className="mt-0.5 truncate text-meta text-fg-3">{report.prospectName ?? "No name given"}</p>
                      </Td>
                      <Td className="whitespace-nowrap">
                        <StateWord shape={level.shape} tone={level.tone}>
                          {level.label}
                        </StateWord>
                        <p className="tnum mt-0.5 text-meta text-fg-3">Score {report.score}</p>
                      </Td>
                      <Td numeric>
                        <p className={report.viewCount > 0 ? "font-semibold text-fg" : "text-fg-3"}>
                          {report.viewCount > 0 ? `${report.viewCount} time${report.viewCount === 1 ? "" : "s"}` : "Not yet"}
                        </p>
                        {report.lastViewedAt ? (
                          <p className="mt-0.5 text-meta text-fg-3">last {report.lastViewedLabel ?? report.lastViewedAt.slice(0, 10)}</p>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap">
                        <p className={live ? "inline-flex items-center gap-1.5 font-semibold text-fg" : "inline-flex items-center gap-1.5 text-fg-3"}>
                          <span aria-hidden className={live ? "block size-2 rounded-full bg-fg" : "block size-2 rounded-full border-[1.5px] border-rule-2"} />
                          {STATE[report.state]}
                        </p>
                        {live ? <p className="tnum mt-0.5 text-meta text-fg-3">until {report.expiresLabel ?? report.expiresAt.slice(0, 10)}</p> : null}
                      </Td>
                      <Td className="whitespace-nowrap">
                        <p className="tnum text-meta text-fg-2">{report.createdLabel ?? report.createdAt.slice(0, 10)}</p>
                        {report.createdBy ? <p className="mt-0.5 text-meta text-fg-3">by {report.createdBy.name}</p> : null}
                      </Td>
                      <Td align="right" className="whitespace-nowrap">
                        <span className="inline-flex items-center justify-end gap-2">
                          {live ? (
                            <>
                              <a className="link text-meta" href={report.url} target="_blank" rel="noreferrer">
                                Open the page
                              </a>
                              <CopyButton value={report.url} label="Copy link" testId={`prospect-copy-${report.id}`} />
                              {canManage ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  busy={busy === `revoke:${report.id}`}
                                  busyLabel="Revoking"
                                  onClick={() => revoke(report.id)}
                                >
                                  Revoke link
                                </Button>
                              ) : null}
                            </>
                          ) : canManage ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              busy={busy === `delete:${report.id}`}
                              busyLabel="Removing"
                              onClick={() => remove(report.id)}
                            >
                              Remove
                            </Button>
                          ) : null}
                        </span>
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}
      </OpsSection>
    </div>
  );
}
