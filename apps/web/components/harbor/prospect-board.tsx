"use client";

/**
 * prospect-board.tsx — create a prospect risk report, and the ones already sent.
 *
 * A report is a scan of a domain the workspace does not manage yet, kept as it
 * was and shared as a link the agency sends with its pitch. The form takes the
 * domain and, optionally, who it is for, a line from the agency and a reply-to
 * address; the list shows each link's state and how often it was opened.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { ProspectReportRow, ProspectUsage } from "@/lib/types";
import { createProspectReport, deleteProspectReport, revokeProspectReport } from "@/lib/ops-client";
import { instantLabel } from "@/lib/instant";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/choice";
import { CopyButton } from "@/components/ui/copy";
import { Field, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { ActionRefusal, type ActionError } from "./plan-refusal";

const LEVEL: Record<ProspectReportRow["level"], { tone: Tone; label: string }> = {
  high: { tone: "fail", label: "High risk" },
  medium: { tone: "warn", label: "Some risk" },
  low: { tone: "ok", label: "Low risk" },
};

const STATE: Record<ProspectReportRow["state"], string> = {
  active: "Link live",
  expired: "Expired",
  revoked: "Revoked",
};

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
  reports: ProspectReportRow[];
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
    <div className="grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section aria-labelledby="sent-head" className="flex min-w-0 flex-col gap-3">
        <h2 id="sent-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
          Sent
        </h2>
        {error?.scope === "row" ? <ActionRefusal error={error} /> : null}
        {reports.length === 0 ? (
          <p className="text-ui text-fg-3" data-testid="prospects-empty">
            No prospect reports yet. Check a prospect&rsquo;s domain on the right and send them the link.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-rule border-y border-rule" data-testid="prospects-list">
            {reports.map((report) => (
              <li key={report.id} className="flex flex-col gap-1.5 py-3" data-testid={`prospect-row-${report.id}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="data font-semibold text-fg">{report.domain}</span>
                  {report.prospectName ? <span className="text-ui text-fg-2">{report.prospectName}</span> : null}
                  <Badge tone={LEVEL[report.level].tone}>{LEVEL[report.level].label}</Badge>
                  <span className="tnum text-meta text-fg-3">score {report.score}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-fg-3">
                  <span>{STATE[report.state]}</span>
                  <span>
                    opened <span className="tnum text-fg-2">{report.viewCount}</span> time{report.viewCount === 1 ? "" : "s"}
                    {report.lastViewedAt ? `, last ${instantLabel(report.lastViewedAt)}` : ""}
                  </span>
                  <span>created {instantLabel(report.createdAt)}{report.createdBy ? ` by ${report.createdBy.name}` : ""}</span>
                  {report.state === "active" ? (
                    <span>expires {new Date(report.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {report.state === "active" ? (
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
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="new-head" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="new-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
            Check a prospect
          </h2>
          <p className="text-meta text-fg-3" data-testid="prospects-usage">
            {usage.limit > 0
              ? `${usage.used} of ${usage.limit} used this month; ${left} left until ${new Date(usage.resetsAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })}.`
              : "Not on this workspace's plan."}
          </p>
        </div>
        {created ? (
          <Notice tone="ok" title={`The report for ${created.domain} is ready to send`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="data break-all text-meta">{created.url}</span>
              <CopyButton value={created.url} label="Copy link" testId="prospect-created-copy" />
            </div>
          </Notice>
        ) : null}
        {canCreate ? (
          <form onSubmit={create} className="flex flex-col gap-3" data-testid="prospect-form">
            <Field label="Their domain" hint="Any public domain. They do not need to be a client or to verify anything.">
              <Input
                mono
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder="acme.com"
                data-testid="prospect-domain"
                required
              />
            </Field>
            <Field label="Who it is for" hint="Optional. Shown at the top of the report.">
              <Input value={prospectName} onChange={(event) => setProspectName(event.target.value)} placeholder="Acme Ltd" maxLength={120} />
            </Field>
            <Field label="A note from you" hint="Optional, up to 600 characters.">
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={600} />
            </Field>
            <Field label="Reply-to address" hint="Optional. The report asks them to reply here.">
              <Input
                type="email"
                value={contactEmail}
                onChange={(event) => setContactEmail(event.target.value)}
                placeholder="sales@your-agency.com"
              />
            </Field>
            {error?.scope === "form" ? <ActionRefusal error={error} /> : null}
            <Button
              type="submit"
              variant="primary"
              busy={busy === "create"}
              busyLabel="Checking DNS"
              disabled={!domain.trim() || left === 0}
              className="self-start"
              data-testid="prospect-create"
            >
              Check and create the link
            </Button>
            <p className="text-meta text-fg-3">
              The check reads public DNS once, now. The page they open shows that result and never checks again; the link
              lasts 30 days and can be revoked here at any time.
            </p>
          </form>
        ) : null}
      </section>
    </div>
  );
}
