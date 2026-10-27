"use client";

/**
 * tls-reports.tsx — the TLS-RPT evidence tab.
 *
 * The record state comes from the latest scan; the report tables come from the
 * summary endpoint, which aggregates in SQL. Report details are fetched only
 * when a row is expanded, because a report can hold a thousand failures.
 */

import { Fragment, useState } from "react";
import { instantLabel } from "@/lib/instant";
import type { TlsReportDetail, TlsReportPage, TlsReportSummary } from "@/lib/types";
import { getTlsReportDetail } from "@/lib/ops-client";
import { tlsResultExplanation } from "@/lib/tls-results";
import { DnsRecord } from "@/components/ui/copy";
import { Notice } from "@/components/ui/notice";
import { UpgradeNotice } from "@/components/ui/states";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";

function number(value: number): string {
  return value.toLocaleString("en-GB");
}

function shortDate(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function period(begin: string, end: string): string {
  return `${shortDate(begin)} – ${shortDate(end)}`;
}

function policyTypes(policies: Array<{ policyType: string }>): string {
  return [...new Set(policies.map((policy) => policy.policyType))].join(", ") || "—";
}

export function TlsReports({
  organizationId,
  domainName,
  summary,
  reports,
  failed,
  notInPlan,
  mtaStsPresent,
}: {
  organizationId: string;
  domainName: string;
  summary: TlsReportSummary | null;
  reports: TlsReportPage | null;
  failed: boolean;
  notInPlan: boolean;
  /** null when the latest scan is unavailable. */
  mtaStsPresent: boolean | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, TlsReportDetail | "loading" | "error">>({});
  const [detailError, setDetailError] = useState<string | null>(null);

  async function toggle(reportId: string): Promise<void> {
    if (expanded === reportId) {
      setExpanded(null);
      return;
    }
    setExpanded(reportId);
    setDetailError(null);
    if (details[reportId] && details[reportId] !== "error") {
      return;
    }
    setDetails((current) => ({ ...current, [reportId]: "loading" }));
    const res = await getTlsReportDetail(organizationId, reportId);
    if (!res.ok) {
      setDetails((current) => ({ ...current, [reportId]: "error" }));
      setDetailError(res.error.message ?? "The report detail could not be loaded.");
      return;
    }
    setDetails((current) => ({ ...current, [reportId]: res.data }));
  }

  if (notInPlan) {
    return (
      <div data-testid="tls-panel" className="pt-4">
        <UpgradeNotice
          feature="reports.tlsrpt"
          message="Viewing TLS reports is included from Fairway."
          context="Reports sent to DMARC Harbor are stored on every plan, so the ones received before an upgrade appear here afterwards. The record to publish is on this domain's setup page."
        />
      </div>
    );
  }

  if (failed || !summary) {
    return (
      <div data-testid="tls-panel" className="pt-4">
        <Notice tone="warn" title="TLS reports could not be read">
          This is a display problem, not an absence of TLS reports. Reload the page to try again.
        </Notice>
      </div>
    );
  }

  const record = summary.record;
  const totalSessions = summary.successfulSessions + summary.failedSessions;
  const reportRows = reports?.items ?? [];

  return (
    <section data-testid="tls-panel" aria-labelledby="tls-heading" className="flex flex-col gap-6 pt-4">
      <div>
        <h2 id="tls-heading" className="text-h3 font-bold tracking-[-0.01em] text-fg">
          TLS reports
        </h2>
        <p className="mt-1 max-w-[72ch] text-ui text-fg-2">
          Senders report failed TLS deliveries to the address in your <span className="data">_smtp._tls</span> record.
          Reports arrive by email, usually once a day.
        </p>
      </div>

      {record.status === "ours" ? (
        <Notice tone="ok" title="Your TLS-RPT record is in place">
          Reporters send one report a day; the first usually arrives within 48 hours of mail being sent to the domain.
        </Notice>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-ui text-fg-2">
            {record.status === "missing"
              ? "No TLS-RPT record is published. Publish this one so senders can report failed TLS deliveries."
              : record.status === "other"
                ? `Your TLS-RPT record sends reports to ${record.current ?? "another address"}. Add DMARC Harbor's address so they arrive here too.`
                : record.status === "invalid"
                  ? "The published TLS-RPT record is not valid. Publish this one instead."
                  : "Run a scan to see whether this domain publishes a TLS-RPT record."}
          </p>
          <DnsRecord
            type="TXT"
            host={record.host}
            zone={domainName}
            value={record.suggested}
            testId="tls-record"
          />
        </div>
      )}

      {mtaStsPresent === false ? (
        <p className="max-w-[72ch] text-meta text-warn">
          TLS reports are most useful with MTA-STS; without it, reporters only see whether TLS was offered.
        </p>
      ) : null}

      {summary.reportCount === 0 ? (
        <p className="text-ui text-fg-3">
          No TLS reports have arrived yet. They start after a sender tries to deliver over TLS and the record above is
          published.
        </p>
      ) : (
        <>
          <dl data-testid="tls-summary" className="grid gap-4 border-y border-rule-2 py-3 sm:grid-cols-4">
            <div>
              <dt className="legend">Sessions in {summary.days} days</dt>
              <dd className="data mt-1 text-body font-semibold text-fg">{number(totalSessions)}</dd>
            </div>
            <div>
              <dt className="legend">Failed sessions</dt>
              <dd className="data mt-1 text-body font-semibold text-fail">{number(summary.failedSessions)}</dd>
            </div>
            <div>
              <dt className="legend">Failure share</dt>
              <dd className="data mt-1 text-body font-semibold text-fg">
                {summary.failureSharePercent === null ? "—" : `${summary.failureSharePercent.toFixed(2)}%`}
              </dd>
            </div>
            <div>
              <dt className="legend">Last report</dt>
              <dd className="text-ui font-semibold text-fg">
                {summary.lastReportAt ? instantLabel(summary.lastReportAt) : "—"}
              </dd>
            </div>
          </dl>

          <div className="grid gap-8 lg:grid-cols-2">
            <div data-testid="tls-by-result">
              <p className="legend pb-1.5">Why deliveries failed</p>
              <Table caption="TLS failures by result type" minWidth={560}>
                <THead>
                  <tr>
                    <Th>Result type</Th>
                    <Th>What it means</Th>
                    <Th numeric>Failed</Th>
                    <Th>Reporters</Th>
                  </tr>
                </THead>
                <TBody>
                  {summary.byResultType.map((row) => (
                    <Tr key={row.resultType}>
                      <Td>
                        <span className="data">{row.resultType}</span>
                      </Td>
                      <Td>{tlsResultExplanation(row.resultType)}</Td>
                      <Td numeric>{number(row.failedSessions)}</Td>
                      <Td>{row.reporters.join(", ")}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>

            <div data-testid="tls-by-mx">
              <p className="legend pb-1.5">Mail servers with failures</p>
              <Table caption="TLS failures by receiving mail server" minWidth={480}>
                <THead>
                  <tr>
                    <Th>Receiving server</Th>
                    <Th numeric>Failed</Th>
                    <Th>Result types</Th>
                  </tr>
                </THead>
                <TBody>
                  {summary.byMxHost.map((row) => (
                    <Tr key={row.receivingMxHostname}>
                      <Td>
                        <span className="data">{row.receivingMxHostname}</span>
                      </Td>
                      <Td numeric>{number(row.failedSessions)}</Td>
                      <Td>{row.resultTypes.map((type) => tlsResultExplanation(type)).join(" ")}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          </div>

          <div data-testid="tls-reports">
            <p className="legend pb-1.5">Recent reports</p>
            {detailError ? <Notice tone="fail" title={detailError} /> : null}
            <Table caption="TLS-RPT reports received" minWidth={900}>
              <THead>
                <tr>
                  <Th>Reporter</Th>
                  <Th>Period</Th>
                  <Th>Policy type</Th>
                  <Th numeric>Successful</Th>
                  <Th numeric>Failed</Th>
                </tr>
              </THead>
              <TBody>
                {reportRows.map((report) => {
                  const detail = details[report.id];
                  const open = expanded === report.id;
                  return (
                    <Fragment key={report.id}>
                      <Tr>
                        <Td>
                          <button
                            type="button"
                            className="link text-left"
                            data-testid={`tls-report-row-${report.id}`}
                            aria-expanded={open}
                            onClick={() => void toggle(report.id)}
                          >
                            {report.organizationName}
                          </button>
                          {report.contactInfo ? (
                            <p className="mt-0.5 text-meta text-fg-3">{report.contactInfo}</p>
                          ) : null}
                          {report.truncated ? <p className="text-meta text-warn">Failure details truncated</p> : null}
                        </Td>
                        <Td>{period(report.dateRangeBegin, report.dateRangeEnd)}</Td>
                        <Td>{policyTypes(report.policies)}</Td>
                        <Td numeric>{number(report.successfulSessions)}</Td>
                        <Td numeric>{number(report.failedSessions)}</Td>
                      </Tr>
                      {open ? (
                        <tr key={`${report.id}-detail`}>
                          <td colSpan={5} className="border-b border-rule bg-paper-2 p-3">
                            <div data-testid={`tls-report-detail-${report.id}`}>
                              {detail === "loading" ? (
                                <p className="text-ui text-fg-3">Loading report detail…</p>
                              ) : detail === "error" || !detail ? (
                                <p className="text-ui text-fail">The report detail could not be loaded.</p>
                              ) : (
                                <ReportDetail detail={detail} />
                              )}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TBody>
            </Table>
          </div>
        </>
      )}
    </section>
  );
}

function ReportDetail({ detail }: { detail: TlsReportDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-meta text-fg-3">
        Report {detail.reportId} from {detail.organizationName} for {detail.policyDomain}, received{" "}
        {instantLabel(detail.receivedAt)}.
      </p>
      {detail.policies.map((policy) => (
        <div key={policy.id} className="flex flex-col gap-2">
          <p className="text-ui font-semibold text-fg">
            {policy.policyType}
            {policy.mxHost ? ` · ${policy.mxHost}` : ""} · {number(policy.successfulSessions)} successful,{" "}
            {number(policy.failedSessions)} failed
          </p>
          {policy.policyString ? (
            <pre className="data max-h-40 overflow-auto whitespace-pre-wrap break-all border border-rule bg-paper-3 px-2.5 py-2 text-meta text-fg-2">
              {policy.policyString}
            </pre>
          ) : null}
          {policy.failures.length === 0 ? (
            <p className="text-meta text-fg-3">No failure details in this policy.</p>
          ) : (
            <ul className="flex flex-col border-t border-rule">
              {policy.failures.map((failure) => (
                <li key={failure.id} className="border-b border-rule py-1.5 text-meta text-fg-2">
                  <span className="data font-semibold text-fg">{failure.resultType}</span>{" "}
                  {tlsResultExplanation(failure.resultType)} · {number(failure.failedSessions)} failed
                  {failure.sendingMtaIp ? ` · sender ${failure.sendingMtaIp}` : ""}
                  {failure.receivingMxHostname ? ` · receiver ${failure.receivingMxHostname}` : ""}
                  {failure.additionalInformation ? ` · ${failure.additionalInformation}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
