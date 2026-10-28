/**
 * prospect-document.tsx — the page a prospect opens.
 *
 * Written for the managing director of a 40-person company, not for their IT
 * person: what is true today, why it matters, what fixing it involves. The
 * records the findings rest on are at the foot, for whoever they forward it to.
 *
 * The agency is named throughout, because the point of the page is the
 * conversation that follows it.
 */

import type { ProspectFinding, PublicProspectReport } from "@/lib/types";
import { Badge, type Tone } from "@/components/ui/badge";

const STATUS: Record<ProspectFinding["status"], { tone: Tone; label: string }> = {
  risk: { tone: "fail", label: "Fix now" },
  warn: { tone: "warn", label: "Fix soon" },
  unknown: { tone: "neutral", label: "Could not check" },
  info: { tone: "neutral", label: "Worth knowing" },
  good: { tone: "ok", label: "In place" },
};

const LEVEL: Record<PublicProspectReport["assessment"]["level"], { tone: Tone; label: string }> = {
  high: { tone: "fail", label: "High risk" },
  medium: { tone: "warn", label: "Some risk" },
  low: { tone: "ok", label: "Low risk" },
};

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function ProspectDocument({ report }: { report: PublicProspectReport }) {
  const { assessment, preparedBy, domain } = report;
  const level = LEVEL[assessment.level];
  const toFix = assessment.findings.filter((finding) => finding.status !== "good");
  const inPlace = assessment.findings.filter((finding) => finding.status === "good");

  return (
    <article className="flex flex-col gap-10" data-testid="prospect-document">
      <header className="flex flex-col gap-4">
        <p className="legend">
          Email security check for <span className="data text-fg-2">{domain}</span>
          {report.prospectName ? <> · prepared for {report.prospectName}</> : null} · by {preparedBy.workspaceName}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={level.tone}>{level.label}</Badge>
          <span className="tnum text-meta text-fg-3">
            Score <span className="font-semibold text-fg-2">{report.score}</span> of 100
          </span>
        </div>
        <h1 className="display text-[34px] leading-[1.05] tracking-[-0.02em] text-fg" data-testid="prospect-headline">
          {assessment.headline}
        </h1>
        <p className="max-w-[68ch] text-body text-fg-2">{assessment.summary}</p>
        {report.note ? (
          <blockquote className="max-w-[68ch] border-l-2 border-act pl-4 text-body text-fg-2">
            <p>{report.note}</p>
            <footer className="mt-1 text-meta text-fg-3">{preparedBy.workspaceName}</footer>
          </blockquote>
        ) : null}
      </header>

      {assessment.level === "high" ? (
        <section aria-labelledby="example-head" className="max-w-[72ch] border border-fail/30 bg-fail-wash/40 px-5 py-4">
          <h2 id="example-head" className="text-ui font-bold text-fg">
            What this looks like in practice
          </h2>
          <p className="mt-1 text-ui text-fg-2">
            An email from <span className="data">accounts@{domain}</span> tells a customer that your bank details have
            changed and asks them to pay this month&rsquo;s invoice into the new account. It was sent by someone else,
            but nothing tells the customer&rsquo;s mail server to stop it, so it arrives looking exactly like your own
            mail. This is the most common email fraud there is, and the records below are what stop it.
          </p>
        </section>
      ) : null}

      {toFix.length > 0 ? (
        <section aria-labelledby="fix-head" className="flex flex-col gap-3">
          <h2 id="fix-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
            What to fix
          </h2>
          <ol className="flex flex-col divide-y divide-rule border-y border-rule">
            {toFix.map((finding) => (
              <Finding key={finding.key} finding={finding} />
            ))}
          </ol>
        </section>
      ) : null}

      {inPlace.length > 0 ? (
        <section aria-labelledby="ok-head" className="flex flex-col gap-3">
          <h2 id="ok-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
            Already in place
          </h2>
          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            {inPlace.map((finding) => (
              <Finding key={finding.key} finding={finding} />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="next-head" className="flex max-w-[72ch] flex-col gap-2 border border-rule bg-paper-2 px-5 py-4">
        <h2 id="next-head" className="text-ui font-bold text-fg">
          Next step
        </h2>
        <p className="text-ui text-fg-2">
          {preparedBy.workspaceName} can put these records in place and monitor them, so a new mail service or a DNS
          change does not quietly undo them.
          {report.contactEmail ? (
            <>
              {" "}
              Reply to{" "}
              <a className="link data" href={`mailto:${report.contactEmail}?subject=${encodeURIComponent(`Email security for ${domain}`)}`}>
                {report.contactEmail}
              </a>{" "}
              to talk it through.
            </>
          ) : null}
        </p>
      </section>

      <section aria-labelledby="evidence-head" className="flex flex-col gap-2">
        <h2 id="evidence-head" className="legend">
          The public records this report read
        </h2>
        <dl className="grid max-w-[90ch] gap-x-6 gap-y-2 text-meta sm:grid-cols-[160px_minmax(0,1fr)]">
          <dt className="text-fg-3">DMARC (_dmarc.{domain})</dt>
          <dd className="data break-all text-fg-2">{report.evidence.dmarcRecord ?? "none published"}</dd>
          <dt className="text-fg-3">SPF</dt>
          <dd className="data break-all text-fg-2">{report.evidence.spfRecord ?? "none published"}</dd>
          <dt className="text-fg-3">Mail servers (MX)</dt>
          <dd className="data break-all text-fg-2">
            {report.evidence.mailServers.length > 0 ? report.evidence.mailServers.join(", ") : "none published"}
          </dd>
          <dt className="text-fg-3">DKIM keys found</dt>
          <dd className="data break-all text-fg-2">
            {report.evidence.dkimSelectors.length > 0 ? report.evidence.dkimSelectors.join(", ") : "none at the common names"}
          </dd>
        </dl>
        <p className="text-meta text-fg-3">
          Checked on {dateLabel(report.scannedAt)} from public DNS only. Nothing was changed on {domain}, and no email
          was read.
        </p>
      </section>
    </article>
  );
}

function Finding({ finding }: { finding: ProspectFinding }) {
  const status = STATUS[finding.status];
  return (
    <li className="flex flex-col gap-1.5 py-4" data-testid={`prospect-finding-${finding.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="legend">{finding.area}</span>
      </div>
      <p className="text-body font-semibold text-fg">{finding.headline}</p>
      <p className="max-w-[72ch] text-ui text-fg-2">{finding.detail}</p>
      {finding.fix ? (
        <p className="max-w-[72ch] text-ui text-fg-2">
          <span className="font-semibold text-fg">What fixing it involves: </span>
          {finding.fix}
        </p>
      ) : null}
    </li>
  );
}
