/**
 * share-document.tsx — the report a client contact receives.
 *
 * Written for its reader: usually not technical, often the client's office
 * manager or their own IT person, opening a link their provider sent. They
 * want three answers in order: is my domain protected, is anyone pretending to
 * be us, and what (if anything) do we need to do. So the page opens with one
 * plain sentence built from the measurements, then the figures, then a
 * drawing of how the mail was handled (a line per source, the failed mail on
 * the dashed red line, ending where the domain's policy sends it), then the
 * evidence, then a short glossary so the terms on the page are explained on
 * the page.
 *
 * Laid out like the public documents: each section's heading in a left rail,
 * its content in the column beside it, so a printed copy reads as a report.
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

import type { ReactNode } from "react";
import type { PublicShareReport, TrendPoint } from "@/lib/types";
import { Badge, type Tone } from "@/components/ui/badge";
import { Nil, Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { Readout, ReadoutStrip } from "@/components/ui/readout";
import { STALE_AFTER_DAYS } from "@/lib/posture";
import { LineKey, MailRoute, routeModel, StateMark, type Flow, type MarkShape, type PolicyOutcome } from "./document-route";
import { VolumeChart } from "./volume-chart";

const fmt = (n: number) => n.toLocaleString("en-GB");
const date = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

const RISK: Record<string, { tone: Tone; label: string }> = {
  high: { tone: "fail", label: "High" },
  medium: { tone: "warn", label: "Medium" },
  low: { tone: "neutral", label: "Low" },
};

/** The rail and the column, as the public documents set them. */
const RAIL = "grid gap-x-24 gap-y-5 min-[1100px]:grid-cols-[248px_minmax(0,1fr)]";
const SECTION = `${RAIL} border-t border-rule pt-10 sm:pt-12 print:pt-6`;
const H2 = "text-[22px] font-[740] leading-[1.15] tracking-[-0.02em] text-fg [text-wrap:balance] sm:text-[24px] print:text-[14pt]";

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
  const answer: { tone: Tone; shape: MarkShape | null; text: string } = !measured
    ? { tone: "void", shape: "hatch", text: "Not measured yet. No mail server has reported on this domain, so nothing here can be read as protection." }
    : stale
      ? { tone: "void", shape: "half", text: `No report for ${gap} days. The figures below describe the period before that, not today.` }
      : !published
        ? { tone: "fail", shape: "diamond", text: "This domain publishes no DMARC policy, so receiving mail servers decide on their own what to do with forged mail." }
        : published === "none"
          ? { tone: "warn", shape: "ring", text: "This domain is being watched but not yet protected: forged mail is reported, not stopped (p=none)." }
          : {
              // A statement of policy, not of health: set in ink, never in the
              // "aligned" green, and with no state mark. The evidence below
              // says how it is going.
              tone: "neutral",
              shape: null,
              text: `This domain asks receivers to ${published === "reject" ? "refuse" : "quarantine"} mail that fails authentication (p=${published}).`,
            };

  const points: TrendPoint[] = activity.dailyReports.map((d) => ({
    date: d.date,
    reportsReceived: d.reports,
    messagesObserved: d.messages,
    failedMessages: 0,
  }));

  // One line per identified service, and per sending address otherwise.
  const flowKey = (s: PublicShareReport["sources"][number]) =>
    s.service && (s.confidence === "confirmed" || s.confidence === "likely") ? `service:${s.service.name}` : `ip:${s.sourceIp}`;
  const flows = new Map<string, Flow>();
  for (const s of sources) {
    const key = flowKey(s);
    const known = key.startsWith("service:");
    const flow = flows.get(key) ?? { key, name: known ? s.service!.name : s.sourceIp, mono: !known, passed: 0, failed: 0 };
    flow.passed += Math.max(0, s.totalMessages - s.failedMessages);
    flow.failed += s.failedMessages;
    flows.set(key, flow);
  }
  const route = routeModel([...flows.values()], ["source", "sources"]);
  const outcome: PolicyOutcome = !published
    ? "missing"
    : published === "reject" || published === "quarantine" || published === "none"
      ? published
      : "unknown";

  return (
    <article className="flex flex-col gap-14 sm:gap-16 print:gap-8">
      <header className={`${RAIL} pb-2`}>
        <p className="text-[15px] leading-[1.4] text-fg-4 min-[1100px]:pt-[0.7em]">
          Prepared for <span className="font-bold text-fg">{sharedFor.client}</span>
          {sharedFor.organization ? (
            <>
              {" "}
              by <span className="font-bold text-fg">{sharedFor.organization}</span>
            </>
          ) : null}
        </p>
        <div className="min-w-0">
          {/* Long domains break after a dot, never mid-label. */}
          <h1 className="text-[38px] font-[760] leading-[1] tracking-[-0.035em] text-fg [overflow-wrap:anywhere] sm:text-[52px] min-[1100px]:text-[64px] print:text-[26pt]">
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
              "mt-7 flex max-w-[40rem] items-baseline gap-3 text-[19px] font-semibold leading-[1.4] sm:text-[21px] " +
              (answer.tone === "neutral" ? "text-fg" : answer.tone === "warn" ? "text-warn" : answer.tone === "fail" ? "text-fail" : "text-void")
            }
          >
            {answer.shape ? (
              <span className="translate-y-[1px]">
                <StateMark shape={answer.shape} tone={answer.tone === "neutral" ? "void" : (answer.tone as "warn" | "fail" | "void")} size={12} />
              </span>
            ) : null}
            <span>{answer.text}</span>
          </p>
          <p className="mt-4 max-w-[40rem] text-[17px] leading-[1.55] text-fg-2">
            This report shows what the world&rsquo;s receiving mail servers told us about mail claiming to come from{" "}
            <span className="data text-fg">{sharedFor.domain}</span>. It describes what was observed and claims no control
            over delivery.
          </p>
        </div>
      </header>

      <Section id="share-figures" title="In figures">
        <ReadoutStrip>
          <Readout
            label="Messages observed"
            value={measured ? fmt(health.messagesObserved) : "—"}
            note={`on ${reportDays} day${reportDays === 1 ? "" : "s"} with reports`}
          />
          <Readout
            label="DMARC pass rate"
            value={health.passRatePercent === null ? "—" : `${health.passRatePercent.toFixed(1)}%`}
            note="either SPF or DKIM passed with alignment"
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
      </Section>

      {route.rows.length > 0 ? (
        <Section id="share-route" title="How the mail was handled">
          <MailRoute
            rows={route.rows}
            outcome={outcome}
            name={sharedFor.domain}
            meta={`${fmt(reporting.reportsReceived)} report${reporting.reportsReceived === 1 ? "" : "s"} from receiving mail servers${
              reporting.lastReportAt ? `, the last on ${date(reporting.lastReportAt)}` : ""
            }`}
            caption={
              <>
                Each row is a source that sent mail as {sharedFor.domain}. Where a line ends is what the published policy
                asks receiving servers to do with mail that fails the check. Lines are not drawn to scale; the counts are.
              </>
            }
          />
        </Section>
      ) : null}

      <Section id="share-volume" title="Mail observed, by day">
        <p className="mb-5 max-w-[60ch] text-[15px] leading-[1.5] text-fg-2">
          Each column is one day&rsquo;s reports. A hatched day is a day no report arrived: unknown, not zero.
        </p>
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
      </Section>

      <Section id="share-policy" title="What happens next">
        <div className="flex max-w-[64ch] flex-col gap-3 text-[16px] leading-[1.6] text-fg-2">
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
            <p className="flex items-baseline gap-2.5">
              <span className="translate-y-[1px]">
                <StateMark shape="ring" tone="warn" />
              </span>
              <span>
                <span className="font-semibold text-warn">Reporting is not configured in the published record,</span> so new
                reports may not arrive. Your provider can fix this with one DNS change.
              </span>
            </p>
          ) : null}
        </div>
      </Section>

      {sources.length > 0 ? (
        <Section id="share-sources" title="Where the mail came from">
          <p className="mb-5 max-w-[64ch] text-[15px] leading-[1.5] text-fg-2">
            The sending addresses receivers saw, most failures first. A high-risk address failing most of its mail is
            usually someone pretending to be you, or a service of yours that is not set up yet. The mark beside each
            address is its line in the drawing above.
          </p>
          <Table caption={`Sending sources for ${sharedFor.domain}`} minWidth={760}>
            <THead>
              <tr>
                <Th>Source address</Th>
                <Th>Service</Th>
                <Th>Sending as</Th>
                <Th numeric>Messages</Th>
                <Th numeric>Failed DMARC</Th>
                <Th numeric title="DMARC failures as a share of this source's own messages">DMARC failure share</Th>
                <Th>Risk</Th>
              </tr>
            </THead>
            <TBody>
              {sources.map((s) => (
                <Tr key={s.sourceIp}>
                  <Td mono className="font-semibold">
                    <span className="inline-flex items-center gap-2.5">
                      <LineKey colour={route.colourOf.get(flowKey(s))} />
                      {s.sourceIp}
                    </span>
                  </Td>
                  <Td muted={!s.service}>
                    {s.service && (s.confidence === "confirmed" || s.confidence === "likely") ? s.service.name : "not identified"}
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
        </Section>
      ) : null}

      {forensic?.included ? (
        <Section id="share-forensic" title="Failure samples">
          <p className="mb-5 max-w-[64ch] text-[15px] leading-[1.5] text-fg-2">
            Some receivers send a sample of individual messages that failed. Recipient addresses in them are never shown
            here.
          </p>
          <ReadoutStrip>
            <Readout label="Failure reports" value={fmt(forensic.reportCount)} />
            <Readout label="Rejected or quarantined" value={fmt(forensic.rejectedMessages)} note="by the receiving server" />
            <Readout label="Recipients affected" value={fmt(forensic.affectedRecipients)} note="counted, never named" />
          </ReadoutStrip>
        </Section>
      ) : null}

      <Section id="share-terms" title="The terms on this page">
        <dl className="grid gap-x-12 border-t border-rule md:grid-cols-2">
          {[
            ["DMARC", "A published instruction telling receiving mail servers what to do with mail that claims your domain but fails the checks below, and where to send their reports."],
            ["SPF", "A list of the servers allowed to send mail as your domain."],
            ["DKIM", "A cryptographic signature that proves a message was sent by someone holding your domain's key."],
            ["DMARC pass rate", "The share of observed messages where either SPF or DKIM passed with alignment. A message fails DMARC only when both fail."],
            ["p=none / quarantine / reject", "Watch only, send failing mail to spam, or refuse it. Domains move from left to right as the evidence allows."],
            ["Report", "A daily summary a receiving mail server sends about mail it saw claiming your domain."],
          ].map(([k, v]) => (
            <div key={k} className="border-b border-rule py-3.5">
              <dt className="text-[15px] font-bold text-fg">{k}</dt>
              <dd className="mt-1 max-w-[52ch] text-[14.5px] leading-[1.5] text-fg-2">{v}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <footer className={`${RAIL} border-t border-fg pt-6`}>
        <span aria-hidden className="hidden min-[1100px]:block" />
        <p className="max-w-[80ch] text-[13.5px] leading-[1.55] text-fg-4">
          This report is scoped to <span className="data text-fg-2">{sharedFor.domain}</span> and nothing else. It contains
          aggregate evidence only{forensic?.included ? ", plus the failure samples shared with it" : ""}. Generated{" "}
          {date(report.generatedAt)}. The link expires on {date(report.expiresAt)} and can be withdrawn at any time by
          the team that shared it. Questions about what this means go to {sharedFor.client}&rsquo;s IT provider.
        </p>
      </footer>
    </article>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={SECTION}>
      <h2 id={id} className={H2}>
        {title}
      </h2>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
