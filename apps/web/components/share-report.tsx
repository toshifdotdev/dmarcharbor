import type { PublicShareReport } from "@/lib/types";

/**
 * share-report.tsx — the document a client receives.
 *
 * A DISCLOSURE SURFACE: it shows one domain's measurement and nothing else.
 * Nothing in it may reach another client's domain or name the workspace —
 * every field rendered here comes from the share-scoped payload, which the
 * server already limited to this share. Measurement vocabulary throughout:
 * what was observed, never what was blocked.
 *
 * Rule Zero holds: a domain with no measurement shows "not measured", and a
 * stale feed shows when it went quiet. Absence is never rendered as health.
 */
export function ShareReportView({ report }: { report: PublicShareReport }) {
  const { sharedFor, policy, health, reporting, activity, sources, forensic } = report;

  const hasMeasurement = health.messagesObserved > 0;
  const stale =
    hasMeasurement &&
    reporting.daysSinceLastReport !== null &&
    reporting.daysSinceLastReport > 5;

  return (
    <div className="mx-auto max-w-3xl px-6 py-14">
      <header>
        <p
          className="num text-[11px] tracking-[0.22em] uppercase"
          style={{ color: "var(--ink-3)" }}
        >
          Shared report · {sharedFor.domain}
        </p>
        <h1 className="mt-4 text-[30px] leading-tight" style={{ color: "var(--ink)" }}>
          What the world's mail servers observed for {sharedFor.domain}.
        </h1>
        <p className="mt-4 text-[14.5px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
          Prepared for {sharedFor.client} by the team monitoring this domain.
          Measurement and evidence only — this report describes what was
          observed and claims no control over delivery.
        </p>
        <p className="num mt-3 text-[11px]" style={{ color: "var(--color-unmeasured)" }}>
          generated {new Date(report.generatedAt).toLocaleDateString("en-GB")} ·
          link expires {new Date(report.expiresAt).toLocaleDateString("en-GB")}
        </p>
      </header>

      {!hasMeasurement ? (
        <p
          role="status"
          data-testid="share-not-measured"
          className="mt-8 border px-4 py-3 text-[13px]"
          style={{
            borderColor: "var(--color-unmeasured)",
            background: "var(--color-unmeasured-soft)",
            color: "var(--ink-2)",
          }}
        >
          <strong style={{ color: "var(--ink)" }}>Not measured.</strong> No
          aggregate report has been received for this domain yet — absence of
          data is not compliance, and nothing below should be read as health.
        </p>
      ) : stale ? (
        <p
          role="status"
          data-testid="share-stale"
          className="mt-8 border px-4 py-3 text-[13px]"
          style={{
            borderColor: "var(--color-unmeasured)",
            background: "var(--color-unmeasured-soft)",
            color: "var(--ink-2)",
          }}
        >
          <strong style={{ color: "var(--ink)" }}>The feed went quiet{" "}
          {reporting.daysSinceLastReport} days ago.</strong> The figures below are
          history, not current state — silence is not compliance.
        </p>
      ) : null}

      <section className="mt-10">
        <h2
          className="num border-b pb-2 text-[11px] tracking-[0.16em] uppercase"
          style={{ borderColor: "var(--line-strong)", color: "var(--ink-3)" }}
        >
          Observed
        </h2>
        <dl className="mt-5 grid grid-cols-2 gap-x-10 gap-y-5 sm:grid-cols-4">
          <Figure
            label="Messages observed"
            value={hasMeasurement ? health.messagesObserved.toLocaleString("en-US") : "not measured"}
          />
          <Figure
            label="Authentication pass rate"
            value={
              health.passRatePercent === null
                ? "not measured"
                : `${health.passRatePercent.toFixed(1)}%`
            }
          />
          <Figure label="Reports received" value={reporting.reportsReceived.toLocaleString("en-US")} />
          <Figure
            label="Last report"
            value={
              reporting.lastReportAt
                ? new Date(reporting.lastReportAt).toLocaleDateString("en-GB")
                : "never"
            }
          />
        </dl>
      </section>

      <section className="mt-12">
        <h2
          className="num border-b pb-2 text-[11px] tracking-[0.16em] uppercase"
          style={{ borderColor: "var(--line-strong)", color: "var(--ink-3)" }}
        >
          Policy
        </h2>
        <dl className="mt-5 grid grid-cols-1 gap-x-10 gap-y-5 sm:grid-cols-3">
          <Figure
            label="Published policy"
            value={policy.published ? `p=${policy.published}` : "no record"}
          />
          <Figure
            label="Reporting configured"
            value={policy.reportingConfigured ? "yes" : "not configured"}
          />
          <Figure label="Recommended next" value={`p=${policy.recommended}`} />
        </dl>
      </section>

      {activity.dailyReports.length > 0 ? (
        <section className="mt-12">
          <h2
            className="num border-b pb-2 text-[11px] tracking-[0.16em] uppercase"
            style={{ borderColor: "var(--line-strong)", color: "var(--ink-3)" }}
          >
            Volume by day
          </h2>
          <ul className="mt-4">
            {activity.dailyReports.slice(-14).map((d) => {
              const peak = Math.max(
                1,
                ...activity.dailyReports.map((x) => x.messages),
              );
              return (
                <li key={d.date} className="flex items-center gap-4 border-b py-2" style={{ borderColor: "var(--line)" }}>
                  <span className="num w-24 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                    {new Date(d.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                  </span>
                  <span
                    aria-hidden
                    style={{
                      height: 10,
                      width: `${Math.max(4, Math.round((d.messages / peak) * 220))}px`,
                      background: "var(--ink)",
                      opacity: 0.75,
                    }}
                  />
                  <span className="num text-[11.5px]" style={{ color: "var(--ink-2)" }}>
                    {d.messages.toLocaleString("en-US")} messages · {d.reports} report
                    {d.reports === 1 ? "" : "s"}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {sources.length > 0 ? (
        <section className="mt-12">
          <h2
            className="num border-b pb-2 text-[11px] tracking-[0.16em] uppercase"
            style={{ borderColor: "var(--line-strong)", color: "var(--ink-3)" }}
          >
            Sending sources
          </h2>
          <table className="mt-4 w-full border-collapse">
            <thead>
              <tr>
                {["Source IP", "Messages", "Failed", "Risk"].map((h) => (
                  <th
                    key={h}
                    className="num border-b pb-2 pr-4 text-left text-[10.5px] tracking-[0.14em] uppercase"
                    style={{ borderColor: "var(--line-strong)", color: "var(--ink-3)" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.sourceIp}>
                  <td className="num border-b py-2.5 pr-4 text-[12.5px]" style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                    {s.sourceIp}
                    {s.topSendingDomain ? (
                      <span style={{ color: "var(--ink-3)" }}> · {s.topSendingDomain}</span>
                    ) : null}
                  </td>
                  <td className="num border-b py-2.5 pr-4 text-[12.5px]" style={{ borderColor: "var(--line)", color: "var(--ink-2)" }}>
                    {s.totalMessages.toLocaleString("en-US")}
                  </td>
                  <td
                    className="num border-b py-2.5 pr-4 text-[12.5px]"
                    style={{
                      borderColor: "var(--line)",
                      color: s.failedMessages > 0 ? "var(--color-block)" : "var(--ink-2)",
                    }}
                  >
                    {s.failedMessages.toLocaleString("en-US")}
                  </td>
                  <td
                    className="num border-b py-2.5 text-[11px] tracking-[0.12em] uppercase"
                    style={{
                      borderColor: "var(--line)",
                      color:
                        s.risk === "high"
                          ? "var(--color-block)"
                          : s.risk === "medium"
                            ? "var(--color-unverified)"
                            : "var(--ink-3)",
                    }}
                  >
                    {s.risk}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {forensic && forensic.included ? (
        <section className="mt-12">
          <h2
            className="num border-b pb-2 text-[11px] tracking-[0.16em] uppercase"
            style={{ borderColor: "var(--line-strong)", color: "var(--ink-3)" }}
          >
            Failure evidence
          </h2>
          <dl className="mt-5 grid grid-cols-2 gap-x-10 gap-y-5 sm:grid-cols-3">
            <Figure label="Forensic reports" value={forensic.reportCount.toLocaleString("en-US")} />
            <Figure label="Rejected messages" value={forensic.rejectedMessages.toLocaleString("en-US")} />
            <Figure
              label="Affected recipients"
              value={forensic.affectedRecipients.toLocaleString("en-US")}
            />
          </dl>
        </section>
      ) : null}

      <footer className="mt-14 border-t pt-6" style={{ borderColor: "var(--line-strong)" }}>
        <p className="num text-[10.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
          This report is scoped to {sharedFor.domain} and nothing else. It
          contains aggregate evidence only{forensic && forensic.included ? " plus the failure evidence shared with it" : ""}.
          The link expires on {new Date(report.expiresAt).toLocaleDateString("en-GB")} and
          can be withdrawn at any time by the team that shared it. Questions
          about what any of this means go to {sharedFor.client}'s IT provider —
          this document measures, it does not control.
        </p>
      </footer>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt
        className="num text-[10.5px] tracking-[0.14em] uppercase"
        style={{ color: "var(--ink-3)" }}
      >
        {label}
      </dt>
      <dd className="num mt-1 text-[19px]" style={{ color: "var(--ink)" }}>
        {value}
      </dd>
    </div>
  );
}
