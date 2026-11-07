"use client";

/**
 * dns-changes.tsx — what changed in this domain's DNS, and who has seen it.
 *
 * The history is the trust signal: a scheduled scan that finds nothing and says
 * nothing is indistinguishable from a monitor that stopped. Each row names the
 * value that changed, shows the before and after, and lets a person acknowledge
 * a WARNING or CRITICAL change so the record says someone read it.
 */

import { useState } from "react";
import { acknowledgeDnsChange, listDnsChanges } from "@/lib/ops-client";
import { toDnsChangeView, type DnsChangeView } from "@/lib/dns-change-view";
import type { DnsChangeSeverityName } from "@/lib/types";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { ErrorState } from "@/components/ui/states";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";

const SEVERITY: Record<DnsChangeSeverityName, { tone: Tone; label: string }> = {
  INFO: { tone: "neutral", label: "Info" },
  WARNING: { tone: "warn", label: "Warning" },
  CRITICAL: { tone: "fail", label: "Critical" },
};

const TIMELINE_DAYS = 90;

/**
 * The changes on a 90-day line ending today, so a failure can be read against
 * the record change just before it. Info is a small grey dot, a warning an
 * amber ring, a critical change a red diamond: the same shapes as the state
 * marks. Drawn from the rows loaded so far; `today` comes from the server.
 */
function ChangeTimeline({ rows, today }: { rows: DnsChangeView[]; today: string }) {
  const end = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  const start = end - (TIMELINE_DAYS - 1) * 86_400_000;
  const inWindow = rows.filter((r) => {
    const t = Date.parse(r.detectedAt);
    return t >= start && t < end + 86_400_000;
  });
  const older = rows.length - inWindow.length;
  const at = (iso: string) => {
    const day = Math.floor((Date.parse(iso) - start) / 86_400_000);
    const frac = (Math.min(TIMELINE_DAYS - 1, Math.max(0, day)) + 0.5) / TIMELINE_DAYS;
    // Inset by 8px each side, so a mark on the first or last day stays whole.
    return `calc(8px + (100% - 16px) * ${frac.toFixed(4)})`;
  };
  const counts = { INFO: 0, WARNING: 0, CRITICAL: 0 };
  for (const r of inWindow) counts[r.severity] += 1;
  const label = `Last ${TIMELINE_DAYS} days: ${counts.CRITICAL} critical, ${counts.WARNING} warning, ${counts.INFO} info changes.`;

  return (
    <figure className="m-0 flex flex-col gap-1.5" data-testid="dns-change-timeline">
      <div role="img" aria-label={label} className="relative h-6">
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-rule" />
        {/* Info first, so a warning or a critical change on the same day sits on top. */}
        {[...inWindow]
          .sort((a, b) => ["INFO", "WARNING", "CRITICAL"].indexOf(a.severity) - ["INFO", "WARNING", "CRITICAL"].indexOf(b.severity))
          .map((r) => (
            <span
              key={r.id}
              aria-hidden
              title={`${r.detectedLabel}: ${r.summary}`}
              className={
                r.severity === "CRITICAL"
                  ? "absolute top-1/2 size-[11px] -translate-x-1/2 -translate-y-1/2 rotate-45 bg-fail"
                  : r.severity === "WARNING"
                    ? "absolute top-1/2 size-[12px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-warn-mark bg-paper"
                    : "absolute top-1/2 size-[8px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg-4"
              }
              style={{ left: at(r.detectedAt) }}
            />
          ))}
      </div>
      <figcaption className="flex flex-wrap justify-between gap-x-4 text-meta text-fg-3">
        <span>{TIMELINE_DAYS} days ago</span>
        <span className="tnum">
          {counts.CRITICAL} critical · {counts.WARNING} warning · {counts.INFO} info
          {older > 0 ? ` · ${older} older below` : ""}
        </span>
        <span>today</span>
      </figcaption>
    </figure>
  );
}

function valuesText(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function DnsChangesPanel({
  organizationId,
  domainId,
  domainName,
  initial,
  loadFailed,
  canAcknowledge,
  rescanIntervalMinutes,
  today,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  initial: { rows: DnsChangeView[]; nextCursor: string | null } | null;
  loadFailed: boolean;
  canAcknowledge: boolean;
  rescanIntervalMinutes: number | null;
  /** The server's UTC day key; the timeline is drawn only when it is given. */
  today?: string;
}) {
  const [rows, setRows] = useState<DnsChangeView[]>(initial?.rows ?? []);
  const [cursor, setCursor] = useState(initial?.nextCursor ?? null);
  const [severity, setSeverity] = useState<"ALL" | DnsChangeSeverityName>("ALL");
  const [busy, setBusy] = useState(false);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const schedule =
    rescanIntervalMinutes === 1440 ? "every day" : "on a schedule";

  async function load(next: "ALL" | DnsChangeSeverityName, cursorValue?: string): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await listDnsChanges(organizationId, domainId, {
      cursor: cursorValue,
      severity: next === "ALL" ? [] : [next],
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message ?? "The DNS change history could not be read.");
      return;
    }
    const now = new Date();
    const nextRows = res.data.rows.map((row) => toDnsChangeView(row, now));
    setRows((current) => (cursorValue ? [...current, ...nextRows] : nextRows));
    setCursor(res.data.nextCursor);
  }

  function chooseSeverity(next: "ALL" | DnsChangeSeverityName): void {
    setSeverity(next);
    void load(next);
  }

  async function acknowledge(row: DnsChangeView): Promise<void> {
    setAcknowledging(row.id);
    setError(null);
    const res = await acknowledgeDnsChange(organizationId, domainId, row.id);
    setAcknowledging(null);
    if (!res.ok) {
      setError(res.error.message ?? "That change could not be acknowledged.");
      return;
    }
    const updated = toDnsChangeView(res.data);
    setRows((current) => current.map((entry) => (entry.id === row.id ? updated : entry)));
  }

  if (loadFailed || initial === null) {
    return (
      <section aria-labelledby="dns-changes-head" className="flex flex-col gap-3 border-t border-rule-2 pt-4" data-testid="dns-changes">
        <h2 id="dns-changes-head" className="text-h3 font-bold tracking-[-0.01em]">
          DNS changes
        </h2>
        <ErrorState
          what="the DNS change history"
          detail="Nothing was changed. This is a read failure, not a domain with no history."
        />
      </section>
    );
  }

  // Filtering an empty history is pointless, unless a filter is what emptied it.
  const filterable = rows.length > 0 || severity !== "ALL" || cursor !== null;
  const unread = rows.filter((row) => row.severity !== "INFO" && !row.acknowledgedAt).length;

  return (
    <section aria-labelledby="dns-changes-head" className="flex flex-col gap-4 border-t border-rule-2 pt-4" data-testid="dns-changes">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="dns-changes-head" className="flex flex-wrap items-baseline gap-x-3 text-h3 font-bold tracking-[-0.01em]">
            DNS changes
            {unread > 0 ? (
              <span className="tnum text-ui font-semibold text-warn">
                {unread} not acknowledged
              </span>
            ) : null}
          </h2>
          <p className="mt-1 max-w-[80ch] text-ui text-fg-2">
            What changed between checks of {domainName}&rsquo;s DMARC, SPF, DKIM, MX, MTA-STS, TLS-RPT and BIMI records. INFO changes are
            history only; WARNING and CRITICAL changes can also notify the workspace.
          </p>
        </div>
        {filterable ? (
        <Field label="Severity" className="w-[170px]">
          <Select
            value={severity}
            onChange={(event) => chooseSeverity(event.target.value as "ALL" | DnsChangeSeverityName)}
            data-testid="dns-change-severity"
          >
            <option value="ALL">All severities</option>
            <option value="INFO">Info</option>
            <option value="WARNING">Warning</option>
            <option value="CRITICAL">Critical</option>
          </Select>
        </Field>
        ) : null}
      </div>

      {error ? (
        <Notice tone="fail" title={error} role="alert" testId="dns-change-error" />
      ) : null}

      {rows.length === 0 ? (
        <section role="status" data-testid="dns-changes-empty" className="border-y border-rule py-3">
          <p className="max-w-[90ch] text-ui text-fg-2">
            <span className="font-semibold text-fg">
              {severity === "ALL" ? "No DNS changes recorded yet." : "No change of this severity is recorded."}
            </span>{" "}
            This domain&rsquo;s DNS is re-checked {schedule}, and each change is listed here.
          </p>
        </section>
      ) : (
        <>
        {today && severity === "ALL" ? <ChangeTimeline rows={rows} today={today} /> : null}
        <Table caption={`DNS changes for ${domainName}`} minWidth={880}>
          <THead>
            <tr>
              <Th>Severity</Th>
              <Th>Change</Th>
              <Th>When</Th>
              <Th>Values</Th>
              <Th>Acknowledgement</Th>
            </tr>
          </THead>
          <TBody>
            {rows.map((row) => (
              <Tr key={row.id} data-testid={`dns-change-row-${row.id}`}>
                <Td>
                  <Badge tone={SEVERITY[row.severity].tone}>{SEVERITY[row.severity].label}</Badge>
                </Td>
                <Td>
                  <span className="block text-ui font-semibold text-fg">{row.summary}</span>
                  <span className="mt-0.5 block text-meta text-fg-3">{row.code}</span>
                </Td>
                <Td muted title={row.detectedLabel}>
                  <span className="block">{row.detectedRelative}</span>
                  <span className="block text-meta">{row.detectedLabel}</span>
                </Td>
                <Td>
                  <details>
                    <summary className="link cursor-pointer text-meta font-semibold" data-testid={`dns-change-values-${row.id}`}>
                      Before and after
                    </summary>
                    <div className="mt-2 grid min-w-[320px] gap-2 lg:grid-cols-2">
                      <div>
                        <p className="legend pb-1">Before</p>
                        <pre className="data max-h-[180px] overflow-auto whitespace-pre-wrap break-all border border-rule bg-paper-3 p-2 text-meta">
                          {valuesText(row.before)}
                        </pre>
                      </div>
                      <div>
                        <p className="legend pb-1">After</p>
                        <pre className="data max-h-[180px] overflow-auto whitespace-pre-wrap break-all border border-rule bg-paper-3 p-2 text-meta">
                          {valuesText(row.after)}
                        </pre>
                      </div>
                    </div>
                  </details>
                </Td>
                <Td>
                  {row.acknowledgedAt ? (
                    <span className="text-meta text-fg-3">
                      Acknowledged by <span className="font-semibold text-fg-2">{row.acknowledgedBy?.name ?? "a member"}</span>
                      <span className="block" title={row.acknowledgedLabel ?? undefined}>
                        {row.acknowledgedRelative}
                      </span>
                    </span>
                  ) : row.severity !== "INFO" ? (
                    canAcknowledge ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => acknowledge(row)}
                        busy={acknowledging === row.id}
                        busyLabel="Acknowledging"
                        data-testid={`dns-change-acknowledge-${row.id}`}
                      >
                        Acknowledge
                      </Button>
                    ) : (
                      <span className="text-meta text-fg-3">An owner, admin or analyst can acknowledge this.</span>
                    )
                  ) : (
                    <span className="text-meta text-fg-3">No acknowledgement needed</span>
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
        </>
      )}

      {cursor ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void load(severity, cursor)}
          busy={busy}
          busyLabel="Reading more changes"
          data-testid="dns-changes-show-more"
          className="self-start"
        >
          Show more changes
        </Button>
      ) : null}
    </section>
  );
}
