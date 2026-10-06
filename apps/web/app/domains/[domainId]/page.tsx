import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ApiError,
  deriveSignals,
  getDomainInsights,
  getOnboardingState,
  listClients,
  listDomainReports,
} from "@/lib/api";
import { resolvePosture, fmtVolume, POSTURE_META, policyLabel } from "@/lib/posture";
import { resolveActiveWorkspace } from "@/lib/session";
import type { SenderRow, ReportRow, PolicyReadiness } from "@/lib/types";
import { Shell } from "@/components/shell";
import { PostureBadge } from "@/components/posture";
import { TrendChart } from "@/components/trend-chart";

export default async function DomainPage({
  params,
}: {
  params: Promise<{ domainId: string }>;
}) {
  const { domainId } = await params;
  const { workspaces, active } = await resolveActiveWorkspace();
  // No workspace is an onboarding step, never a 404: a bookmark to a domain
  // detail page must land somewhere useful, not a "not found" for a page that
  // exists.
  if (!active) redirect("/welcome");

  let insights;
  let onboarding;
  let reports: ReportRow[] = [];
  let clientName = "";
  let loadError: string | null = null;

  try {
    const clients = await listClients(active.id);
    for (const c of clients) {
      const hit = c.domains.find((d) => d.id === domainId);
      if (hit) {
        clientName = c.name;
        break;
      }
    }
    if (!clientName) notFound();

    [insights, onboarding, reports] = await Promise.all([
      getDomainInsights(active.id, domainId),
      getOnboardingState(active.id, domainId),
      listDomainReports(active.id, domainId, 20).then((p) => p.items),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    loadError = "Could not load this domain's evidence. The measurement API did not answer.";
  }

  if (loadError || !insights || !onboarding) {
    return (
      <Shell workspaces={workspaces} activeWorkspace={active}>
        <p role="alert" style={{ color: "var(--color-ink-2)" }}>{loadError}</p>
      </Shell>
    );
  }

  const signals = deriveSignals(
    insights,
    insights.domain.name,
    reports[0]?.policyP ?? null,
  );
  const resolved = resolvePosture(signals);
  const meta = POSTURE_META[resolved.posture];
  const lastReportAt = insights.aggregate.lastReportAt;
  const ageDays = lastReportAt
    ? Math.floor((Date.now() - new Date(lastReportAt).getTime()) / 86_400_000)
    : Infinity;
  const silencePosture =
    resolved.posture === "stale" || resolved.posture === "unmeasured"
      ? resolved.posture
      : null;

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-6">
        <div>
          <Link
            href="/"
            className="num text-[12px] tracking-[0.14em] uppercase transition-colors"
            style={{ color: "var(--color-ink-3)" }}
          >
            ← Portfolio
          </Link>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1
              className="text-[27.5px] font-semibold tracking-[-0.03em]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {insights.domain.name}
            </h1>
            <span className="num text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
              {clientName}
            </span>
            <span className="ml-auto">
              <PostureBadge posture={resolved.posture} reason={resolved.reason} />
            </span>
          </div>
          <p className="mt-1.5 max-w-3xl text-[14.5px]" style={{ color: "var(--color-ink-2)" }}>
            {meta.meaning} <span style={{ color: "var(--color-ink-3)" }}>{resolved.reason}.</span>
          </p>
        </div>

        {silencePosture ? (
          <SilenceBand posture={silencePosture} lastReportAt={lastReportAt} ageDays={ageDays} />
        ) : null}

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Messages observed"
            value={fmtVolume(insights.aggregate.messageCount)}
            note={windowLabel(insights.aggregate.messageWindow)}
          />
          <Stat
            label="Failed alignment"
            value={fmtVolume(insights.aggregate.failedMessages)}
            tone={insights.aggregate.failedMessages > 0 ? "var(--color-block)" : undefined}
            note="messages that did not authenticate as this domain"
          />
          <Stat
            label="Reports received"
            value={fmtVolume(insights.aggregate.reportCount)}
            note="aggregate RUA documents"
          />
          <Stat
            label="SPF / DKIM pass rate"
            value={rateLabel(insights.aggregate.spfPassRate, insights.aggregate.dkimPassRate)}
            note="measured against observed messages"
          />
        </section>

        <section
          className="lift rounded-[2px] border p-5"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
        >
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">
              Observed volume
            </h2>
            <span className="label">last {insights.trends.days} days</span>
          </div>
          <div className="mt-4">
            <TrendChart
              points={insights.trends.points}
              lastReportAt={lastReportAt}
              domainName={insights.domain.name}
              windowDays={insights.trends.days}
            />
          </div>
        </section>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <SendersPanel senders={insights.senders} domainName={insights.domain.name} />
            <ReadinessPanel
              readiness={onboarding.readiness}
              steps={onboarding.steps}
              observedPolicy={policyLabel(
                insights.reporting.publishedPolicy,
                signals.reportedPolicy,
              )}
            />
          </div>

        <ReportsPanel reports={reports} />
      </div>
    </Shell>
  );
}

// ─── sections ─────────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone?: string;
}) {
  return (
    <div
      className="lift rounded-[2px] border p-4"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
    >
      <div className="label">{label}</div>
      <div
        className="num mt-1.5 text-[25.5px] font-semibold"
        style={{ color: tone ?? "var(--color-ink)" }}
      >
        {value}
      </div>
      <div className="mt-1 text-[12.5px] leading-relaxed" style={{ color: "var(--color-ink-3)" }}>
        {note}
      </div>
    </div>
  );
}

/**
 * Silence has two meanings and this band names whichever is true. Stale =
 * measured, then quiet (past measurements exist, shown not current). Never
 * measured = nothing exists. Neither is health, and they must never read as
 * one answer — Rule Zero extended to the words on the screen.
 */
function SilenceBand({
  posture,
  lastReportAt,
  ageDays,
}: {
  posture: "stale" | "unmeasured";
  lastReportAt: string | null;
  ageDays: number;
}) {
  return (
    <div
      role="status"
      className="hatch flex flex-wrap items-center gap-x-5 gap-y-1 rounded-[2px] border px-4 py-3"
      style={{ borderColor: "var(--color-unmeasured)", background: "var(--color-surface)" }}
    >
      <span
        className="num text-[11.5px] font-semibold tracking-[0.16em] uppercase"
        style={{ color: "var(--color-unmeasured)" }}
      >
        {posture === "stale" ? "Stale: measured, then quiet" : "Not measured: never"}
      </span>
      <span className="text-[14px]" style={{ color: "var(--color-ink-2)" }}>
        {posture === "stale" && lastReportAt
          ? `The feed went quiet ${ageDays} days ago (last report ${new Date(lastReportAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}). The measurements below are history, not current state: silence is not compliance.`
          : "No aggregate report has ever been received for this domain. Nothing below can be read as measured: absence is not compliance."}
      </span>
    </div>
  );
}

function SendersPanel({
  senders,
  domainName,
}: {
  senders: SenderRow[];
  domainName: string;
}) {
  const unattributed = senders.filter(
    (s) => (s.senderDomain ?? "").toLowerCase() !== domainName.toLowerCase(),
  );
  const attributed = senders.length - unattributed.length;

  return (
    <section
      className="lift rounded-[2px] border"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
    >
      <header className="flex items-baseline justify-between gap-3 border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
        <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">Senders</h2>
        <span className="num text-[12px]" style={{ color: "var(--color-ink-3)" }}>
          {attributed} attributed · {unattributed.length} unattributed
        </span>
      </header>

      {senders.length === 0 ? (
        <p className="px-5 py-8 text-center text-[14px]" style={{ color: "var(--color-ink-3)" }}>
          No senders observed yet.
        </p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {["Sender", "Messages", "Failed", "Status"].map((h) => (
                <th
                  key={h}
                  className="label border-b px-5 py-2.5 text-left"
                  style={{ borderColor: "var(--color-line)" }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {senders.slice(0, 12).map((s) => {
              const isUnattributed =
                (s.senderDomain ?? "").toLowerCase() !== domainName.toLowerCase();
              return (
                <tr key={s.senderKey}>
                  <td className="border-b px-5 py-2.5" style={{ borderColor: "rgba(255,255,255,0.055)" }}>
                    <div className="num text-[13.5px]" style={{ color: "var(--color-ink)" }}>
                      {s.senderDomain ?? `${s.sourceIps[0] ?? "unknown"} (no domain)`}
                    </div>
                    {isUnattributed ? (
                      <div className="num text-[11px] tracking-[0.12em] uppercase" style={{ color: "var(--color-unverified)" }}>
                        unattributed: authenticating as someone else
                      </div>
                    ) : null}
                  </td>
                  <td className="num border-b px-5 py-2.5 text-[13px]" style={{ borderColor: "rgba(255,255,255,0.055)", color: "var(--color-ink-2)" }}>
                    {fmtVolume(s.totalMessages)}
                  </td>
                  <td
                    className="num border-b px-5 py-2.5 text-[13px]"
                    style={{
                      borderColor: "rgba(255,255,255,0.055)",
                      color: s.failedMessages > 0 ? "var(--color-block)" : "var(--color-ink-2)",
                    }}
                  >
                    {fmtVolume(s.failedMessages)}
                  </td>
                  <td className="border-b px-5 py-2.5" style={{ borderColor: "rgba(255,255,255,0.055)" }}>
                    <SenderStatus status={s.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function SenderStatus({ status }: { status: SenderRow["status"] }) {
  const map = {
    clean: { label: "Clean", color: "var(--color-pass)" },
    degraded: { label: "Degraded", color: "var(--color-unverified)" },
    failing: { label: "Failing", color: "var(--color-block)" },
    "insufficient-data": { label: "Insufficient data", color: "var(--color-unmeasured)" },
  } as const;
  const s = map[status];
  return (
    <span
      className="num text-[11.5px] font-semibold tracking-[0.12em] uppercase"
      style={{ color: s.color }}
    >
      {s.label}
    </span>
  );
}

/**
 * Posture is a ladder, not a traffic light: no-record / p=none / quarantine /
 * reject as rungs. Readiness says what the evidence supports, and names its
 * blockers — never a score.
 */
function ReadinessPanel({
  readiness,
  steps,
  observedPolicy,
}: {
  readiness: PolicyReadiness;
  steps: Array<{ id: string; title: string; status: string; detail: string }>;
  /** The policy from evidence (DNS scan, or what reporters actually saw). */
  observedPolicy: string;
}) {
  // The "published" rung is chosen from OBSERVED evidence. readiness.currentPolicy
  // derives from the DNS-scan field (domain.dmarcPolicy), which is empty for any
  // domain never scanned: asserting "no record" against evidence that reports a
  // real p= value is exactly the lie Bug 2 was about.
  const observed = observedPolicy.toLowerCase();
  const rungs: Array<{ key: string; label: string; live: boolean }> = [
    {
      key: "none",
      label: "no record",
      live: observed === "not observed" && readiness.currentPolicy === "unknown",
    },
    { key: "p-none", label: "p=none", live: observed === "none" },
    { key: "quarantine", label: "p=quarantine", live: observed === "quarantine" },
    { key: "reject", label: "p=reject", live: observed === "reject" },
  ];

  return (
    <section
      className="lift rounded-[2px] border"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
    >
      <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
        <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">Policy posture & readiness</h2>
      </header>

      <div className="flex items-stretch gap-0 border-b" style={{ borderColor: "var(--color-line)" }}>
        {rungs.map((r, i) => (
          <div
            key={r.key}
            className="flex-1 border-l px-3 py-4 first:border-l-0"
            style={{
              borderColor: "var(--color-line)",
              background: r.live ? "var(--color-accent-soft)" : undefined,
            }}
          >
            <div className="num text-[11px] tracking-[0.12em] uppercase" style={{ color: "var(--color-ink-3)" }}>
              rung {i}
            </div>
            <div
              className="num mt-1 text-[13px]"
              style={{ color: r.live ? "var(--color-accent)" : "var(--color-ink-3)" }}
            >
              {r.label}
            </div>
            {r.live ? (
              <div className="num mt-1 text-[12px] tracking-[0.14em] uppercase" style={{ color: "var(--color-accent)" }}>
                published
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <dl className="flex flex-col gap-2.5 px-5 py-4">
        <ReadinessRow k="Evidence says" v={`${readiness.daysObserved} days observed · ${fmtVolume(readiness.messagesObserved)} messages`} />
        <ReadinessRow
          k="Pass rate"
          v={readiness.passRatePercent === null ? "not measured" : `${readiness.passRatePercent}%`}
        />
        <ReadinessRow k="Senders" v={`${readiness.failingSenders} failing of ${readiness.observedSenders} observed`} />
        <ReadinessRow
          k="Next step"
          v={readiness.ready ? `ready for p=${readiness.level}` : `not ready: ${readiness.blockers.length ? readiness.blockers.join("; ") : "keep observing"}`}
        />
      </dl>

      {steps.length > 0 ? (
        <ul className="flex flex-col gap-1.5 border-t px-5 py-4" style={{ borderColor: "var(--color-line)" }}>
          {steps.map((s) => (
            <li key={s.id} className="flex items-baseline gap-3">
              <span
                className="num text-[12px] tracking-[0.14em] uppercase"
                style={{
                  color:
                    s.status === "done"
                      ? "var(--color-pass)"
                      : s.status === "blocked"
                        ? "var(--color-block)"
                        : "var(--color-ink-3)",
                  minWidth: 58,
                }}
              >
                {s.status}
              </span>
              <span className="text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
                {s.title}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ReadinessRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="label">{k}</dt>
      <dd className="num text-[13px] text-right" style={{ color: "var(--color-ink-2)" }}>
        {v}
      </dd>
    </div>
  );
}

function ReportsPanel({ reports }: { reports: ReportRow[] }) {
  return (
    <section
      className="lift rounded-[2px] border"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
    >
      <header className="flex items-baseline justify-between gap-3 border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
        <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">Aggregate reports</h2>
        <span className="label">{reports.length} most recent</span>
      </header>

      {reports.length === 0 ? (
        <p className="px-5 py-8 text-center text-[14px]" style={{ color: "var(--color-ink-3)" }}>
          No aggregate report has been received for this domain yet. Measurement
          begins when the first reporter sends one.
        </p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {["Reporter", "Reported for", "Messages", "Failed", "Policy"].map((h) => (
                <th
                  key={h}
                  className="label border-b px-5 py-2.5 text-left"
                  style={{ borderColor: "var(--color-line)" }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => {
              const messages = r.records.reduce((s, rec) => s + rec.messageCount, 0);
              const failed = r.records
                .filter((rec) => (rec.dkimResult ?? "") !== "pass" || (rec.spfResult ?? "") !== "pass")
                .reduce((s, rec) => s + rec.messageCount, 0);
              return (
                <tr key={r.id}>
                  <td className="num border-b px-5 py-2.5 text-[13px]" style={{ borderColor: "rgba(255,255,255,0.055)", color: "var(--color-ink-2)" }}>
                    {r.reportingOrganization ?? "unknown reporter"}
                  </td>
                  <td className="num border-b px-5 py-2.5 text-[13px]" style={{ borderColor: "rgba(255,255,255,0.055)", color: "var(--color-ink-2)" }}>
                    {r.dateRangeBegin
                      ? `${new Date(r.dateRangeBegin).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${r.dateRangeEnd ? new Date(r.dateRangeEnd).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "?"}`
                      : "—"}
                  </td>
                  <td className="num border-b px-5 py-2.5 text-[13px]" style={{ borderColor: "rgba(255,255,255,0.055)", color: "var(--color-ink-2)" }}>
                    {fmtVolume(messages)}
                  </td>
                  <td
                    className="num border-b px-5 py-2.5 text-[13px]"
                    style={{
                      borderColor: "rgba(255,255,255,0.055)",
                      color: failed > 0 ? "var(--color-block)" : "var(--color-ink-2)",
                    }}
                  >
                    {fmtVolume(failed)}
                  </td>
                  <td className="num border-b px-5 py-2.5 text-[13px]" style={{ borderColor: "rgba(255,255,255,0.055)", color: "var(--color-ink-3)" }}>
                    {r.policyP ? `p=${r.policyP}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function rateLabel(spf: number | null, dkim: number | null): string {
  const f = (v: number | null) => (v === null ? "not measured" : `${(v * 100).toFixed(1)}%`);
  return `SPF ${f(spf)} · DKIM ${f(dkim)}`;
}

function windowLabel(w: { begin: string | null; end: string | null }): string {
  if (!w.begin || !w.end) return "no measurement window";
  return `${new Date(w.begin).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${new Date(w.end).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
}
