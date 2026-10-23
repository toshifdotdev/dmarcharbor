"use client";

/**
 * scan-history.tsx — DNS scans for one domain, and the control that runs one.
 *
 * The Chart rebuild of components/scan-panel.tsx, with the same behaviour and
 * the same reasons (read that file's header for the long form):
 *
 * - A scan is the ONLY thing that records a DMARC policy against a domain
 *   (`domain.dmarcPolicy` is written by the scan service and nothing else), so
 *   the empty state says that, rather than showing an empty table.
 * - No entitlement gate: the API serves scans on every plan. The one real
 *   precondition is ownership verification (the POST answers 409 otherwise), so
 *   the button is disabled, with the reason, before that refusal can happen.
 * - Three states, never two: never scanned, history unreadable (never shown as
 *   never scanned), and the history itself.
 * - A 502 still wrote a FAILED scan row, so the page refreshes to show it.
 * - Scans are additive (nothing is deleted), so no confirmation.
 *
 * Timestamps in the list arrive pre-formatted from the server; only a detail
 * fetched after a click is formatted here, where no server markup can disagree.
 */

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { fetchDomainScan, runDomainScan } from "@/lib/scans-client";
import { instantLabel } from "@/lib/instant";
import type { ScanIssue, ScanRow, ScanRunStatus } from "@/lib/types";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "@/components/ui/icons";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";

export interface ScanHistoryRow {
  id: string;
  status: ScanRunStatus;
  startedLabel: string;
  completedLabel: string | null;
  requestedBy: string;
  error: string | null;
}

const STATUS: Record<ScanRunStatus, { tone: Tone; label: string }> = {
  COMPLETED: { tone: "ok", label: "Completed" },
  RUNNING: { tone: "void", label: "Running" },
  FAILED: { tone: "fail", label: "Failed" },
};

export function ScanHistory({
  organizationId,
  domainId,
  domainName,
  domainStatus,
  scans,
  loadFailed,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  domainStatus: string;
  scans: ScanHistoryRow[];
  loadFailed: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ScanRow | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);

  const verified = domainStatus === "VERIFIED";

  async function run() {
    setBusy(true);
    setNotice(null);
    setError(null);
    const res = await runDomainScan(organizationId, domainId);
    setBusy(false);
    if (!res.ok) {
      const message = res.error.message ?? "The scan could not be started.";
      setError(message);
      toast({ tone: "fail", title: "Scan did not complete", body: message });
      if (res.status === 502) router.refresh();
      return;
    }
    setNotice(describeOutcome(res.data));
    toast({ tone: "ok", title: "Scan recorded", body: `${domainName} was read from DNS just now.` });
    // The scan rewrote the domain's measured fields, so the whole page is stale.
    router.refresh();
  }

  async function toggle(scanId: string) {
    if (openId === scanId) {
      setOpenId(null);
      setDetail(null);
      setDetailFailed(false);
      return;
    }
    setOpenId(scanId);
    setDetail(null);
    setDetailBusy(true);
    setDetailFailed(false);
    const res = await fetchDomainScan(organizationId, scanId);
    setDetailBusy(false);
    if (!res.ok) {
      setDetailFailed(true);
      return;
    }
    setDetail(res.data);
  }

  return (
    <div className="flex flex-col gap-4 pt-4" data-testid="scan-panel">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-ui text-fg-2">
          {loadFailed
            ? "The scan history could not be read."
            : scans.length === 0
              ? "This domain has never been scanned, so no DMARC policy is on record from DNS."
              : `${scans.length} scan${scans.length === 1 ? "" : "s"} on record. A scan reads DMARC, SPF, DKIM and MX from public DNS and records what it saw.`}
        </p>
        <Button
          variant="primary"
          onClick={run}
          busy={busy}
          busyLabel="Scanning DNS"
          disabled={!verified}
          data-testid="scan-run"
          aria-describedby={!verified ? "scan-unverified" : undefined}
        >
          Run scan now
        </Button>
      </div>

      {!verified ? (
        <p id="scan-unverified" role="status" className="border-l-2 border-warn-mark bg-warn-wash/70 px-3 py-2 text-ui text-fg-2">
          Ownership of this domain is not verified, so the API refuses a scan against it. Verify the ownership TXT
          record first, from the domain&rsquo;s setup page.
        </p>
      ) : null}
      {notice ? (
        <p role="status" data-testid="scan-notice" className="border-l-2 border-ok bg-ok-wash/70 px-3 py-2 text-ui text-fg">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="border-l-2 border-fail bg-fail-wash/70 px-3 py-2 text-ui font-medium text-fail">
          {error}
        </p>
      ) : null}

      {loadFailed ? (
        <ErrorState
          what="the scan history"
          detail="A domain that has never been scanned and a history this page could not read look identical in a table. Only this one is a failure."
        />
      ) : scans.length === 0 ? (
        <EmptyState
          title="No scan has run against this domain"
          description={`A DNS scan is the only thing that records a DMARC policy for a domain, and ${domainName} has never had one. Until it does, the policy shown here comes from what reporters saw, not from DNS.`}
          action={verified ? { label: "Run scan now", onClick: run, busy } : undefined}
        />
      ) : (
        <Table caption={`DNS scans of ${domainName}`} minWidth={640}>
          <THead>
            <tr>
              <Th>Recorded</Th>
              <Th>Status</Th>
              <Th>Asked for by</Th>
              <Th align="right">
                <span className="sr-only">Detail</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {scans.map((s) => {
              const open = openId === s.id;
              return (
                <Fragment key={s.id}>
                  <Tr>
                    <Td className="tnum">
                      {s.completedLabel ?? s.startedLabel}
                      {s.completedLabel ? null : <span className="text-fg-3"> (started, no result yet)</span>}
                      {s.error ? <span className="mt-0.5 block text-meta text-fail">{s.error}</span> : null}
                    </Td>
                    <Td>
                      <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
                    </Td>
                    <Td muted>{s.requestedBy}</Td>
                    <Td align="right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggle(s.id)}
                        aria-expanded={open}
                        data-testid={`scan-detail-${s.id}`}
                      >
                        {open ? "Hide" : "Detail"}
                        <ChevronDown size={12} className={clsx("transition-transform", open && "rotate-180")} />
                      </Button>
                    </Td>
                  </Tr>
                  {open ? (
                    <tr className="border-b border-rule bg-paper">
                      <td colSpan={4} className="px-3 py-4">
                        {detailBusy ? (
                          <LoadingState label="Reading that scan" className="py-2" />
                        ) : detailFailed ? (
                          <ErrorState
                            what="that scan"
                            detail="The row is listed, so the scan exists. Its stored result could not be read."
                            onRetry={() => {
                              setOpenId(null);
                              void toggle(s.id);
                            }}
                          />
                        ) : detail ? (
                          <ScanDetail scan={detail} />
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}

/** What a run established, in words: a found record is a measured policy; a
 *  missing one is still unmeasured, never p=none. */
function describeOutcome(scan: ScanRow): string {
  const r = scan.result;
  if (!r) {
    return scan.status === "RUNNING"
      ? "The scan started and is still running. Refresh in a moment for its result."
      : "The scan finished and stored no DNS result, so nothing about this domain was measured.";
  }
  if (r.status === "error") {
    return `The scan ran but the DNS lookups did not complete, so nothing was measured and no policy was recorded.${r.spf.error ? ` Lookup error: ${r.spf.error}` : ""}`;
  }
  const found = r.dmarc.status === "found" && r.dmarc.record;
  const policy = found
    ? `The published record is now on file: p=${r.dmarc.policy}, measured rather than inferred.`
    : "No DMARC record was found, so no policy is recorded and posture is still unmeasured. Absence is not p=none.";
  const findings = r.issues.length === 0 ? "No findings." : `${r.issues.length} finding${r.issues.length === 1 ? "" : "s"} recorded.`;
  return `Scan completed for ${r.domain}. ${policy} ${findings}`;
}

function ScanDetail({ scan }: { scan: ScanRow }) {
  const r = scan.result;
  if (!r) {
    return <p className="text-ui text-fg-3">This scan stored no DNS result. {scan.error ?? "It may still be running."}</p>;
  }
  const facts: Array<[string, string]> = [
    ["Measured at", instantLabel(r.scannedAt)],
    ["DMARC", r.dmarc.status === "found" ? `found, p=${r.dmarc.policy}` : r.dmarc.status === "error" ? "lookup failed" : "no record found"],
    [
      "SPF",
      r.spf.status === "found"
        ? `${r.spf.valid ? "valid" : "found but invalid"}, ${r.spf.lookupCount} of 10 lookups`
        : r.spf.status === "error"
          ? "lookup failed"
          : "no record found",
    ],
    [
      "DKIM",
      r.dkim.selectors.length === 0
        ? r.dkim.status === "error"
          ? "lookup failed"
          : "no selector answered"
        : `${r.dkim.selectors.length} selector${r.dkim.selectors.length === 1 ? "" : "s"}: ${r.dkim.selectors.join(", ")}`,
    ],
    [
      "MX",
      r.mx.records.length === 0
        ? "none found"
        : r.mx.records
            .slice()
            .sort((a, b) => a.priority - b.priority)
            .map((m) => `${m.exchange} (${m.priority})`)
            .join(", "),
    ],
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" data-testid="scan-detail-body">
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          {facts.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="legend pt-px">{k}</dt>
              <dd className="data break-words text-meta text-fg">{v}</dd>
            </Fragment>
          ))}
        </dl>
        {r.dmarc.record ? (
          <div>
            <p className="legend">Published DMARC record</p>
            <p className="data mt-1 break-all border border-rule bg-paper-3 px-2.5 py-2 text-meta text-fg">{r.dmarc.record}</p>
            <p className={clsx("mt-1.5 text-meta", r.dmarc.hasForensicReports ? "text-fg-2" : "text-warn")}>
              {r.dmarc.hasForensicReports
                ? "It publishes a ruf= address, so forensic reports have somewhere to arrive."
                : "It publishes no ruf= address, so forensic collection stays off whatever the switch says: there is nowhere for reports to go."}
            </p>
          </div>
        ) : null}
        {r.dkim.skippedSelectors && r.dkim.skippedSelectors.length > 0 ? (
          <p className="text-meta text-void">
            {r.dkim.skippedSelectors.length} selector candidate{r.dkim.skippedSelectors.length === 1 ? " was" : "s were"} left
            unchecked when the lookup budget ran out. This is not a complete DKIM survey.
          </p>
        ) : null}
      </div>
      <div>
        <p className="legend">Findings</p>
        {r.issues.length === 0 ? (
          <p className="mt-1 text-ui text-fg-3">This scan raised no findings.</p>
        ) : (
          <ul className="mt-1 flex flex-col border-t border-rule">
            {r.issues.map((issue) => (
              <IssueRow key={issue.code} issue={issue} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function IssueRow({ issue }: { issue: ScanIssue }) {
  const tone: Tone = issue.severity === "error" ? "fail" : issue.severity === "warning" ? "warn" : "neutral";
  return (
    <li className="border-b border-rule py-2">
      <div className="flex items-baseline gap-2">
        <Badge tone={tone} className="w-16 shrink-0 capitalize">
          {issue.severity}
        </Badge>
        <span className="text-ui font-semibold text-fg">{issue.title}</span>
      </div>
      <p className="mt-0.5 pl-[72px] text-meta text-fg-2">{issue.message}</p>
      {issue.recommendation ? <p className="mt-0.5 pl-[72px] text-meta text-fg-3">{issue.recommendation}</p> : null}
    </li>
  );
}
