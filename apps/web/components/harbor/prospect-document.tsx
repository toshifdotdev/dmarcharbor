/**
 * prospect-document.tsx — the page a prospect opens.
 *
 * Written for the managing director of a 40-person company, not for their IT
 * person: what is true today, why it matters, what fixing it involves. The
 * records the findings rest on are at the foot, for whoever they forward it to.
 *
 * The agency is named throughout, because the point of the page is the
 * conversation that follows it; on its white-labelled workspace the reply
 * button takes the agency's colour, and nothing else does.
 *
 * Laid out like the public documents (section heading in a left rail), with
 * two drawings in the map's language:
 *
 * - What happens to a forged email today: one dashed red line, a message that
 *   claims to be from the domain and fails the checks, ending where the
 *   domain's DMARC policy sends it. It is read from public DNS, not measured
 *   mail, and its caption says so.
 * - What to fix: each finding a station on a line not built yet (dashed, the
 *   map's line under construction), worst first. What is already in place is
 *   the travelled line, in solid ink.
 */

import type { ReactNode } from "react";
import type { ProspectFinding, PublicProspectReport } from "@/lib/types";
import { FAILED_LINE, MailRoute, StateWord, type MarkShape, type MarkTone, type PolicyOutcome } from "./document-route";
import s from "./document-route.module.css";

const STATUS: Record<ProspectFinding["status"], { tone: MarkTone; shape: MarkShape | null; label: string }> = {
  risk: { tone: "fail", shape: "diamond", label: "Fix now" },
  warn: { tone: "warn", shape: "ring", label: "Fix soon" },
  unknown: { tone: "void", shape: "hatch", label: "Could not check" },
  info: { tone: "void", shape: null, label: "Worth knowing" },
  good: { tone: "ok", shape: "square", label: "In place" },
};

const LEVEL: Record<PublicProspectReport["assessment"]["level"], { tone: MarkTone; shape: MarkShape; label: string }> = {
  high: { tone: "fail", shape: "diamond", label: "High risk" },
  medium: { tone: "warn", shape: "ring", label: "Some risk" },
  low: { tone: "ok", shape: "square", label: "Low risk" },
};

/** The rail and the column, as the public documents set them. */
const RAIL = "grid gap-x-24 gap-y-5 min-[1100px]:grid-cols-[248px_minmax(0,1fr)]";
const SECTION = `${RAIL} border-t border-rule pt-10 sm:pt-12 print:pt-6`;
const H2 = "text-[22px] font-[740] leading-[1.15] tracking-[-0.02em] text-fg [text-wrap:balance] sm:text-[24px] print:text-[14pt]";

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * Where a forged message ends, from the API's own reading of the record (the
 * spoofing finding allows for testing mode, which a bare p= tag would not).
 */
function forgedOutcome(report: PublicProspectReport): PolicyOutcome | null {
  const spoof = report.assessment.findings.find((f) => f.key === "spoofing");
  if (!spoof || spoof.status === "unknown") return null;
  if (spoof.status === "good") return "reject";
  if (spoof.status === "warn") return "quarantine";
  return report.evidence.dmarcRecord ? "none" : "missing";
}

export function ProspectDocument({ report }: { report: PublicProspectReport }) {
  const { assessment, preparedBy, domain } = report;
  const level = LEVEL[assessment.level];
  const toFix = assessment.findings.filter((finding) => finding.status !== "good");
  const inPlace = assessment.findings.filter((finding) => finding.status === "good");
  const forged = forgedOutcome(report);
  const agency = preparedBy.workspaceName;

  return (
    <article className="flex flex-col gap-14 sm:gap-16 print:gap-8" data-testid="prospect-document">
      <header className={`${RAIL} pb-2`}>
        <p className="text-[15px] leading-[1.4] text-fg-4 min-[1100px]:pt-[0.6em]">
          {report.prospectName ? (
            <>
              Prepared for <span className="font-bold text-fg">{report.prospectName}</span> by{" "}
            </>
          ) : (
            <>Prepared by </>
          )}
          <span className="font-bold text-fg">{agency}</span>
        </p>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <StateWord shape={level.shape} tone={level.tone} size="lg">
              {level.label}
            </StateWord>
            <span className="tnum text-[15px] text-fg-4">
              Score <span className="font-bold text-fg">{report.score}</span> of 100
            </span>
            <span className="data text-[14px] text-fg-2 [overflow-wrap:anywhere]">{domain}</span>
          </p>
          <h1
            className="mt-6 max-w-[22ch] text-[36px] font-[760] leading-[1] tracking-[-0.035em] text-fg [overflow-wrap:anywhere] [text-wrap:balance] sm:text-[48px] min-[1100px]:text-[60px] print:text-[24pt]"
            data-testid="prospect-headline"
          >
            {assessment.headline}
          </h1>
          <p className="mt-6 max-w-[38rem] text-[17px] leading-[1.5] text-fg-2 sm:text-[19px]">{assessment.summary}</p>
          {report.note ? (
            <blockquote className="mt-8 max-w-[38rem] border-l-[3px] border-rule-2 pl-5">
              <p className="text-[17px] leading-[1.5] text-fg">&ldquo;{report.note}&rdquo;</p>
              <footer className="mt-2 text-[14px] text-fg-4">
                <span className="font-semibold text-fg-2">{agency}</span>
              </footer>
            </blockquote>
          ) : null}
        </div>
      </header>

      {forged ? (
        <Section id="example-head" title="What happens to a forged email today">
          {assessment.level === "high" ? (
            <p className="mb-6 max-w-[62ch] text-[16px] leading-[1.6] text-fg-2">
              An email from <span className="data text-fg">accounts@{domain}</span> tells a customer that your bank details
              have changed and asks them to pay this month&rsquo;s invoice into the new account. It was sent by someone
              else, but nothing tells the customer&rsquo;s mail server to stop it, so it arrives looking exactly like your
              own mail. This is the most common email fraud there is, and the records below are what stop it.
            </p>
          ) : (
            <p className="mb-6 max-w-[62ch] text-[16px] leading-[1.6] text-fg-2">
              A message that claims to be from <span className="data text-fg">{domain}</span> but was sent by someone else
              fails the checks. What happens next is up to the domain&rsquo;s DMARC policy.
            </p>
          )}
          <MailRoute
            rows={[
              {
                key: "forged",
                // An address breaks after the @, never inside the domain.
                name: (
                  <>
                    accounts@<span className="inline-block">{domain}</span>
                  </>
                ),
                mono: true,
                kind: "sent by someone else",
                colour: FAILED_LINE,
                failing: true,
              },
            ]}
            outcome={forged}
            name={domain}
            meta={`read from public DNS on ${dateLabel(report.scannedAt)}`}
            caption={
              <>
                An illustration drawn from {domain}&rsquo;s published records, not a measurement of its mail. The line
                ends where its DMARC policy tells receiving mail servers to put a message that fails the checks.
              </>
            }
          />
        </Section>
      ) : null}

      {toFix.length > 0 ? (
        <Section id="fix-head" title="What to fix">
          <ol className={s.steps}>
            {toFix.map((finding) => (
              <Finding key={finding.key} finding={finding} />
            ))}
          </ol>
        </Section>
      ) : null}

      {inPlace.length > 0 ? (
        <Section id="ok-head" title="Already in place">
          <ul className={s.steps} data-done="">
            {inPlace.map((finding) => (
              <Finding key={finding.key} finding={finding} />
            ))}
          </ul>
        </Section>
      ) : null}

      <Section id="next-head" title="Next step">
        <div className="max-w-[44rem] rounded-sheet border border-rule px-6 py-6 sm:px-8 sm:py-7 print:border-fg">
          <p className="text-[17px] leading-[1.55] text-fg-2">
            <span className="font-semibold text-fg">{agency}</span> can put these records in place and monitor them, so a
            new mail service or a DNS change does not quietly undo them.
            {report.contactEmail ? " Reply to talk it through." : null}
          </p>
          {report.contactEmail ? (
            <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
              <a
                className="inline-flex h-12 items-center rounded-full bg-cta px-6 text-[16px] font-semibold text-cta-ink transition-colors duration-150 hover:bg-cta-hover print:hidden"
                href={`mailto:${report.contactEmail}?subject=${encodeURIComponent(`Email security for ${domain}`)}`}
              >
                Reply to {agency}
              </a>
              <a
                className="link data text-[14px] text-fg [overflow-wrap:anywhere]"
                href={`mailto:${report.contactEmail}?subject=${encodeURIComponent(`Email security for ${domain}`)}`}
              >
                {report.contactEmail}
              </a>
            </div>
          ) : null}
        </div>
      </Section>

      <Section id="evidence-head" title="The public records this report read">
        <dl className="grid max-w-[90ch] border-t border-rule sm:grid-cols-[200px_minmax(0,1fr)]">
          {(
            [
              [`DMARC (_dmarc.${domain})`, report.evidence.dmarcRecord ?? "none published"],
              ["SPF", report.evidence.spfRecord ?? "none published"],
              [
                "Mail servers (MX)",
                report.evidence.mailServers.length > 0 ? report.evidence.mailServers.join(", ") : "none published",
              ],
              [
                "DKIM keys found",
                report.evidence.dkimSelectors.length > 0 ? report.evidence.dkimSelectors.join(", ") : "none at the common names",
              ],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="border-rule pt-3 text-[14px] font-semibold text-fg sm:border-b sm:pb-3 [overflow-wrap:anywhere]">{k}</dt>
              <dd className="data break-all border-b border-rule pb-3 pt-1 text-[13.5px] text-fg-2 sm:pt-3">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 max-w-[64ch] text-[14px] leading-[1.5] text-fg-4">
          Checked on {dateLabel(report.scannedAt)} from public DNS only. Nothing was changed on {domain}, and no email
          was read.
        </p>
      </Section>
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

function Finding({ finding }: { finding: ProspectFinding }) {
  const status = STATUS[finding.status];
  return (
    <li className={s.step} data-testid={`prospect-finding-${finding.key}`}>
      <span aria-hidden className={s.stepCap} />
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {status.shape ? (
            <StateWord shape={status.shape} tone={status.tone}>
              {status.label}
            </StateWord>
          ) : (
            <span className="text-ui font-semibold text-fg-3">{status.label}</span>
          )}
          <span className="text-[13.5px] text-fg-4">{finding.area}</span>
        </p>
        <p className="mt-2 max-w-[44ch] text-[19px] font-bold leading-[1.3] tracking-[-0.01em] text-fg [overflow-wrap:anywhere] [text-wrap:pretty]">
          {finding.headline}
        </p>
        <p className="mt-2 max-w-[64ch] text-[15.5px] leading-[1.55] text-fg-2">{finding.detail}</p>
        {finding.fix ? (
          <p className="mt-2 max-w-[64ch] text-[15.5px] leading-[1.55] text-fg-2">
            <span className="font-semibold text-fg">What fixing it involves: </span>
            {finding.fix}
          </p>
        ) : null}
      </div>
    </li>
  );
}
