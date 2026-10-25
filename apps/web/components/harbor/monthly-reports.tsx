"use client";

/**
 * monthly-reports.tsx — issue, download and schedule a client's monthly
 * evidence report.
 *
 * The report is client-level: one PDF a month covering every domain that
 * client owns. The history keeps superseded copies because an auditor may
 * still hold one, and each row links to the same public verifier the
 * compliance pack uses.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  deleteMonthlyReportSchedule,
  issueMonthlyReport,
  saveMonthlyReportSchedule,
} from "@/lib/ops-client";
import type { MonthlyReportRow, MonthlyReportSchedule } from "@/lib/types";
import { instantLabel } from "@/lib/instant";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { CopyButton } from "@/components/ui/copy";
import { Field, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { ErrorState } from "@/components/ui/states";
import { Table, TBody, Td, TEmptyRow, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { Panel } from "./settings/parts";

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
  reports: MonthlyReportRow[] | null;
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
    <div data-testid="monthly-reports" className="flex flex-col gap-10">
      <Panel
        id="monthly-issue"
        title="Issue a report"
        why={`One PDF for ${clientName}, covering a complete calendar month across every domain. Issuing again for the same month marks the previous report superseded; both stay verifiable.`}
      >
        {canManage ? (
          <form
            data-testid="monthly-issue-form"
            className="flex flex-col gap-4"
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
            </div>
            <p className="max-w-[72ch] text-meta text-fg-3">
              Only months that have ended can be reported. A month before this client was created has no evidence and is
              refused. Available to download while the reports it summarises are held.
            </p>
            <ActionRefusal error={issueError} />
            {issued ? (
              <div
                data-testid="monthly-issued"
                className="flex flex-col gap-3 rounded-ctl border border-act/40 bg-paper-2 px-4 py-3.5 shadow-[0_0_0_3px_var(--color-act-line)]"
              >
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <p className="text-body font-semibold text-fg">Issued</p>
                  <code className="data text-ui text-fg-2">{issued.reference}</code>
                </div>
                <div>
                  <p className="legend">SHA-256 fingerprint</p>
                  <div className="mt-1 flex items-start gap-2 rounded-ctl border border-rule bg-paper-3 py-1.5 pl-2.5 pr-1.5">
                    <code className="data min-w-0 flex-1 break-all pt-[3px] text-meta text-fg">{issued.sha256}</code>
                    <CopyButton value={issued.sha256} label="Copy the report fingerprint" />
                  </div>
                </div>
                <p className="text-ui text-fg-2">
                  Anyone can check it on the{" "}
                  <Link href={`/verify?reference=${encodeURIComponent(issued.reference)}`} className="link" target="_blank">
                    public verify page
                  </Link>
                  . A match proves the file is the one issued here, unchanged.
                </p>
                <a href={issued.href} download={issued.filename} className="link text-ui font-semibold">
                  Save the PDF again
                </a>
              </div>
            ) : null}
          </form>
        ) : (
          <p className="text-ui text-fg-2">An owner or admin can issue reports.</p>
        )}
      </Panel>

      <Panel
        id="monthly-history"
        title="Issued reports"
        why="Newest first. A superseded report is still verifiable; it is kept because an auditor may already hold it."
        testId="monthly-history-panel"
      >
        {reports === null ? (
          <ErrorState
            what="the monthly report history"
            detail="This is a connection or API problem, not an empty history. Nothing was changed."
          />
        ) : (
          <div data-testid="monthly-history">
            <Table caption={`Monthly reports issued for ${clientName}`} minWidth={840} dense>
              <THead>
                <tr>
                  <Th>Period</Th>
                  <Th>Reference</Th>
                  <Th>SHA-256</Th>
                  <Th>Issued</Th>
                  <Th>Status</Th>
                  <Th align="right">
                    <span className="sr-only">Download and verify</span>
                  </Th>
                </tr>
              </THead>
              <TBody>
                {reports.length === 0 ? (
                  <TEmptyRow colSpan={6}>No monthly report has been issued for this client yet.</TEmptyRow>
                ) : (
                  reports.map((report) => (
                    <Tr key={report.id} data-testid={`monthly-report-${report.id}`}>
                      <Td className="whitespace-nowrap">{periodLabel(report.period)}</Td>
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
                      <Td className="whitespace-nowrap text-meta">{instantLabel(report.issuedAt)}</Td>
                      <Td>
                        {report.superseded ? <Badge tone="neutral">Superseded</Badge> : <Badge tone="ok">Current</Badge>}
                      </Td>
                      <Td align="right">
                        <span className="inline-flex items-center gap-3">
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
      </Panel>

      <Panel
        id="monthly-schedule"
        title="Schedule"
        why="Issue the previous complete month automatically and email each recipient a download link. Links expire after 30 days."
        testId="monthly-schedule-panel"
      >
        {scheduleFailed ? (
          <ErrorState
            what="the report schedule"
            detail="The history above is still readable. Nothing about the schedule was changed."
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
            <div className="flex flex-wrap items-end gap-4">
              <Checkbox
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                label="Send this report automatically"
              />
              <Field label="Day of month" className="w-[150px]">
                <Select
                  value={String(dayOfMonth)}
                  onChange={(event) => setDayOfMonth(Number(event.target.value))}
                  data-testid="monthly-schedule-day"
                >
                  {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                    <option key={day} value={day}>
                      {day}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Hour (UTC)" className="w-[150px]">
                <Select
                  value={String(sendHourUtc)}
                  onChange={(event) => setSendHourUtc(Number(event.target.value))}
                  data-testid="monthly-schedule-hour"
                >
                  {Array.from({ length: 24 }, (_, hour) => hour).map((hour) => (
                    <option key={hour} value={hour}>
                      {String(hour).padStart(2, "0")}:00 UTC
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Recipients" hint="One email address per line, up to 20.">
              <textarea
                value={recipients}
                onChange={(event) => setRecipients(event.target.value)}
                rows={4}
                spellCheck={false}
                aria-label="Recipients"
                className="w-full rounded-ctl border border-rule-2 bg-paper px-3 py-2 text-ui text-fg outline-none transition-colors focus:border-act focus:ring-2 focus:ring-act/20"
                placeholder={"finance@client.example\nsecurity@client.example"}
                data-testid="monthly-schedule-recipients"
              />
            </Field>

            <p className="text-meta text-fg-3" data-testid="monthly-schedule-next">
              {nextIssue ? `Next issue: ${nextIssue}` : "Next issue: calculated when this page is ready."}
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
      </Panel>
    </div>
  );
}
