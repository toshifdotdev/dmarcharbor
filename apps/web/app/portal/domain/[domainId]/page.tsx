import Link from "next/link";
import { getPortalDomain, getPortalBranding, PortalError } from "@/lib/api-portal";
import { PortalDenied } from "@/components/portal-denied";
import type { PortalBranding, PortalDomainDetail } from "@/lib/types";

/**
 * One domain, in the contact's language: what was observed and what it means.
 *
 * FORENSIC DATA NEVER APPEARS HERE (brief rule 5). Everything on this page
 * comes from GET /api/portal/domains/:id — aggregate evidence and sender
 * attribution only. The five postures apply unchanged: an unmeasured or stale
 * domain is labelled as such and never reads as a pass.
 */
export default async function PortalDomainPage({
  params,
}: {
  params: Promise<{ domainId: string }>;
}) {
  const { domainId } = await params;

  let detail: PortalDomainDetail;
  let brand: PortalBranding | null;
  try {
    [detail, brand] = await Promise.all([
      getPortalDomain(domainId),
      getPortalBranding().catch(() => null),
    ]);
  } catch (error) {
    if (error instanceof PortalError) {
      return (
        <PortalDenied
          message={
            error.status === 404
              ? "That domain is not available to this account."
              : (error.message ?? "This report is temporarily unavailable.")
          }
        />
      );
    }
    throw error;
  }

  const agg = detail.aggregate;
  const hasMeasurement = Boolean(agg && agg.messageCount > 0);
  const ageDays = agg?.lastReportAt
    ? Math.floor((Date.now() - new Date(agg.lastReportAt).getTime()) / 86_400_000)
    : Infinity;
  const isStale = hasMeasurement && ageDays > 5;

  const posture = !hasMeasurement
    ? { label: "Not measured", tone: "var(--color-unmeasured)" }
    : isStale
      ? { label: "Stale", tone: "var(--color-unmeasured)" }
      : (agg?.failedMessages ?? 0) > 0
        ? { label: "Failing observed", tone: "var(--color-block)" }
        : { label: "All observed senders authenticated", tone: "var(--color-pass)" };

  return (
    <div data-surface="artefact" className="artefact relative z-10 min-h-screen">
      <header
        className="border-b px-6 py-4"
        style={{ borderColor: "var(--line-strong)", background: "var(--surface)" }}
      >
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          <Link
            href="/portal"
            className="num text-[10px] tracking-[0.16em] uppercase"
            style={{ color: "var(--ink-3)" }}
          >
            ← all domains
          </Link>
          <div className="ml-auto num text-[10px] tracking-[0.16em] uppercase" style={{ color: "var(--ink-3)" }}>
            {brand?.workspaceName ?? detail.domain.client.name} · client reports
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        <p
          className="num text-[11px] tracking-[0.18em] uppercase"
          style={{ color: "var(--ink-3)" }}
        >
          {detail.domain.client.name}
        </p>
        <h1 className="num mt-2 text-[28px]" style={{ color: "var(--ink)" }}>
          {detail.domain.name}
        </h1>

        <div className="mt-5 flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <span
            className="num text-[11px] tracking-[0.14em] uppercase"
            style={{ color: posture.tone }}
          >
            {posture.label}
          </span>
          <span className="num text-[11.5px]" style={{ color: "var(--ink-2)" }}>
            {detail.domain.dmarcPolicy
              ? `policy published: p=${detail.domain.dmarcPolicy}`
              : "no policy published"}
          </span>
          <span className="num text-[11.5px]" style={{ color: "var(--ink-3)" }}>
            last report{" "}
            {agg?.lastReportAt
              ? new Date(agg.lastReportAt).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })
              : "never"}
          </span>
        </div>

        {isStale ? (
          <p
            role="status"
            className="mt-6 border px-4 py-3 text-[13px]"
            style={{
              borderColor: "var(--color-unmeasured)",
              background: "var(--color-unmeasured-soft)",
              color: "var(--ink-2)",
            }}
          >
            The feed for this domain went quiet {ageDays} days ago. The figures
            below are history, not current state — silence is not compliance.
          </p>
        ) : null}

        {!hasMeasurement && !isStale ? (
          <p
            role="status"
            className="mt-6 border px-4 py-3 text-[13px]"
            style={{
              borderColor: "var(--color-unmeasured)",
              background: "var(--color-unmeasured-soft)",
              color: "var(--ink-2)",
            }}
          >
            No aggregate report has been received for this domain yet. Nothing
            below can be read as measured — absence is not compliance.
          </p>
        ) : null}

        {agg ? (
          <section className="mt-10">
            <h2
              className="num border-b pb-2 text-[11px] tracking-[0.16em] uppercase"
              style={{ borderColor: "var(--line-strong)", color: "var(--ink-3)" }}
            >
              What was observed
            </h2>
            <dl className="mt-5 grid grid-cols-2 gap-x-10 gap-y-5 sm:grid-cols-4">
              <Figure label="Messages" value={agg.messageCount.toLocaleString("en-US")} />
              <Figure
                label="Failed authentication"
                value={agg.failedMessages.toLocaleString("en-US")}
                tone={agg.failedMessages > 0 ? "var(--color-block)" : undefined}
              />
              <Figure label="Reports" value={agg.reportCount.toLocaleString("en-US")} />
              <Figure
                label="DKIM pass rate"
                value={agg.dkimPassRate === null ? "not measured" : `${(agg.dkimPassRate * 100).toFixed(1)}%`}
              />
            </dl>
          </section>
        ) : null}

        <section className="mt-12">
          <h2
            className="num border-b pb-2 text-[11px] tracking-[0.16em] uppercase"
            style={{ borderColor: "var(--line-strong)", color: "var(--ink-3)" }}
          >
            Who is sending as you
          </h2>
          {detail.senders.length === 0 ? (
            <p className="mt-4 text-[13.5px]" style={{ color: "var(--ink-3)" }}>
              No senders observed yet.
            </p>
          ) : (
            <ul className="mt-3">
              {detail.senders.map((s) => {
                const unattributed =
                  (s.senderDomain ?? "").toLowerCase() !== detail.domain.name.toLowerCase();
                return (
                  <li
                    key={s.senderKey}
                    className="flex flex-wrap items-baseline gap-x-5 gap-y-1 border-b py-3.5"
                    style={{ borderColor: "var(--line)" }}
                  >
                    <span className="num text-[13.5px]" style={{ color: "var(--ink)" }}>
                      {s.senderDomain ?? s.sourceIps[0] ?? "unknown"}
                    </span>
                    <span className="num text-[11px]" style={{ color: "var(--ink-3)" }}>
                      {s.totalMessages.toLocaleString("en-US")} messages
                    </span>
                    {unattributed ? (
                      <span
                        className="num text-[10px] tracking-[0.12em] uppercase"
                        style={{ color: "var(--color-unverified)" }}
                      >
                        not recognised as you
                      </span>
                    ) : null}
                    <span
                      className="num ml-auto text-[10px] tracking-[0.12em] uppercase"
                      style={{
                        color:
                          s.status === "failing"
                            ? "var(--color-block)"
                            : s.status === "clean"
                              ? "var(--color-pass)"
                              : "var(--color-unmeasured)",
                      }}
                    >
                      {s.status.replace("-", " ")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {detail.possibleSpoofingSources.length > 0 ? (
            <div
              className="mt-6 border px-4 py-3"
              style={{
                borderColor: "var(--color-block)",
                background: "var(--color-block-soft)",
              }}
            >
              <p
                className="num text-[10px] tracking-[0.14em] uppercase"
                style={{ color: "var(--color-block)" }}
              >
                Possible spoofing observed
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {detail.possibleSpoofingSources.map((s) => (
                  <li key={s.senderKey} className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                    {s.senderDomain ?? s.sourceIps[0] ?? "unknown"} —{" "}
                    {s.failedMessages.toLocaleString("en-US")} of{" "}
                    {s.totalMessages.toLocaleString("en-US")} messages failed authentication
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                This is an observation of traffic claiming to be your domain. Ask
                your provider about it — the platform measures, it does not block.
              </p>
            </div>
          ) : null}
        </section>

        <footer className="mt-14 border-t pt-6" style={{ borderColor: "var(--line)" }}>
          <p className="num text-[10.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
            Everything on this page is aggregate evidence: counts and sender
            attribution. Forensic detail is held to a stricter boundary and is not
            part of this portal. Export and erasure of personal data are
            available on every plan at no cost.
          </p>
        </footer>
      </main>
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div>
      <dt
        className="num text-[10px] tracking-[0.14em] uppercase"
        style={{ color: "var(--ink-3)" }}
      >
        {label}
      </dt>
      <dd
        className="num mt-1 text-[22px]"
        style={{ color: tone ?? "var(--ink)" }}
      >
        {value}
      </dd>
    </div>
  );
}
