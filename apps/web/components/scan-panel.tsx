"use client";

/**
 * scan-panel.tsx — the DNS scan history for one domain, and the control that
 * starts one.
 *
 * WHY THIS CONTROL EXISTS AT ALL
 *
 * `domain.dmarcPolicy` is written in exactly one place: the scan service's
 * transaction (apps/api/src/services/domain-scan.service.ts). Nothing else
 * derives it, not the insights read, not the onboarding read, not the report
 * ingestion. So a domain whose DNS has never been scanned has no policy recorded
 * against it at all, and a screen that renders that absence as "no record" is
 * asserting something nobody measured. The domain page already works around it
 * by falling back to the policy reporters observed in their own reports; this
 * panel is the thing that fixes the cause, and its empty state says so in those
 * words rather than showing an empty table.
 *
 * NO ENTITLEMENT GATE, AND THAT IS DELIBERATE
 *
 * domain-scan.routes.ts carries requireSession plus
 * requireOrganizationPermission('domain', 'update') on the POST and
 * ('domain', 'read') on both reads. There is no requireFeature on any of the
 * three, and no scan key exists in the plan catalog's EntitlementKey union.
 * Putting one here would hide a control the API serves on every plan and invent
 * a promise the backend cannot keep. The only real precondition is verification:
 * runDomainScan refuses a domain that is not VERIFIED with a 409, so the button
 * is disabled before that call is made rather than after it is refused.
 *
 * THE THREE STATES, NEVER TWO
 *
 *   loading  the history arrives from the server with the page, so there is no
 *            second wait here; a detail read has its own loading state.
 *   empty   the domain has never been scanned. Different from the next one, and
 *            it is the state that matters: it is why no policy is on record.
 *   failed  the history did not load. It must never render as the state above,
 *            because "we have no scans" and "we could not ask" are different
 *            claims and only one of them is evidence.
 *
 * WHAT EACH CONTROL DOES TO EVIDENCE
 *
 * A scan is an additive action: it appends a row and rewrites the domain's
 * measured fields to what the lookups found right now. Nothing is deleted, so
 * no confirmation, and the notice after a run says exactly which fields now hold
 * a measured value and which are still unmeasured.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ActionButton } from "@/components/action-button";
import { EmptyState, ErrorState, LoadingState } from "@/components/data-states";
import { fetchDomainScan, runDomainScan } from "@/lib/scans-client";
import { instantLabel } from "@/lib/instant";
import type { ScanIssue, ScanRow, ScanRunStatus } from "@/lib/types";

/**
 * One history row, with its timestamps already written in English.
 *
 * Formatted by the server page rather than here, for the reason every timestamp
 * on this app is: a clock read during render is a hydration mismatch waiting for
 * a browser in another time zone. This component never calls toLocaleString on
 * a value it received as data.
 */
export interface ScanHistoryRow {
  id: string;
  status: ScanRunStatus;
  score: number | null;
  startedLabel: string;
  completedLabel: string | null;
  /** Who asked for it. A scan is an action somebody took. */
  requestedBy: string;
  error: string | null;
}

const STATUS_TONE: Record<ScanRunStatus, string> = {
  COMPLETED: "var(--color-pass)",
  RUNNING: "var(--color-unmeasured)",
  FAILED: "var(--color-block)",
};

export function ScanPanel({
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
  /** The domain's own status, read from the same insights payload the page
   *  already has. VERIFIED is the precondition the API enforces on the POST. */
  domainStatus: string;
  scans: ScanHistoryRow[];
  /** A failed history read. Never rendered as an empty history. */
  loadFailed: boolean;
}) {
  const router = useRouter();
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
      setError(res.error.message ?? "The scan could not be started.");
      // A 502 is the one refusal that still produced a scan: runDomainScan
      // wrote a FAILED row before it gave up. Refreshing puts that row in the
      // history instead of pretending nothing happened.
      if (res.status === 502) router.refresh();
      return;
    }

    setNotice(describeOutcome(res.data));
    // The scan rewrote the domain's policy, score, SPF record, DKIM selectors
    // and MX records, so the whole page above this one is now stale too.
    router.refresh();
  }

  async function open(scanId: string) {
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
      setError(res.error.message ?? "That scan could not be read.");
      return;
    }
    setDetail(res.data);
  }

  return (
    <section
      className="lift rounded-[2px] border"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      data-testid="scan-panel"
    >
      <header
        className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5"
        style={{ borderColor: "var(--color-line)" }}
      >
        <div>
          <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">
            DNS scans
          </h2>
          {/* A count above a failure is the claim this screen must not make: when
              the read did not answer, the number is unknown, not zero. */}
          <p className="num mt-1 text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
            {loadFailed
              ? "the scan history could not be read"
              : scans.length === 0
                ? "this domain has never been scanned"
                : `${scans.length} scan${scans.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <ActionButton
          label="Run scan now"
          loadingLabel="Scanning DNS"
          busy={busy}
          disabled={!verified}
          onClick={run}
          testId="scan-run"
        />
      </header>

      {!verified ? (
        <p
          role="status"
          className="border-b px-5 py-2.5 text-[12.5px]"
          style={{ borderColor: "var(--color-line)", color: "var(--color-unverified)" }}
        >
          This domain is not verified, so the API refuses an authenticated scan
          against it. Verify the ownership TXT record first: a scan measures a
          domain we have not proven we monitor.
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="border-b px-5 py-3 text-[13px]"
          style={{ borderColor: "var(--color-line)", color: "var(--color-ink-2)" }}
          data-testid="scan-notice"
        >
          {notice}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="px-5 py-3 text-[13px]" style={{ color: "var(--color-block)" }}>
          {error}
        </p>
      ) : null}

      <div className="px-5 py-4">
        {loadFailed ? (
          <ErrorState
            what="the scan history"
            detail={`A domain that has never been scanned and a history this page could not read look identical in a table. Only the second one is a failure, and nothing was deleted to produce it.`}
          />
        ) : scans.length === 0 ? (
          <EmptyState
            title="No scan has run against this domain"
            description={`A DNS scan is the only thing that records a DMARC policy for a domain, and ${domainName} has never had one. Until a scan runs, no policy is on record here and nothing on this page can be read as measured: absence is not a finding.`}
            action={{ label: "Run scan now", onClick: run }}
          />
        ) : (
          <ul>
            {scans.map((scan) => (
              <li key={scan.id} className="border-b" style={{ borderColor: "rgba(255,255,255,0.055)" }}>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="num text-[13px]" style={{ color: "var(--color-ink)" }}>
                      {scan.completedLabel ?? scan.startedLabel}
                      {scan.completedLabel ? "" : " (started, no result yet)"}
                    </div>
                    <div className="num text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                      asked for by {scan.requestedBy}
                    </div>
                    {scan.error ? (
                      <div className="num mt-1 text-[12px]" style={{ color: "var(--color-block)" }}>
                        {scan.error}
                      </div>
                    ) : null}
                  </div>
                  <span
                    className="num text-[11.5px] font-semibold tracking-[0.12em] uppercase"
                    style={{ color: STATUS_TONE[scan.status] }}
                  >
                    {scan.status.toLowerCase()}
                    {scan.score !== null ? ` · ${scan.score}` : ""}
                  </span>
                  <ActionButton
                    label={openId === scan.id ? "Close detail" : "View detail"}
                    variant="ghost"
                    onClick={() => open(scan.id)}
                    testId={`scan-detail-${scan.id}`}
                    style={{ padding: "6px 12px", fontSize: 12 }}
                  />
                </div>

                {openId === scan.id ? (
                  <div className="pb-4">
                    {detailBusy ? (
                      <LoadingState label="Loading that scan" />
                    ) : detailFailed ? (
                      <ErrorState
                        what="that scan"
                        detail="The row is still listed above, so the scan exists. This is a failure to read its stored result, not a missing scan."
                      />
                    ) : detail ? (
                      <ScanDetail scan={detail} />
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * What a completed scan actually established, in the words the domain page needs.
 *
 * The distinction it exists to keep: a scan that FOUND a DMARC record now has a
 * measured policy on record, and a scan that found nothing has not established
 * "no policy". The second case says the policy is still unmeasured rather than
 * `p=none`, because the two read identically on a dashboard and only one of them
 * is true.
 */
function describeOutcome(scan: ScanRow): string {
  const result = scan.result;
  if (!result) {
    return scan.status === "RUNNING"
      ? "The scan started and is still running. Reload in a moment to see its result."
      : "The scan finished and stored no DNS result, so nothing about this domain was measured.";
  }

  /**
   * The scanner's own `status: "error"` is its error result: the call completed,
   * the lookups did not, and the score is a zero rather than a measurement. It
   * is reported as what it is, because a score of 0 next to "scan completed" is
   * the most damaging pair of words this panel could put on a screen.
   */
  if (result.status === "error") {
    return `The scan ran but the DNS lookups did not complete, so nothing about this domain was measured and no DMARC policy was recorded.${result.spf.error ? ` The lookup error was: ${result.spf.error}` : ""}`;
  }

  const dmarc = result.dmarc;
  const found = dmarc.status === "found" && dmarc.record;

  const policy = found
    ? `The published record is now on file, so this domain asserts p=${dmarc.policy} from a measurement rather than from an inference.`
    : "No DMARC record was found, so no policy has been recorded for this domain and its posture is still unmeasured. Absence is not p=none.";

  const findings = result.issues.length === 0
    ? "No issues were raised."
    : `${result.issues.length} finding${result.issues.length === 1 ? "" : "s"} recorded.`;

  return `Scan completed for ${result.domain}, scored ${result.score} of 100. ${policy} ${findings}`;
}

/** One scan's stored result, read as DNS facts and the findings they produced. */
function ScanDetail({ scan }: { scan: ScanRow }) {
  const result = scan.result;
  if (!result) {
    return (
      <p className="text-[13px]" style={{ color: "var(--color-ink-3)" }}>
        This scan stored no DNS result. {scan.error ?? "It may still be running."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="scan-detail-body">
      <dl className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-4 gap-y-1">
        <Detail k="Measured at" v={instantLabel(result.scannedAt)} />
        <Detail
          k="DMARC"
          v={
            result.dmarc.status === "found"
              ? `found, policy p=${result.dmarc.policy}`
              : result.dmarc.status === "error"
                ? "lookup failed"
                : "no record found"
          }
        />
        <Detail
          k="SPF"
          v={
            result.spf.status === "found"
              ? result.spf.valid
                ? `valid, ${result.spf.lookupCount} lookups`
                : `found but invalid, ${result.spf.lookupCount} lookups`
              : result.spf.status === "error"
                ? "lookup failed"
                : "no record found"
          }
        />
        <Detail
          k="DKIM"
          v={
            result.dkim.selectors.length === 0
              ? result.dkim.status === "error"
                ? "lookup failed"
                : "no selector found a key"
              : `${result.dkim.selectors.length} selector${result.dkim.selectors.length === 1 ? "" : "s"}: ${result.dkim.selectors.join(", ")}`
          }
        />
        <Detail
          k="MX"
          v={
            result.mx.records.length === 0
              ? "none found"
              : result.mx.records
                  .slice()
                  .sort((a, b) => a.priority - b.priority)
                  .map((record) => `${record.exchange} (${record.priority})`)
                  .join(", ")
          }
        />
      </dl>

      {result.dmarc.record ? (
        <div>
          <div className="label">Published DMARC record</div>
          <p
            className="num mt-1.5 break-words rounded-[2px] border px-3 py-2 text-[12.5px]"
            style={{
              background: "var(--color-elevate)",
              borderColor: "var(--color-line-strong)",
              color: "var(--color-ink)",
            }}
          >
            {result.dmarc.record}
          </p>
          {result.dmarc.hasForensicReports ? (
            <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
              It publishes a ruf= address, so per-message forensic reports have
              somewhere to arrive.
            </p>
          ) : (
            <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--color-unverified)" }}>
              It publishes no ruf= address. Forensic report collection stays off
              for this domain however the switch is set, because there is nowhere
              for a reporter to send them.
            </p>
          )}
        </div>
      ) : null}

      {result.dkim.skippedSelectors && result.dkim.skippedSelectors.length > 0 ? (
        <p className="text-[12.5px]" style={{ color: "var(--color-unmeasured)" }}>
          {result.dkim.skippedSelectors.length} selector candidate
          {result.dkim.skippedSelectors.length === 1 ? " was" : "s were"} left
          unchecked because the lookup budget ran out. This scan is not a complete
          DKIM survey.
        </p>
      ) : null}

      {result.issues.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {result.issues.map((issue) => (
            <IssueRow key={issue.code} issue={issue} />
          ))}
        </ul>
      ) : (
        <p className="text-[13px]" style={{ color: "var(--color-ink-3)" }}>
          This scan raised no findings.
        </p>
      )}
    </div>
  );
}

/** A finding, with the scanner's own recommendation rather than one invented. */
function IssueRow({ issue }: { issue: ScanIssue }) {
  const tone =
    issue.severity === "error"
      ? "var(--color-block)"
      : issue.severity === "warning"
        ? "var(--color-unverified)"
        : "var(--color-ink-3)";
  return (
    <li
      className="rounded-[2px] border px-3 py-2"
      style={{ borderColor: "var(--color-line)", background: "var(--color-elevate)" }}
    >
      <div
        className="num text-[11px] font-semibold tracking-[0.12em] uppercase"
        style={{ color: tone }}
      >
        {issue.severity}
      </div>
      <div className="text-[13.5px]" style={{ color: "var(--color-ink)" }}>
        {issue.title}
      </div>
      <p className="mt-1 text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
        {issue.message}
      </p>
      {issue.recommendation ? (
        <p className="mt-1 text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
          {issue.recommendation}
        </p>
      ) : null}
    </li>
  );
}

function Detail({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="num text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
        {k}
      </dt>
      <dd className="num break-words text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
        {v}
      </dd>
    </>
  );
}