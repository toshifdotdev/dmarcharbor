/**
 * trust-document.tsx — the public Trust Center an auditor opens.
 *
 * Its reader is a security or procurement reviewer at the client, or the
 * client's insurer, with a questionnaire open in another window. They need to
 * find each answer fast, quote it exactly, and print the page for a meeting.
 * So it is set like the public legal documents it sits beside: the document's
 * identity first (who publishes it, about whom, generated when), the figures
 * they ask first as one row, then numbered sections with stable addresses and
 * headings that link to themselves, and a contents line that marks where they
 * are.
 *
 * Two halves. The first is evidence about the client's email: posture from the
 * newest DNS check of each domain, the DMARC policy history, monitoring
 * coverage, the senders seen and the open findings, each as the record states
 * it. The second is how the client's data is held. Every claim is QUOTED from
 * the API's payload: nothing is rewritten, scored or embellished, a state is
 * always a word with its shape, and what has not been measured says so.
 *
 * It prints as a document: the contents and section links drop out, tables
 * fit the page, and a heading stays with what follows it.
 *
 * The payload fields added for the evidence (`evidence`, `evidencePacks`,
 * `retentionDetail`, `contact` and the rest) are read as optional, so the page
 * still renders the data-handling half against an API that predates them.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import type { TrustCenterPayload } from "@/lib/types";
import { Readout, ReadoutStrip } from "@/components/ui/readout";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { ChevronDown } from "@/components/ui/icons";
import { PolicyScale, PolicyStrip, policyStage, type Stage } from "./document-route";
import { Contents } from "./legal-client";
import { LegalHeading2 } from "./legal-render";
import { Digest } from "./pack-verifier";
import { StateWord, type MarkShape, type MarkTone } from "./settings/parts";

/* ── The evidence half of the payload, read as optional ─────────────────── */

type CheckState = "pass" | "warn" | "fail" | "absent" | "unchecked";

interface CheckReading {
  state: CheckState;
  word: string;
  detail: string | null;
}

interface DomainEvidence {
  name: string;
  ownership: "verified" | "pending" | "failed";
  verifiedAt: string | null;
  addedAt: string;
  posture: {
    checkedAt: string | null;
    dmarc: CheckReading & { policy: string | null; level: 0 | 1 | 2 | null; record: string | null };
    spf: CheckReading & { record: string | null };
    dkim: CheckReading & { selectors: string[] };
    mtaSts: CheckReading;
    tlsRpt: CheckReading & { record: string | null };
    bimi: CheckReading & { record: string | null };
  };
  coverage: {
    reporting: "this-service" | "elsewhere" | "none" | "unknown";
    lastReportAt: string | null;
    reportsInWindow: number;
    daysMeasured: number;
    reporters: number;
    tlsReportsInWindow: number;
  };
  senders: {
    sources: number;
    approved: number;
    notOurs: number;
    unreviewed: number;
    failing: number;
    messages: number;
    dmarcPass: number;
  };
}

interface ClientEvidence {
  asOf: string;
  windowDays: number;
  windowStart: string;
  domainCount: number;
  domains: DomainEvidence[];
  history: { domain: string; at: string; kind: string; text: string }[];
  historyTotal: number;
  findings: {
    alerts: { domain: string; openedAt: string; summary: string; acknowledged: boolean }[];
    alertCount: number;
    changes: { domain: string; detectedAt: string; severity: "warning" | "critical"; summary: string }[];
    changeCount: number;
    checks: { domain: string; severity: "error" | "warning"; title: string }[];
    proposals: { domain: string; proposedAt: string; from: string; to: string; expiresAt: string }[];
  };
  totals: {
    enforcing: number;
    reportingHere: number;
    receivingReports: number;
    sources: number;
    messages: number;
    dmarcPass: number;
    openFindings: number;
  };
  checks: { oldest: string | null; newest: string | null };
  reports: { inWindow: number; reporters: number };
}

type Payload = Omit<TrustCenterPayload, "provider" | "subProcessors"> & {
  provider: TrustCenterPayload["provider"] & { branded?: boolean };
  subProcessors: Array<TrustCenterPayload["subProcessors"][number] & { region?: string }>;
  retentionDetail?: { label: string; value: string }[];
  connectedServices?: string;
  noTracking?: string;
  evidence?: ClientEvidence;
  monitoring?: { scheduled: boolean; intervalMinutes: number };
  evidencePacks?: {
    reference: string;
    sha256: string;
    issuedAt: string;
    dataAsOf: string;
    superseded: boolean;
    documentVersion: string;
    pageCount: number;
  }[];
  contact?: { name: string; detail: string };
};

/* ── Words and marks ───────────────────────────────────────────────────── */

const MARK: Record<CheckState, { shape: MarkShape; tone: MarkTone }> = {
  pass: { shape: "square", tone: "ok" },
  warn: { shape: "ring", tone: "warn" },
  fail: { shape: "diamond", tone: "fail" },
  absent: { shape: "closed", tone: "void" },
  unchecked: { shape: "hatch", tone: "void" },
};

function State({ state, children, size = "meta" }: { state: CheckState; children: ReactNode; size?: "meta" | "ui" }) {
  const m = MARK[state];
  return (
    <StateWord shape={m.shape} tone={m.tone} size={size}>
      {children}
    </StateWord>
  );
}

const date = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    : "Nil";
const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null;
const instant = (iso: string) =>
  `${date(iso)}, ${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
const n = (v: number) => v.toLocaleString("en-GB");
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

function share(part: number, whole: number): string | null {
  if (whole <= 0) return null;
  if (part === whole) return "100%";
  return `${(Math.floor((part / whole) * 1000) / 10).toFixed(1)}%`;
}

function interval(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "every hour" : `every ${hours} hours`;
  }
  return `every ${minutes} minutes`;
}

/** A missing date or figure: the word, quiet, never a zero. */
function Missing({ label = "Nil" }: { label?: string }) {
  return <span className="text-fg-4">{label}</span>;
}

function stageOf(policyLabel: string): Stage {
  return policyStage(policyLabel.replace(/^p=/, "").split(",")[0]?.trim() ?? null);
}

/* ── The document ──────────────────────────────────────────────────────── */

/** The rail and the text column, as the legal documents set them. */
const RAIL = "grid gap-6 min-[1100px]:grid-cols-[248px_minmax(0,1fr)] min-[1100px]:gap-x-24";

/**
 * Stable addresses. The data-handling ids are the ones the page always had,
 * so a link an auditor already holds still lands on its section.
 */
const SECTION_ID: Record<string, string> = {
  "Authentication posture": "posture",
  "DMARC policy history": "policy-history",
  "Monitoring coverage": "monitoring",
  "Senders seen": "senders",
  "Open findings and what is being done": "findings",
  "How this evidence is gathered": "method",
  "How this data is held": "how-it-is-held",
  "What is held": "what-is-held",
  "Who can read it": "who-can-read-it",
  "Retention and deletion": "retention-and-deletion",
  "Where it is held": "where-it-is-held",
  "Sub-processors": "sub-processors",
  "Rights of the people in this data": "rights",
  "Evidence packs and how to check one": "evidence-packs",
  Contact: "contact",
};

const numberOf = (titles: string[], title: string) => `${titles.indexOf(title) + 1}.`;

/** A numbered section, its number taken from its place in the list. */
function S({ titles, title, children }: { titles: string[]; title: string; children: ReactNode }) {
  return (
    <Section id={SECTION_ID[title]!} number={numberOf(titles, title)} title={title}>
      {children}
    </Section>
  );
}

export function TrustDocument({ payload: input, platformName = null }: { payload: TrustCenterPayload; platformName?: string | null }) {
  const payload = input as Payload;
  const evidence = payload.evidence ?? null;
  const client = payload.client.name;
  const publisher = payload.provider.workspaceName;
  const personal = payload.dataHeld.filter((d) => d.containsPersonalData).length;

  const titles: string[] = [
    ...(evidence
      ? [
          "Authentication posture",
          "DMARC policy history",
          "Monitoring coverage",
          "Senders seen",
          "Open findings and what is being done",
          "How this evidence is gathered",
        ]
      : []),
    "How this data is held",
    "What is held",
    "Who can read it",
    "Retention and deletion",
    "Where it is held",
    "Sub-processors",
    "Rights of the people in this data",
    "Evidence packs and how to check one",
    "Contact",
  ];
  const sections = titles.map((title) => ({ id: SECTION_ID[title]!, text: `${numberOf(titles, title)} ${title}` }));
  const findingsNumber = numberOf(titles, "Open findings and what is being done").replace(/\.$/, "");

  return (
    <article>
      <header className={`${RAIL} border-b border-fg pb-10 print:block print:pb-5`}>
        <p className="text-[15px] leading-[1.4] text-fg-4 min-[1100px]:pt-[0.55em] print:pb-3">
          Published by <span className="font-bold text-fg">{publisher}</span>
          {platformName && !payload.provider.branded ? <span className="block">using {platformName}</span> : null}
        </p>
        <div className="min-w-0">
          <h1 className="max-w-[22ch] text-[38px] font-[760] leading-[0.98] tracking-[-0.035em] text-fg [text-wrap:balance] sm:text-[52px] min-[1100px]:text-[60px] print:text-[24pt]">
            Email authentication for {client}, and what we hold about it.
          </h1>
          <p className="mt-7 max-w-[38rem] text-[17px] leading-[1.5] text-fg-2 sm:text-[19px] print:text-[11pt]">
            This page is public on purpose, so a reviewer at {client} can check these claims without an account, a sales
            call or an NDA. It is generated from the live record each time it opens: the newest DNS check of every
            domain, the reports mail providers send, and the data handling rules the platform enforces.
          </p>
          <dl className="mt-7 flex flex-wrap items-baseline gap-x-8 gap-y-3 text-[15px] print:text-[10pt]">
            <div className="flex items-baseline gap-2">
              <dt className="text-fg-4">Generated</dt>
              <dd className="tnum font-bold text-fg">{instant(payload.generatedAt)}</dd>
            </div>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <dt className="text-fg-4">Domains covered</dt>
              {payload.client.domains.length ? (
                payload.client.domains.map((d) => (
                  <dd key={d} className="data text-[14px] font-semibold text-fg [overflow-wrap:anywhere]">
                    {d}
                  </dd>
                ))
              ) : (
                <dd className="text-fg-3">none listed</dd>
              )}
            </div>
          </dl>
        </div>
      </header>

      {/* On a phone the contents are one tap away, above the text. */}
      <details className="group mt-8 border-b border-rule pb-4 min-[1100px]:hidden print:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[15px] font-semibold text-fg [&::-webkit-details-marker]:hidden">
          <span>
            Contents <span className="font-normal text-fg-4">{sections.length} sections</span>
          </span>
          <span aria-hidden className="text-fg-3 transition-transform duration-150 group-open:rotate-180">
            <ChevronDown size={16} />
          </span>
        </summary>
        <div className="pt-5">
          <Contents headings={sections} />
        </div>
      </details>

      <div className={`${RAIL} mt-10 min-[1100px]:mt-14 print:mt-6 print:block`}>
        <aside className="hidden min-[1100px]:block print:hidden">
          <div className="sticky top-8">
            <Contents headings={sections} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-col">
          {evidence ? (
            <ReadoutStrip className="print:break-inside-avoid">
              <Readout label="Domains" value={n(evidence.domainCount)} note="covered by this page" />
              <Readout
                label="At enforcement"
                value={`${n(evidence.totals.enforcing)} of ${n(evidence.domains.length)}`}
                note="publish p=quarantine or p=reject"
              />
              <Readout
                label="Reporting"
                value={`${n(evidence.totals.receivingReports)} of ${n(evidence.domains.length)}`}
                note={`sent reports in the last ${evidence.windowDays} days`}
              />
              <Readout
                label="Open findings"
                value={n(evidence.totals.openFindings)}
                note={`listed in section ${findingsNumber}`}
              />
            </ReadoutStrip>
          ) : null}

          {evidence ? (
            <>
              <S titles={titles} title="Authentication posture">
                <Lead>
                  From the newest completed DNS check of each domain. A check reads the published records from public DNS;
                  it shows what receivers are told to do, not what happened to any one message. MTA-STS, TLS-RPT and BIMI
                  are optional standards, so &ldquo;Not published&rdquo; is a fact rather than a fault.
                </Lead>
                {evidence.domains.length === 0 ? (
                  <Empty>No domain has been added for {client} yet, so there is no posture to report.</Empty>
                ) : (
                <>
                <H3>DMARC enforcement</H3>
                <Table caption="DMARC policy per domain" minWidth={560} className="print:min-w-0!">
                  <THead>
                    <tr>
                      <Th>Domain</Th>
                      <Th className="w-[150px]">
                        <PolicyScale />
                      </Th>
                      <Th>Policy</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {evidence.domains.map((d) => {
                      const proposal = evidence.findings.proposals.find((p) => p.domain === d.name);
                      return (
                        <Tr key={d.name} className="print:break-inside-avoid">
                          <Td mono className="[overflow-wrap:anywhere]">
                            {d.name}
                          </Td>
                          <Td>
                            <PolicyStrip at={d.posture.dmarc.level} to={proposal ? stageOf(proposal.to) : undefined} className="w-[130px] pt-1" />
                          </Td>
                          <Td>
                            <State state={d.posture.dmarc.state} size="ui">
                              {d.posture.dmarc.word}
                            </State>
                            {d.posture.dmarc.detail ? <p className="mt-0.5 text-meta text-fg-3">{d.posture.dmarc.detail}</p> : null}
                          </Td>
                        </Tr>
                      );
                    })}
                  </TBody>
                </Table>
                <Caption>
                  The line runs in ink as far as the published policy: monitor (p=none), spam (p=quarantine), block
                  (p=reject). A dashed segment is a stronger policy proposed to {client} and not yet approved.
                </Caption>

                <H3>Other checks</H3>
                <Table caption="SPF, DKIM, MTA-STS, TLS-RPT and BIMI per domain" minWidth={640} className="print:min-w-0!">
                  <THead>
                    <tr>
                      <Th>Domain</Th>
                      <Th>SPF</Th>
                      <Th>DKIM</Th>
                      <Th>MTA-STS</Th>
                      <Th>TLS-RPT</Th>
                      <Th>BIMI</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {evidence.domains.map((d) => (
                      <Tr key={d.name} className="print:break-inside-avoid">
                        <Td mono className="[overflow-wrap:anywhere]">
                          {d.name}
                        </Td>
                        {[d.posture.spf, d.posture.dkim, d.posture.mtaSts, d.posture.tlsRpt, d.posture.bimi].map((r, i) => (
                          <Td key={i}>
                            <State state={r.state}>{r.word}</State>
                          </Td>
                        ))}
                      </Tr>
                    ))}
                  </TBody>
                </Table>

                <H3>Records as published</H3>
                <p className="mt-1.5 max-w-[68ch] text-[15px] leading-[1.55] text-fg-3">
                  The values read at the newest check, quoted exactly, with what each reading rests on.
                </p>
                <div className="mt-4 flex flex-col gap-8">
                  {evidence.domains.slice(0, 25).map((d) => (
                    <DomainRecords key={d.name} domain={d} />
                  ))}
                </div>
                {evidence.domains.length > 25 ? (
                  <Caption>
                    Records for the other {plural(evidence.domains.length - 25, "domain")} are summarised in the tables
                    above and not quoted here.
                  </Caption>
                ) : null}
                </>
                )}
              </S>

              <S titles={titles} title="DMARC policy history">
                <Lead>
                  Changes to each DMARC record seen between consecutive DNS checks, and the policy changes {client} decided
                  on. The first line for a domain is the earliest check still held, not necessarily the day monitoring
                  began.
                </Lead>
                {evidence.history.length === 0 ? (
                  <Empty>No DMARC check or change is held for these domains yet.</Empty>
                ) : (
                  <Table caption="DMARC policy history" dense minWidth={520} className="print:min-w-0!">
                    <THead>
                      <tr>
                        <Th>Date</Th>
                        <Th>Domain</Th>
                        <Th>What changed</Th>
                      </tr>
                    </THead>
                    <TBody>
                      {evidence.history.map((h, i) => (
                        <Tr key={`${h.domain}-${h.at}-${i}`} className="print:break-inside-avoid">
                          <Td muted className="tnum whitespace-nowrap">
                            {shortDate(h.at)}
                          </Td>
                          <Td mono className="[overflow-wrap:anywhere]">
                            {h.domain}
                          </Td>
                          <Td className="text-fg-2">{h.text}</Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                )}
                {evidence.historyTotal > evidence.history.length ? (
                  <Caption>
                    {plural(evidence.historyTotal - evidence.history.length, "earlier entry is", "earlier entries are")} not
                    listed. Each domain keeps its earliest check and its newest changes.
                  </Caption>
                ) : null}
              </S>

              <S titles={titles} title="Monitoring coverage">
                <Lead>
                  Receiving mail providers send aggregate (RUA) reports to the address a domain&rsquo;s DMARC record names.
                  The window is the {evidence.windowDays} days to {date(evidence.asOf)}. Days measured counts the distinct
                  days, in UTC, on which a reported period began.
                </Lead>
                {evidence.domains.length === 0 ? <Empty>No domain to report.</Empty> : null}
                <Table caption="Monitoring coverage per domain" minWidth={620} className={evidence.domains.length === 0 ? "hidden" : "print:min-w-0!"}>
                  <THead>
                    <tr>
                      <Th>Domain</Th>
                      <Th>Aggregate reports</Th>
                      <Th>Last received</Th>
                      <Th numeric>Reports</Th>
                      <Th numeric>Days measured</Th>
                      <Th numeric>Reporters</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {evidence.domains.map((d) => (
                      <Tr key={d.name} className="print:break-inside-avoid">
                        <Td mono className="[overflow-wrap:anywhere]">
                          {d.name}
                        </Td>
                        <Td>
                          <Reporting value={d.coverage.reporting} />
                        </Td>
                        <Td className="whitespace-nowrap">{shortDate(d.coverage.lastReportAt) ?? <Missing />}</Td>
                        <Td numeric>{n(d.coverage.reportsInWindow)}</Td>
                        <Td numeric>
                          {n(d.coverage.daysMeasured)} <span className="text-fg-4">of {evidence.windowDays}</span>
                        </Td>
                        <Td numeric>{n(d.coverage.reporters)}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
                <Caption>
                  {(() => {
                    const tls = evidence.domains.reduce((sum, d) => sum + d.coverage.tlsReportsInWindow, 0);
                    return tls > 0
                      ? `${plural(tls, "TLS-RPT report")} arrived in the window. `
                      : "No TLS-RPT report arrived in the window. ";
                  })()}
                  Receivers choose whether to send reports, so mail delivered to a provider that sends none is not counted.
                </Caption>
              </S>

              <S titles={titles} title="Senders seen">
                <Lead>
                  A sending source is one identity in the reports: the domain the mail authenticated as, or the sending IP
                  address where no domain was reported. Approved and not ours are decisions {publisher} recorded. Failing
                  means at least 50 messages with more than 5% failing DMARC, not counting sources marked not ours.
                </Lead>
                {evidence.domains.length === 0 ? <Empty>No domain to report.</Empty> : null}
                <Table caption="Senders seen per domain" minWidth={640} className={evidence.domains.length === 0 ? "hidden" : "print:min-w-0!"}>
                  <THead>
                    <tr>
                      <Th>Domain</Th>
                      <Th numeric>Sources</Th>
                      <Th numeric>Approved</Th>
                      <Th numeric>Not ours</Th>
                      <Th numeric>Unreviewed</Th>
                      <Th numeric>Failing</Th>
                      <Th numeric>Messages</Th>
                      <Th numeric>Passing DMARC</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {evidence.domains.map((d) => (
                      <Tr key={d.name} className="print:break-inside-avoid">
                        <Td mono className="[overflow-wrap:anywhere]">
                          {d.name}
                        </Td>
                        <Td numeric>{n(d.senders.sources)}</Td>
                        <Td numeric>{n(d.senders.approved)}</Td>
                        <Td numeric>{n(d.senders.notOurs)}</Td>
                        <Td numeric>{n(d.senders.unreviewed)}</Td>
                        <Td numeric className={d.senders.failing > 0 ? "font-semibold text-fail" : undefined}>
                          {n(d.senders.failing)}
                        </Td>
                        <Td numeric>{n(d.senders.messages)}</Td>
                        <Td numeric>{share(d.senders.dmarcPass, d.senders.messages) ?? <Missing />}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
                <Caption>
                  Counted over the {evidence.windowDays} days to {date(evidence.asOf)}.{" "}
                  {evidence.totals.messages > 0
                    ? `${n(evidence.totals.messages)} messages from ${plural(evidence.totals.sources, "sending source")}; ${share(evidence.totals.dmarcPass, evidence.totals.messages)} passed DMARC.`
                    : "No messages were reported in the window."}
                </Caption>
              </S>

              <S titles={titles} title="Open findings and what is being done">
                <Findings evidence={evidence} publisher={publisher} client={client} />
              </S>

              <S titles={titles} title="How this evidence is gathered">
                <Facts
                  rows={[
                    [
                      "DNS checks",
                      `Each domain's DMARC, SPF, DKIM, MX, MTA-STS, TLS-RPT and BIMI records are read from public DNS by the monitoring service, ${
                        payload.monitoring?.scheduled
                          ? `${interval(payload.monitoring.intervalMinutes)} for every verified domain and whenever ${publisher} runs a check`
                          : payload.monitoring
                            ? `whenever ${publisher} runs a check; scheduled checks are not running on this deployment`
                            : `on a schedule and whenever ${publisher} runs a check`
                      }. This page uses the newest completed check of each domain${
                        evidence.checks.oldest && evidence.checks.newest
                          ? `; those checks ran between ${date(evidence.checks.oldest)} and ${date(evidence.checks.newest)}`
                          : ""
                      }.`,
                    ],
                    [
                      "DKIM keys",
                      "Found by probing selector names known for common senders and the selectors already seen. A key at a selector that was never probed is not seen.",
                    ],
                    [
                      "Aggregate reports",
                      `Daily XML reports from receiving mail providers, parsed and stored as they arrive. The figures above count reports whose period began between ${date(evidence.windowStart)} and ${date(evidence.asOf)}${
                        evidence.reports.inWindow > 0
                          ? `: ${plural(evidence.reports.inWindow, "report")} from ${plural(evidence.reports.reporters, "reporting organisation")}`
                          : ": none arrived"
                      }.`,
                    ],
                    [
                      "A pass",
                      "A message passes DMARC when its aligned DKIM or aligned SPF result passed, as the receiver evaluated it. Rates are counted from messages, never averaged across domains.",
                    ],
                    ["Time", "All dates and times are UTC."],
                  ]}
                />
              </S>
            </>
          ) : null}

          <S titles={titles} title="How this data is held">
            <ReadoutStrip className="mb-8 print:break-inside-avoid">
              <Readout
                label="Personal data"
                value={`${personal} of ${payload.dataHeld.length}`}
                note="categories held contain personal data"
              />
              <Readout label="Sub-processors" value={String(payload.subProcessors.length)} note="named below, with what they touch" />
              <Readout label="Region" value={<span className="text-h3">{payload.residency.region}</span>} note={payload.residency.hosting} />
              <Readout label="Completed erasures" value={String(payload.erasures.length)} note="listed under retention" />
            </ReadoutStrip>
            <Facts
              rows={[
                ["Isolation", payload.statement.isolation],
                ["Covered by tests", payload.statement.coveredByTests],
                ["Law-enforcement requests", payload.statement.lawEnforcementRequests],
              ]}
            />
          </S>

          <S titles={titles} title="What is held">
            <Table caption="Categories of data held" minWidth={560} className="print:min-w-0!">
              <THead>
                <tr>
                  <Th>Category</Th>
                  <Th>Description</Th>
                  <Th>Personal data</Th>
                </tr>
              </THead>
              <TBody>
                {payload.dataHeld.map((d) => (
                  <Tr key={d.category} className="print:break-inside-avoid">
                    <Td className="font-semibold">{d.category}</Td>
                    <Td className="text-fg-2">{d.description}</Td>
                    {/* A disclosure, not a state: set in ink, not in a warning colour. */}
                    <Td>{d.containsPersonalData ? <span className="font-bold text-fg">Yes</span> : <span className="text-fg-3">No</span>}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </S>

          <S titles={titles} title="Who can read it">
            <Facts rows={payload.access.map((a) => [a.role, a.canRead])} />
          </S>

          <S titles={titles} title="Retention and deletion">
            <Facts
              rows={
                payload.retentionDetail?.length
                  ? payload.retentionDetail.map((r) => [r.label, r.value] as [string, string])
                  : [
                      ["Data", payload.retention.data],
                      ["Audit", payload.retention.audit],
                      ["Deletion window", payload.retention.deletionWindow],
                    ]
              }
            />
            <p className="mt-4 max-w-[68ch] text-[15px] leading-[1.55] text-fg-3">
              Each window is applied automatically. A failed payment deletes nothing: a lapsed workspace keeps every client,
              domain and report.
            </p>
            <H3>Completed erasures</H3>
            {payload.erasures.length === 0 ? (
              <p className="mt-1.5 text-[15px] text-fg-3">None have been carried out for this client.</p>
            ) : (
              <div className="mt-3">
                <Table caption="Completed erasures" dense minWidth={420} className="print:min-w-0!">
                  <THead>
                    <tr>
                      <Th>Scope</Th>
                      <Th numeric>Records removed</Th>
                      <Th numeric>Completed</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {payload.erasures.map((e, i) => (
                      <Tr key={`${e.scope}-${i}`}>
                        <Td>{e.scope}</Td>
                        <Td numeric>{e.recordCount.toLocaleString("en-GB")}</Td>
                        <Td numeric muted>
                          {date(e.completedAt)}
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </S>

          <S titles={titles} title="Where it is held">
            <Facts
              rows={[
                ["Region", payload.residency.region],
                ["Hosting", payload.residency.hosting],
              ]}
            />
          </S>

          <S titles={titles} title="Sub-processors">
            <Table caption="Sub-processors" minWidth={600} className="print:min-w-0!">
              <THead>
                <tr>
                  <Th>Provider</Th>
                  <Th>Purpose</Th>
                  <Th>Data they touch</Th>
                  {payload.subProcessors.some((s) => s.region) ? <Th>Region</Th> : null}
                </tr>
              </THead>
              <TBody>
                {payload.subProcessors.map((s) => (
                  <Tr key={s.name} className="print:break-inside-avoid">
                    <Td className="font-semibold">{s.name}</Td>
                    <Td className="text-fg-2">{s.purpose}</Td>
                    <Td className="text-fg-2">{s.data}</Td>
                    {payload.subProcessors.some((p) => p.region) ? (
                      <Td className={s.region === "Not confirmed yet" ? "text-fg-4" : undefined}>{s.region ?? <Missing />}</Td>
                    ) : null}
                  </Tr>
                ))}
              </TBody>
            </Table>
            {payload.connectedServices ? <Caption>{payload.connectedServices}</Caption> : null}
            {payload.noTracking ? <Caption>{payload.noTracking}</Caption> : null}
          </S>

          <S titles={titles} title="Rights of the people in this data">
            <Facts
              rows={[
                ["Export", payload.rights.export],
                ["Erasure", payload.rights.erasure],
              ]}
            />
            <p className="mt-4 text-[15px] text-fg-3">Export and erasure are available on every plan at no cost. They are not a paid feature.</p>
          </S>

          <S titles={titles} title="Evidence packs and how to check one">
            <Lead>
              An evidence pack is a PDF of this evidence that {publisher} issues for {client}. Each one carries a reference
              in the foot of every page, and its SHA-256 digest is published against that reference. A copy is genuine
              when the digest of the file matches. This is a self attestation by {publisher}, not a third party audit or a
              certification.
            </Lead>
            <EvidencePacks packs={payload.evidencePacks ?? []} client={client} />
          </S>

          <S titles={titles} title="Contact">
            <Facts
              rows={[
                ["Published by", payload.contact?.name ?? publisher],
                [
                  "Questions",
                  payload.contact?.detail ??
                    `${publisher} publishes this page and manages these domains for ${client}. Send questions to your usual contact there.`,
                ],
              ]}
            />
          </S>

          <footer className="mt-16 border-t border-fg pt-6 print:mt-8">
            <p className="max-w-[72ch] text-[13.5px] leading-[1.55] text-fg-4 print:text-[9pt]">
              Every claim on this page is served by the platform at the address you are reading, from the live record. To
              check that a compliance pack issued by {publisher} is genuine and unchanged, compare its published SHA-256
              fingerprint in the{" "}
              <Link href="/verify" className="link text-fg-2">
                public verifier
              </Link>
              .
            </p>
          </footer>
        </div>
      </div>
    </article>
  );
}

/* ── Parts ─────────────────────────────────────────────────────────────── */

function Section({ id, number, title, children }: { id: string; number: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-16 print:mt-8 [&>h2]:break-after-avoid">
      <LegalHeading2 id={id} variant="document" number={number}>
        {title}
      </LegalHeading2>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Lead({ children }: { children: ReactNode }) {
  return <p className="mb-6 max-w-[68ch] text-[16px] leading-[1.6] text-fg-2 print:text-[10.5pt]">{children}</p>;
}

function H3({ children }: { children: ReactNode }) {
  return <h3 className="mb-3 mt-10 text-[17px] font-bold tracking-[-0.01em] text-fg first:mt-0 break-after-avoid print:text-[11.5pt]">{children}</h3>;
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="mt-3 max-w-[72ch] text-[13.5px] leading-[1.55] text-fg-4 print:text-[9pt]">{children}</p>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[15px] text-fg-3">{children}</p>;
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="border-t border-rule">
      {rows.map(([k, v]) => (
        <div key={k} className="grid gap-1 border-b border-rule py-3.5 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-8 print:break-inside-avoid">
          <dt className="text-[15px] font-bold text-fg print:text-[10pt]">{k}</dt>
          <dd className="max-w-[68ch] text-[16px] leading-[1.6] text-fg-2 print:text-[10.5pt]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Reporting({ value }: { value: DomainEvidence["coverage"]["reporting"] }) {
  if (value === "this-service") return <State state="pass">To monitoring</State>;
  if (value === "elsewhere") return <State state="warn">Elsewhere only</State>;
  if (value === "none") return <State state="fail">Not requested</State>;
  return <State state="unchecked">Not known</State>;
}

function DomainRecords({ domain: d }: { domain: DomainEvidence }) {
  const p = d.posture;
  const reading = (r: CheckReading, extra?: ReactNode) => (
    <>
      <State state={r.state}>{r.word}</State>
      {r.detail ? <span className="ml-2 text-fg-2">{r.detail}</span> : null}
      {extra}
    </>
  );
  const record = (value: string | null) =>
    value ? <code className="data mt-1.5 block break-all text-[13.5px] leading-[1.55] text-fg">{value}</code> : null;
  return (
    <div className="print:break-inside-avoid">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-fg pb-2">
        <span className="data text-[15px] font-semibold text-fg [overflow-wrap:anywhere]">{d.name}</span>
        <span className="text-meta text-fg-4">{p.checkedAt ? `Checked ${instant(p.checkedAt)}` : "No completed check is held yet"}</span>
      </p>
      <dl className="text-[14.5px] leading-[1.55]">
        {(
          [
            ["DMARC", reading(p.dmarc, record(p.dmarc.record))],
            ["SPF", reading(p.spf, record(p.spf.record))],
            ["DKIM", reading(p.dkim)],
            ["MTA-STS", reading(p.mtaSts)],
            ["TLS-RPT", reading(p.tlsRpt, record(p.tlsRpt.record))],
            ["BIMI", reading(p.bimi)],
          ] as Array<[string, ReactNode]>
        ).map(([k, v]) => (
          <div key={k} className="grid gap-1 border-b border-rule py-2.5 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-6">
            <dt className="font-semibold text-fg">{k}</dt>
            <dd className="min-w-0">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Findings({ evidence, publisher, client }: { evidence: ClientEvidence; publisher: string; client: string }) {
  const f = evidence.findings;
  const none = f.alertCount === 0 && f.changeCount === 0 && f.checks.length === 0 && f.proposals.length === 0;
  return (
    <>
      <Lead>
        Everything on record as unresolved when this page was generated. An acknowledged alert has been taken on by{" "}
        {publisher}; an open one has not been acknowledged yet. A proposed policy change waits for {client}&rsquo;s
        approval before it is made.
      </Lead>
      {none ? (
        <p className="flex items-center gap-2.5 text-[16px] text-fg-2">
          <State state="pass" size="ui">
            Nothing open
          </State>
          <span>No unresolved alert, no unacknowledged DNS change, no error or warning from the newest checks.</span>
        </p>
      ) : (
        <>
          <H3>Alerts not yet resolved</H3>
          {f.alerts.length === 0 ? (
            <Empty>No alert is unresolved.</Empty>
          ) : (
            <Table caption="Alerts not yet resolved" dense minWidth={560} className="print:min-w-0!">
              <THead>
                <tr>
                  <Th>Opened</Th>
                  <Th>Domain</Th>
                  <Th>Finding</Th>
                  <Th>Status</Th>
                </tr>
              </THead>
              <TBody>
                {f.alerts.map((a, i) => (
                  <Tr key={`${a.domain}-${a.openedAt}-${i}`} className="print:break-inside-avoid">
                    <Td muted className="whitespace-nowrap">
                      {shortDate(a.openedAt)}
                    </Td>
                    <Td mono className="[overflow-wrap:anywhere]">
                      {a.domain}
                    </Td>
                    <Td className="text-fg-2">{a.summary}</Td>
                    <Td>{a.acknowledged ? <State state="warn">Acknowledged</State> : <State state="fail">Open</State>}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
          {f.alertCount > f.alerts.length ? (
            <Caption>{plural(f.alertCount - f.alerts.length, "older alert is", "older alerts are")} unresolved and not listed.</Caption>
          ) : null}

          <H3>DNS changes not yet acknowledged</H3>
          {f.changes.length === 0 ? (
            <Empty>No warning or critical change in the last {evidence.windowDays} days is waiting to be acknowledged.</Empty>
          ) : (
            <Table caption="DNS changes not yet acknowledged" dense minWidth={560} className="print:min-w-0!">
              <THead>
                <tr>
                  <Th>Detected</Th>
                  <Th>Domain</Th>
                  <Th>Change</Th>
                  <Th>Severity</Th>
                </tr>
              </THead>
              <TBody>
                {f.changes.map((c, i) => (
                  <Tr key={`${c.domain}-${c.detectedAt}-${i}`} className="print:break-inside-avoid">
                    <Td muted className="whitespace-nowrap">
                      {shortDate(c.detectedAt)}
                    </Td>
                    <Td mono className="[overflow-wrap:anywhere]">
                      {c.domain}
                    </Td>
                    <Td className="text-fg-2">{c.summary}</Td>
                    <Td>{c.severity === "critical" ? <State state="fail">Critical</State> : <State state="warn">Warning</State>}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}

          <H3>Raised by the newest DNS checks</H3>
          {f.checks.length === 0 ? (
            <Empty>The newest checks raised no error or warning.</Empty>
          ) : (
            <Table caption="Findings from the newest DNS checks" dense minWidth={520} className="print:min-w-0!">
              <THead>
                <tr>
                  <Th>Domain</Th>
                  <Th>Severity</Th>
                  <Th>Finding</Th>
                </tr>
              </THead>
              <TBody>
                {f.checks.map((c, i) => (
                  <Tr key={`${c.domain}-${i}`} className="print:break-inside-avoid">
                    <Td mono className="[overflow-wrap:anywhere]">
                      {c.domain}
                    </Td>
                    <Td>{c.severity === "error" ? <State state="fail">Error</State> : <State state="warn">Warning</State>}</Td>
                    <Td className="text-fg-2">{c.title}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </>
      )}

      <H3>Policy changes awaiting approval</H3>
      {f.proposals.length === 0 ? (
        <Empty>No policy change is waiting for {client}.</Empty>
      ) : (
        <Table caption="Policy changes awaiting approval" dense minWidth={520} className="print:min-w-0!">
          <THead>
            <tr>
              <Th>Proposed</Th>
              <Th>Domain</Th>
              <Th>Change</Th>
              <Th>Open until</Th>
            </tr>
          </THead>
          <TBody>
            {f.proposals.map((p, i) => (
              <Tr key={`${p.domain}-${i}`} className="print:break-inside-avoid">
                <Td muted className="whitespace-nowrap">
                  {shortDate(p.proposedAt)}
                </Td>
                <Td mono className="[overflow-wrap:anywhere]">
                  {p.domain}
                </Td>
                <Td>
                  From <span className="data">{p.from}</span> to <span className="data">{p.to}</span>
                </Td>
                <Td muted className="whitespace-nowrap">
                  {shortDate(p.expiresAt)}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </>
  );
}

function EvidencePacks({ packs, client }: { packs: NonNullable<Payload["evidencePacks"]>; client: string }) {
  if (packs.length === 0) {
    return <Empty>No evidence pack has been issued for {client} yet.</Empty>;
  }
  return (
    <ol className="flex flex-col gap-8">
      {packs.map((p) => (
        <li key={p.reference} className="print:break-inside-avoid">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-fg pb-2">
            <span className="data min-w-0 break-all text-[14.5px] font-semibold text-fg">{p.reference}</span>
            {p.superseded ? (
              <StateWord shape="half" tone="void" size="meta">
                Superseded by a newer pack
              </StateWord>
            ) : (
              <StateWord shape="square" tone="ok" size="meta">
                Current
              </StateWord>
            )}
          </div>
          <dl className="text-[14.5px] leading-[1.55]">
            {(
              [
                [
                  "SHA-256",
                  <span key="d" className="text-[14px] text-fg">
                    <Digest value={p.sha256} />
                  </span>,
                ],
                ["Issued", date(p.issuedAt)],
                ["Evidence as of", date(p.dataAsOf)],
                ["Version and pages", `Version ${p.documentVersion}, ${plural(p.pageCount, "page")}`],
              ] as Array<[string, ReactNode]>
            ).map(([k, v]) => (
              <div key={k} className="grid gap-1 border-b border-rule py-2.5 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-6">
                <dt className="font-semibold text-fg">{k}</dt>
                <dd className="min-w-0 text-fg-2">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[14.5px] print:hidden">
            <Link href={`/verify?reference=${encodeURIComponent(p.reference)}`} className="link font-semibold">
              Check a copy of this pack
            </Link>
          </p>
        </li>
      ))}
    </ol>
  );
}
