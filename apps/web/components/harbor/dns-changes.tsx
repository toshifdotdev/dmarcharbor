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
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  initial: { rows: DnsChangeView[]; nextCursor: string | null } | null;
  loadFailed: boolean;
  canAcknowledge: boolean;
  rescanIntervalMinutes: number | null;
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

  return (
    <section aria-labelledby="dns-changes-head" className="flex flex-col gap-4 border-t border-rule-2 pt-4" data-testid="dns-changes">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="dns-changes-head" className="text-h3 font-bold tracking-[-0.01em]">
            DNS changes
          </h2>
          <p className="mt-1 max-w-[80ch] text-ui text-fg-2">
            What changed between checks of {domainName}&rsquo;s DMARC, SPF, DKIM and MX records. INFO changes are
            history only; WARNING and CRITICAL changes can also notify the workspace.
          </p>
        </div>
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
      </div>

      {error ? (
        <Notice tone="fail" title={error} role="alert" testId="dns-change-error" />
      ) : null}

      {rows.length === 0 ? (
        <section role="status" data-testid="dns-changes-empty" className="border-y border-rule py-6">
          <h3 className="text-body font-semibold text-fg">No DNS changes recorded yet</h3>
          <p className="mt-1 max-w-[70ch] text-ui text-fg-2">
            DMARC Harbor re-checks this domain&rsquo;s DNS {schedule} and lists what changed here.
          </p>
        </section>
      ) : (
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
