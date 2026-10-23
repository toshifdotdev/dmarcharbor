/**
 * share-document.tsx — the report a client contact receives.
 *
 * Written for its reader: usually not technical, often the client's office
 * manager or their own IT person, opening a link their provider sent. They
 * want three answers in order: is my domain protected, is anyone pretending to
 * be us, and what (if anything) do we need to do. So the page opens with one
 * plain sentence built from the measurements, then the figures, then the
 * evidence, then a short glossary so the terms on the page are explained on
 * the page.
 *
 * A DISCLOSURE SURFACE: it shows one domain's measurement and nothing else.
 * Every field comes from the share-scoped payload, which the server limits to
 * this share. It never names another client or the agency's other work.
 *
 * Rule Zero holds: no measurement reads "not measured", a feed with no recent
 * report says how long, and neither is ever presented as health. The payload
 * carries no per-day failure counts, so the volume chart shows volume and
 * never labels a day "passed".
 */

import type { PublicShareReport, TrendPoint } from "@/lib/types";
import { Badge, type Tone } from "@/components/ui/badge";
import { Nil, Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { Readout, ReadoutStrip } from "@/components/ui/readout";
import { STALE_AFTER_DAYS } from "@/lib/posture";
import { VolumeChart } from "./volume-chart";

const fmt = (n: number) => n.toLocaleString("en-GB");
const date = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

const RISK: Record<string, { tone: Tone; label: string }> = {
  high: { tone: "fail", label: "High" },
  medium: { tone: "warn", label: "Medium" },
  low: { tone: "neutral", label: "Low" },
};

export function ShareDocument({ report, today }: { report: PublicShareReport; today: string }) {
  const { sharedFor, policy, health, reporting, activity, sources, forensic } = report;
  const measured = health.messagesObserved > 0;
  const gap = reporting.daysSinceLastReport === null ? null : Math.floor(reporting.daysSinceLastReport);
  const stale = measured && gap !== null && gap > STALE_AFTER_DAYS;
  const published = policy.published && policy.published !== "unknown" ? policy.published : null;
  // Counted from the daily series: days on which at least one report arrived.
  const reportDays = activity.dailyReports.filter((d) => d.reports > 0).length;
  const tighten = policy.recommended === "quarantine" || policy.recommended === "reject" ? policy.recommended : null;

  // The one sentence, from the measurements and nothing else.
  const answer: { tone: Tone; text: string } = !measured
    ? { tone: "void", text: "Not measured yet. No mail server has reported on this domain, so nothing here can be read as protection." }
    : stale
      ? { tone: "void", text: `No report for ${gap} days. The figures below describe the period before that, not today.` }
      : !published
        ? { tone: "fail", text: "This domain publishes no DMARC policy, so receiving mail servers decide on their own what to do with forged mail." }
        : published === "none"
          ? { tone: "warn", text: "This domain is being watched but not yet protected: forged mail is reported, not stopped (p=none)." }
          : {
              // A statement of policy, not of health: set in ink, never in the
              // "aligned" green. The evidence below says how it is going.
              tone: "neutral",
              text: `This domain asks receivers to ${published === "reject" ? "refuse" : "quarantine"} mail that fails authentication (p=${published}).`,
            };

  const points: TrendPoint[] = activity.dailyReports.map((d) => ({
    date: d.date,
    reportsReceived: d.reports,
    messagesObserved: d.messages,
    failedMessages: 0,
  }));

  return (
    <article className="flex flex-col gap-10">
      <header className="flex flex-col gap-4 border-b border-fg pb-8">
        <p className="legend">Prepared for {sharedFor.client}</p>
        {/* Long domains break after a dot, never mid-label. */}
        <h1 className="data text-[24px] font-semibold leading-[1.15] tracking-[-0.03em] text-fg [overflow-wrap:anywhere] sm:text-[40px]">
          {sharedFor.domain.split(".").map((part, i, all) => (
            <span key={i}>
              {part}
              {i < all.length - 1 ? (
                <>
                  .<wbr />
                </>
              ) : null}
            </span>
          ))}
        </h1>
        <p
          data-testid={!measured ? "share-not-measured" : stale ? "share-stale" : "share-answer"}
          className={
            "max-w-[64ch] text-lead font-semibold " +
            (answer.tone === "neutral" ? "text-fg" : answer.tone === "warn" ? "text-warn" : answer.tone === "fail" ? "text-fail" : "text-void")
          }
        >
          {answer.text}
        </p>
        <p className="max-w-[70ch] text-body text-fg-2">
          This report shows what the world&rsquo;s receiving mail servers told us about mail claiming to come from{" "}
          <span className="data text-fg">{sharedFor.domain}</span>. It describes what was observed and claims no control
          over delivery.
        </p>
      </header>

      <ReadoutStrip>
        <Readout
          label="Messages observed"
          value={measured ? fmt(health.messagesObserved) : "—"}
          note={`on ${reportDays} day${reportDays === 1 ? "" : "s"} with reports`}
        />
        <Readout
          label="Pass rate"
          value={health.passRatePercent === null ? "—" : `${health.passRatePercent.toFixed(1)}%`}
          note="average of the SPF and DKIM pass rates"
        />
        <Readout label="Reports received" value={fmt(reporting.reportsReceived)} note="from receiving mail servers" />
        <Readout
          label="Last report"
          value={reporting.lastReportAt ? new Date(reporting.lastReportAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "never"}
          note={gap === null ? "none received yet" : gap === 0 ? "today" : `${gap} day${gap === 1 ? "" : "s"} ago`}
          tone={stale ? "void" : undefined}
        />
        <Readout
          label="Published policy"
          value={published ? `p=${published}` : "none"}
          note={policy.reportingConfigured ? "reports are being collected" : "reporting not configured"}
        />
      </ReadoutStrip>

      <section aria-labelledby="share-volume">
        <h2 id="share-volume" className="text-h3 font-bold">
          Mail observed, by day
        </h2>
        <p className="mt-1 text-ui text-fg-3">Each column is one day&rsquo;s reports. A hatched day is a day no report arrived: unknown, not zero.</p>
        <div className="mt-4">
          <VolumeChart
            points={points}
            spikes={[]}
            days={30}
            today={today}
            lastReportAt={reporting.lastReportAt}
            daysWithoutReport={gap}
            domainName={sharedFor.domain}
            showFailures={false}
          />
        </div>
      </section>

      <section aria-labelledby="share-policy" className="grid gap-6 border-t border-rule pt-8 md:grid-cols-[220px_minmax(0,1fr)]">
        <h2 id="share-policy" className="text-h3 font-bold">
          What happens next
        </h2>
        <div className="flex flex-col gap-2 text-body text-fg-2">
          {tighten ? (
            <p>
              <span className="font-semibold text-fg">The evidence supports moving to p={tighten}.</span> Your provider will
              confirm before anything changes; nothing on this page changes your domain.
            </p>
          ) : (
            <p>
              <span className="font-semibold text-fg">No change is recommended yet.</span> Tightening a policy is only
              safe once every legitimate sender is seen passing, and the evidence does not show that yet.
            </p>
          )}
          {!policy.reportingConfigured ? (
            <p className="text-warn">
              Reporting is not configured in the published record, so new reports may not arrive. Your provider can fix
              this with one DNS change.
            </p>
          ) : null}
        </div>
      </section>

      {sources.length > 0 ? (
        <section aria-labelledby="share-sources">
          <h2 id="share-sources" className="text-h3 font-bold">
            Where the mail came from
          </h2>
          <p className="mt-1 max-w-[70ch] text-ui text-fg-3">
            The sending addresses receivers saw, most failures first. A high-risk address failing most of its mail is
            usually someone pretending to be you, or a service of yours that is not set up yet.
          </p>
          <div className="mt-4">
            <Table caption={`Sending sources for ${sharedFor.domain}`} minWidth={620}>
              <THead>
                <tr>
                  <Th>Source address</Th>
                  <Th>Sending as</Th>
                  <Th numeric>Messages</Th>
                  <Th numeric>Failed</Th>
                  <Th numeric title="Failed messages as a share of this source's own messages">Failed share</Th>
                  <Th>Risk</Th>
                </tr>
              </THead>
              <TBody>
                {sources.map((s) => (
                  <Tr key={s.sourceIp} tone={s.risk === "high" ? "fail" : undefined}>
                    <Td mono className="font-semibold">
                      {s.sourceIp}
                    </Td>
                    <Td mono muted={!s.topSendingDomain}>
                      {s.topSendingDomain ?? <span className="text-meta">not reported</span>}
                    </Td>
                    <Td numeric>{fmt(s.totalMessages)}</Td>
                    <Td numeric className={s.failedMessages > 0 ? "font-semibold text-fail" : undefined}>
                      {fmt(s.failedMessages)}
                    </Td>
                    <Td numeric muted>
                      {s.totalMessages > 0 ? `${Math.round((s.failedMessages / s.totalMessages) * 100)}%` : <Nil />}
                    </Td>
                    <Td>
                      <Badge tone={(RISK[s.risk] ?? RISK.low).tone}>{(RISK[s.risk] ?? { label: s.risk }).label}</Badge>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        </section>
      ) : null}

      {forensic?.included ? (
        <section aria-labelledby="share-forensic" className="border-t border-rule pt-8">
          <h2 id="share-forensic" className="text-h3 font-bold">
            Failure samples
          </h2>
          <p className="mt-1 max-w-[70ch] text-ui text-fg-3">
            Some receivers send a sample of individual messages that failed. Recipient addresses in them are never shown
            here.
          </p>
          <div className="mt-4">
            <ReadoutStrip>
              <Readout label="Failure reports" value={fmt(forensic.reportCount)} />
              <Readout label="Rejected or quarantined" value={fmt(forensic.rejectedMessages)} note="by the receiving server" />
              <Readout label="Recipients affected" value={fmt(forensic.affectedRecipients)} note="counted, never named" />
            </ReadoutStrip>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="share-terms" className="border-t border-rule pt-8">
        <h2 id="share-terms" className="text-h3 font-bold">
          The terms on this page
        </h2>
        <dl className="mt-4 grid max-w-[880px] gap-x-10 md:grid-cols-2">
          {[
            ["DMARC", "A published instruction telling receiving mail servers what to do with mail that claims your domain but fails the checks below, and where to send their reports."],
            ["SPF", "A list of the servers allowed to send mail as your domain."],
            ["DKIM", "A cryptographic signature that proves a message was sent by someone holding your domain's key."],
            ["Pass rate", "The average of two figures: the share of observed messages that passed SPF, and the share that passed DKIM."],
            ["p=none / quarantine / reject", "Watch only, send failing mail to spam, or refuse it. Domains move from left to right as the evidence allows."],
            ["Report", "A daily summary a receiving mail server sends about mail it saw claiming your domain."],
          ].map(([k, v]) => (
            <div key={k} className="border-b border-rule py-3">
              <dt className="text-body font-bold text-fg">{k}</dt>
              <dd className="mt-0.5 text-ui text-fg-2">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="border-t border-fg pt-6 text-meta text-fg-3">
        <p className="max-w-[80ch]">
          This report is scoped to <span className="data text-fg-2">{sharedFor.domain}</span> and nothing else. It contains
          aggregate evidence only{forensic?.included ? ", plus the failure samples shared with it" : ""}. Generated{" "}
          {date(report.generatedAt)}. The link expires on {date(report.expiresAt)} and can be withdrawn at any time by
          the team that shared it. Questions about what this means go to {sharedFor.client}&rsquo;s IT provider.
        </p>
      </footer>
    </article>
  );
}
