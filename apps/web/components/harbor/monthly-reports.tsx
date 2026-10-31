"use client";

/**
 * monthly-reports.tsx — issue, download and schedule a client's monthly
 * evidence report.
 *
 * The report is client-level: one PDF a month covering every domain that
 * client owns. The history keeps superseded copies because an auditor may
 * still hold one, and each row links to the same public verifier the
 * compliance pack uses.
 *
 * The page opens on the client's year drawn as a line: one station per
 * complete month the client can be reported on, inked where a current report
 * was issued and closed in grey where none was, and a dashed last stretch to
 * this month, which cannot be reported until it ends. An account manager
 * reads at a glance whether last month went out, then issues it beside the
 * line, and keeps the schedule in the column at the right.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clsx } from "clsx";
import {
  deleteMonthlyReportSchedule,
  issueMonthlyReport,
  saveMonthlyReportSchedule,
} from "@/lib/ops-client";
import type { MonthlyReportRow, MonthlyReportSchedule } from "@/lib/types";
import { instantLabel } from "@/lib/instant";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Button } from "@/components/ui/button";
import { Checkbox, Textarea } from "@/components/ui/choice";
import { CopyButton, CopyValue } from "@/components/ui/copy";
import { Field, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { ErrorState } from "@/components/ui/states";
import { Table, TBody, Td, TEmptyRow, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { OpsSection, StateWord } from "./ops-parts";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function periodLabel(value: string | null): string {
  if (!value) return "not recorded";
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${MONTH_NAMES[month - 1]} ${match[1]}` : value;
}

function nextIssueLabel(dayOfMonth: number, sendHourUtc: number): string {
  const now = new Date();
  const target = (monthOffset: number): Date =>
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() + monthOffset,
        dayOfMonth,
        sendHourUtc,
        0,
        0,
        0,
      ),
    );
  const next = target(0).getTime() > now.getTime() ? target(0) : target(1);
  const date = next.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${date} at ${String(sendHourUtc).padStart(2, "0")}:00 UTC`;
}

function download(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** A report row, with its issue time already in words (the page does it). */
export type MonthlyReportView = MonthlyReportRow & { issuedLabel?: string };

export function MonthlyReportClientPicker({
  clients,
  selected,
}: {
  clients: Array<{ id: string; name: string }>;
  selected: string;
}) {
  const router = useRouter();
  return (
    <label className="flex flex-wrap items-center gap-3">
      <span className="text-meta font-semibold text-fg-2">Client</span>
      <Select
        value={selected}
        onChange={(event) =>
          router.push(`/clients/reports?client=${encodeURIComponent(event.target.value)}`)
        }
        className="min-w-[260px]"
        data-testid="monthly-client-picker"
      >
        {clients.map((client) => (
          <option key={client.id} value={client.id}>
            {client.name}
          </option>
        ))}
      </Select>
    </label>
  );
}

/**
 * The client's reportable months as a line, oldest at the left. Stations are
 * inked where a current report exists, closed where none does; the dashed
 * end is this month, which is not complete yet.
 */
function YearLine({
  months,
  issued,
  selected,
  clientName,
}: {
  months: Array<{ value: string; label: string }>;
  issued: Set<string>;
  selected: string;
  clientName: string;
}) {
  const ordered = [...months].reverse();
  const done = ordered.filter((m) => issued.has(m.value)).length;
  return (
    <figure className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-rule pb-2">
        <span className="text-ui font-semibold text-fg">{clientName}</span>
        <span className="text-meta text-fg-3">
          <span className="tnum">{done}</span> of <span className="tnum">{ordered.length}</span> complete month
          {ordered.length === 1 ? "" : "s"} reported
        </span>
      </div>
      <ol
        aria-label={`Months reported for ${clientName}`}
        className="grid"
        style={{ gridTemplateColumns: `repeat(${ordered.length + 1}, minmax(0, 1fr))` }}
      >
        {ordered.map((m, i) => {
          const [year, mm] = m.value.split("-");
          const short = MONTH_NAMES[Number(mm) - 1]?.slice(0, 3) ?? mm;
          const on = issued.has(m.value);
          const here = m.value === selected;
          const showYear = i === 0 || mm === "01";
          return (
            <li key={m.value} className="relative flex min-w-0 flex-col items-center">
              {/* The segment to the next stop: inked between complete months,
                  dashed into this month, which is still running. */}
              <span
                aria-hidden
                className="absolute left-1/2 top-[10px] h-[5px] w-full"
                style={
                  i === ordered.length - 1
                    ? { backgroundImage: "repeating-linear-gradient(to right, var(--color-fg) 0 6px, transparent 6px 11px)" }
                    : { background: "var(--color-fg)" }
                }
              />
              <span aria-hidden className="relative z-[1] flex h-[25px] items-center">
                <span
                  className={clsx(
                    "relative block rounded-full border-[3px] bg-paper",
                    here ? "h-[25px] w-[19px]" : "size-[19px]",
                    on ? "border-fg" : "border-rule-2",
                  )}
                >
                  {on ? <span className="absolute inset-[3px] rounded-full bg-fg" /> : null}
                </span>
              </span>
              <span className={clsx("mt-1.5 text-meta", on ? "font-semibold text-fg" : "text-fg-3", here && "underline decoration-2 underline-offset-4")}>
                {short}
              </span>
              <span className="tnum h-4 text-[11px] leading-4 text-fg-3">{showYear ? year : ""}</span>
              <span className="sr-only">
                {periodLabel(m.value)}: {on ? "issued" : "not issued"}
                {here ? ", the month chosen to issue" : ""}
              </span>
            </li>
          );
        })}
        <li className="relative flex min-w-0 flex-col items-center">
          <span aria-hidden className="relative z-[1] flex h-[25px] items-center">
            <span className="block h-[25px] w-[19px] rounded-full border-[3px] border-rule-2 bg-paper" />
          </span>
          <span className="mt-1.5 text-meta text-fg-3">Now</span>
          <span className="h-4" />
          <span className="sr-only">This month: not complete, so it cannot be reported yet</span>
        </li>
      </ol>
      <figcaption className="flex flex-wrap items-center gap-x-5 gap-y-1 text-meta text-fg-3">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="relative block size-3 rounded-full border-2 border-fg bg-paper">
            <span className="absolute inset-[2px] rounded-full bg-fg" />
          </span>
          Report issued
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="block size-3 rounded-full border-2 border-rule-2 bg-paper" />
          Not issued
        </span>
        <span>The month to issue is underlined.</span>
      </figcaption>
    </figure>
  );
}

export function MonthlyReportsBoard({
  organizationId,
  clientId,
  clientName,
  reports,
  schedule: initialSchedule,
  scheduleFailed,
  periodOptions,
  canManage,
}: {
  organizationId: string;
  clientId: string;
  clientName: string;
  reports: MonthlyReportView[] | null;
  schedule: MonthlyReportSchedule | null;
  scheduleFailed: boolean;
  periodOptions: Array<{ value: string; label: string }>;
  canManage: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [period, setPeriod] = useState(periodOptions[0]?.value ?? "");
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<ActionError | null>(null);
  const [issued, setIssued] = useState<{ reference: string; sha256: string; filename: string; href: string } | null>(null);

  const [schedule, setSchedule] = useState<MonthlyReportSchedule | null>(initialSchedule);
  const [enabled, setEnabled] = useState(initialSchedule?.enabled ?? true);
  const [dayOfMonth, setDayOfMonth] = useState(initialSchedule?.dayOfMonth ?? 2);
  const [sendHourUtc, setSendHourUtc] = useState(initialSchedule?.sendHourUtc ?? 9);
  const [recipients, setRecipients] = useState((initialSchedule?.recipientEmails ?? []).join("\n"));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [scheduleError, setScheduleError] = useState<ActionError | null>(null);
  const [nextIssue, setNextIssue] = useState<string | null>(null);

  useEffect(() => {
    setNextIssue(nextIssueLabel(dayOfMonth, sendHourUtc));
  }, [dayOfMonth, sendHourUtc]);

  const current = new Set((reports ?? []).filter((r) => !r.superseded && r.period).map((r) => r.period as string));
  const periodIssued = period ? current.has(period) : false;
  const recipientCount = recipients
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean).length;

  async function issue() {
    if (!period) return;
    setIssuing(true);
    setIssueError(null);
    const result = await issueMonthlyReport(organizationId, clientId, period);
    setIssuing(false);
    if (!result.ok) {
      setIssueError(result.error);
      return;
    }
    download(result.data.bytes, result.data.filename);
    setIssued({
      reference: result.data.reference,
      sha256: result.data.sha256,
      filename: result.data.filename,
      href: URL.createObjectURL(result.data.bytes),
    });
    toast({
      title: `${clientName}'s ${periodLabel(period)} report issued`,
      tone: "ok",
    });
    router.refresh();
  }

  async function saveSchedule() {
    setSaving(true);
    setScheduleError(null);
    const emails = recipients
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    const result = await saveMonthlyReportSchedule(organizationId, clientId, {
      enabled,
      dayOfMonth,
      sendHourUtc,
      recipientEmails: emails,
    });
    setSaving(false);
    if (!result.ok) {
      setScheduleError(result.error);
      return;
    }
    setSchedule(result.data.schedule);
    setEnabled(result.data.schedule.enabled);
    setDayOfMonth(result.data.schedule.dayOfMonth);
    setSendHourUtc(result.data.schedule.sendHourUtc);
    setRecipients(result.data.schedule.recipientEmails.join("\n"));
    toast({ title: "Monthly report schedule saved", tone: "ok" });
    router.refresh();
  }

  async function removeSchedule() {
    setDeleting(true);
    setScheduleError(null);
    const result = await deleteMonthlyReportSchedule(organizationId, clientId);
    setDeleting(false);
    if (!result.ok) {
      setScheduleError(result.error);
      return;
    }
    setSchedule(null);
    toast({ title: "Monthly report schedule removed", tone: "ok" });
    router.refresh();
  }

  return (
    <div data-testid="monthly-reports" className="grid gap-x-12 gap-y-12 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-12">
        <OpsSection
          id="monthly-issue"
          title="Issue a report"
          why={`One PDF for ${clientName}, covering a complete calendar month across every domain. Issuing again for the same month marks the previous report superseded; both stay verifiable.`}
        >
          {periodOptions.length > 0 ? (
            <YearLine months={periodOptions} issued={current} selected={period} clientName={clientName} />
          ) : (
            <p className="border-y border-rule py-4 text-ui text-fg-2">
              {clientName} has no complete month yet: the first report can be issued once this month ends.
            </p>
          )}
          {canManage ? (
            <form
              data-testid="monthly-issue-form"
              className="flex flex-col gap-4 pt-2"
              onSubmit={(event) => {
                event.preventDefault();
                void issue();
              }}
            >
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Month" className="w-[230px]">
                  <Select
                    value={period}
                    onChange={(event) => setPeriod(event.target.value)}
                    disabled={periodOptions.length === 0}
                    data-testid="monthly-period"
                  >
                    {periodOptions.length === 0 ? (
                      <option value="">No complete month available yet</option>
                    ) : (
                      periodOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                          {current.has(option.value) ? " (issued)" : ""}
                        </option>
                      ))
                    )}
                  </Select>
                </Field>
                <Button
                  type="submit"
                  variant="primary"
                  busy={issuing}
                  busyLabel="Building the report"
                  disabled={!period || periodOptions.length === 0}
                  data-testid="monthly-issue"
                >
                  Issue report
                </Button>
                {periodIssued ? (
                  <span className="pb-2 text-meta text-fg-3">Already issued: a new one supersedes it.</span>
                ) : null}
              </div>
              <p className="max-w-[72ch] text-meta text-fg-3">
                Only months that have ended can be reported. A month before this client was created has no evidence and
                is refused. Available to download while the reports it summarises are held.
              </p>
              <ActionRefusal error={issueError} />
              {issued ? (
                <div data-testid="monthly-issued" className="flex flex-col gap-3 rounded-sheet border border-rule px-4 py-4">
                  <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <StateWord shape="square" tone="ok">
                      Issued
                    </StateWord>
                    <code className="data text-ui text-fg-2">{issued.reference}</code>
                  </p>
                  <div>
                    <p className="legend">SHA-256 fingerprint</p>
                    <CopyValue value={issued.sha256} label="the report fingerprint" className="mt-1" />
                  </div>
                  <p className="text-ui text-fg-2">
                    Anyone can check it on the{" "}
                    <Link href={`/verify?reference=${encodeURIComponent(issued.reference)}`} className="link" target="_blank">
                      public verify page
                    </Link>
                    . A match proves the file is the one issued here, unchanged.
                  </p>
                  <a href={issued.href} download={issued.filename} className="link self-start text-ui font-semibold">
                    Save the PDF again
                  </a>
                </div>
              ) : null}
            </form>
          ) : (
            <p className="text-ui text-fg-2">An owner or admin can issue reports.</p>
          )}
        </OpsSection>

        <OpsSection
          id="monthly-history"
          title="Issued reports"
          meta={reports && reports.length > 0 ? "Newest first" : null}
          why="A superseded report is still verifiable; it is kept because an auditor may already hold it."
          testId="monthly-history-panel"
        >
          {reports === null ? (
            <ErrorState
              what="the monthly report history"
              detail="This is a connection or API problem, not an empty history. Nothing was changed."
            />
          ) : (
            <div data-testid="monthly-history">
              <Table caption={`Monthly reports issued for ${clientName}`} minWidth={800}>
                <THead>
                  <tr>
                    <Th>Period</Th>
                    <Th>Status</Th>
                    <Th>Reference</Th>
                    <Th>SHA-256</Th>
                    <Th>Issued</Th>
                    <Th align="right">
                      <span className="sr-only">Download and verify</span>
                    </Th>
                  </tr>
                </THead>
                <TBody>
                  {reports.length === 0 ? (
                    <TEmptyRow colSpan={6}>
                      No monthly report has been issued for this client yet.
                      {periodOptions.length > 0 && canManage ? " Choose a month above and issue the first." : ""}
                    </TEmptyRow>
                  ) : (
                    reports.map((report) => (
                      <Tr key={report.id} data-testid={`monthly-report-${report.id}`}>
                        <Td className={clsx("whitespace-nowrap font-semibold", report.superseded ? "text-fg-3" : "text-fg")}>
                          {periodLabel(report.period)}
                        </Td>
                        <Td className="whitespace-nowrap">
                          {report.superseded ? (
                            <StateWord shape="ring" tone="void" className="text-meta!">
                              Superseded
                            </StateWord>
                          ) : (
                            <StateWord shape="square" tone="ok" className="text-meta!">
                              Current
                            </StateWord>
                          )}
                        </Td>
                        <Td mono className="text-meta">
                          <span className="inline-flex items-center gap-1.5">
                            {report.reference}
                            <CopyButton value={report.reference} label="Copy the report reference" />
                          </span>
                        </Td>
                        <Td mono className="text-meta text-fg-3" title={report.sha256}>
                          <span className="inline-flex items-center gap-1.5">
                            {report.sha256.slice(0, 12)}…
                            <CopyButton value={report.sha256} label="Copy the SHA-256 digest" />
                          </span>
                        </Td>
                        <Td className="tnum whitespace-nowrap text-meta text-fg-2">{report.issuedLabel ?? instantLabel(report.issuedAt)}</Td>
                        <Td align="right">
                          <span className="inline-flex items-center gap-3 whitespace-nowrap">
                            {report.downloadable ? (
                              <a
                                href={`/api/workspaces/${organizationId}/clients/${clientId}/monthly-reports/${report.id}/download`}
                                className="link text-meta font-semibold"
                                data-testid={`monthly-download-${report.id}`}
                              >
                                Download
                              </a>
                            ) : (
                              <span className="text-meta text-fg-3" title="The aggregate reports this summary covers are no longer held.">
                                No longer held
                              </span>
                            )}
                            <Link
                              href={`/verify?reference=${encodeURIComponent(report.reference)}`}
                              className="link text-meta"
                              target="_blank"
                              data-testid={`monthly-verify-${report.id}`}
                            >
                              Verify
                            </Link>
                          </span>
                        </Td>
                      </Tr>
                    ))
                  )}
                </TBody>
              </Table>
            </div>
          )}
        </OpsSection>
      </div>

      <aside className="flex flex-col self-start lg:sticky lg:top-[104px]">
        <OpsSection
          id="monthly-schedule"
          title="Schedule"
          meta={
            schedule ? (
              schedule.enabled ? (
                <StateWord shape="dot" tone="ink" className="text-meta!">
                  On
                </StateWord>
              ) : (
                <span className="font-semibold">Paused</span>
              )
            ) : (
              "Not set"
            )
          }
          why="Issue the previous complete month automatically and email each recipient a download link. Links expire after 30 days."
          testId="monthly-schedule-panel"
        >
          {scheduleFailed ? (
            <ErrorState
              what="the report schedule"
              detail="The history is still readable. Nothing about the schedule was changed."
            />
          ) : canManage ? (
            <form
              data-testid="monthly-schedule"
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void saveSchedule();
              }}
            >
              <Checkbox
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                label="Send this report automatically"
              />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Day of month">
                  <Select
                    value={String(dayOfMonth)}
                    onChange={(event) => setDayOfMonth(Number(event.target.value))}
                    data-testid="monthly-schedule-day"
                    className="w-full"
                  >
                    {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                      <option key={day} value={day}>
                        {day}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Hour (UTC)">
                  <Select
                    value={String(sendHourUtc)}
                    onChange={(event) => setSendHourUtc(Number(event.target.value))}
                    data-testid="monthly-schedule-hour"
                    className="w-full"
                  >
                    {Array.from({ length: 24 }, (_, hour) => hour).map((hour) => (
                      <option key={hour} value={hour}>
                        {String(hour).padStart(2, "0")}:00 UTC
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <Field
                label="Recipients"
                hint={recipientCount > 0 ? `${recipientCount} of 20. One email address per line.` : "One email address per line, up to 20."}
              >
                <Textarea
                  mono
                  value={recipients}
                  onChange={(event) => setRecipients(event.target.value)}
                  rows={4}
                  spellCheck={false}
                  aria-label="Recipients"
                  placeholder={"finance@client.example\nsecurity@client.example"}
                  data-testid="monthly-schedule-recipients"
                />
              </Field>

              <p className="flex items-baseline gap-2 border-t border-rule pt-3 text-ui text-fg-2" data-testid="monthly-schedule-next">
                {nextIssue ? (
                  <>
                    <span className="font-semibold text-fg">Next issue:</span> <span className="tnum">{nextIssue}</span>
                  </>
                ) : (
                  "Next issue: calculated when this page is ready."
                )}
              </p>

              <ActionRefusal error={scheduleError} />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="primary" busy={saving} busyLabel="Saving the schedule" data-testid="monthly-schedule-save">
                  Save schedule
                </Button>
                {schedule ? (
                  <Button
                    type="button"
                    variant="ghost"
                    busy={deleting}
                    busyLabel="Removing the schedule"
                    onClick={() => void removeSchedule()}
                    data-testid="monthly-schedule-delete"
                  >
                    Remove the schedule
                  </Button>
                ) : null}
              </div>
              {schedule?.lastIssuedPeriod ? (
                <Notice tone="info" title={`Last issued for ${periodLabel(schedule.lastIssuedPeriod)}`} />
              ) : null}
            </form>
          ) : (
            <p className="text-ui text-fg-2">
              {schedule
                ? `A report is scheduled for day ${schedule.dayOfMonth} at ${String(schedule.sendHourUtc).padStart(2, "0")}:00 UTC. An owner or admin can change it.`
                : "No schedule is set. An owner or admin can add one."}
            </p>
          )}
        </OpsSection>
      </aside>
    </div>
  );
}
