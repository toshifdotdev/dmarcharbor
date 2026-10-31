import type { Metadata } from "next";
import Link from "next/link";
import { getSessionUser } from "@/lib/api";
import { getPortalDomain, getPortalMonthlyReports, getPortalOverview, getPortalProposals, PortalError } from "@/lib/api-portal";
import { dayLabel, policyPlain, verdictFor, type Verdict } from "@/lib/portal-verdict";
import { portalDomainHref, portalHref } from "@/lib/route-hrefs";
import { signInRedirect } from "@/lib/session";
import type { PortalDomainDetail, PortalOverview, PortalPolicyProposal } from "@/lib/types";
import { PortalFrame, PortalNotice, PortalPaused } from "@/components/harbor/portal-frame";
import { PolicyScale, PolicyStrip, policyStage, recordStage, type Stage } from "@/components/harbor/document-route";
import { VerdictWord } from "@/components/harbor/portal-verdict-word";
import { buttonClass } from "@/components/ui/button";
import { ArrowRight } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Your domains", robots: { index: false, follow: false } };

/**
 * /portal — the agency's client, reading how their email is doing.
 *
 * The first screen answers the three questions in this order: is anything
 * wrong (the summary line, any approval the agency is waiting on, and the
 * domains that need attention, first), is my mail protected (one verdict per
 * domain, beside a strip map of where it stands between monitoring and
 * blocking), and what do I do (the next step, on the domain itself). Each
 * domain's page carries the evidence and the ways to forward it.
 *
 * Verdicts need each domain's measurement, which only the domain read returns,
 * so the domains are read in parallel here. One that fails says so on its own
 * row; it never takes the page down and never reads as "fine".
 *
 * Access is the API's: a grant on the signed-in email address decides it. A
 * signed-out reader goes to sign-in and comes back here.
 */
export default async function PortalPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  // The provider, for a contact invited by more than one.
  const { org } = await searchParams;
  const [overviewResult, user] = await Promise.all([
    getPortalOverview(org).then(
      (o) => ({ ok: true as const, o }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
    getSessionUser().catch(() => null),
  ]);

  if (!overviewResult.ok) {
    const e = overviewResult.e;
    if (e instanceof PortalError && e.status === 401) await signInRedirect();
    if (e instanceof PortalError && e.code === "PORTAL_PAUSED") {
      return <PortalPaused email={user?.email ?? null} provider={e.workspaceName} />;
    }
    if (e instanceof PortalError && e.status === 403) {
      return (
        <PortalNotice brand={null} email={user?.email ?? null} title="There is no report for this account yet">
          <p>
            You are signed in as <span className="data text-fg">{user?.email ?? "this account"}</span>, and no report has
            been shared with that address. Reports are shared by the company that manages your email security: ask them to
            invite this exact address.
          </p>
        </PortalNotice>
      );
    }
    if (e instanceof PortalError && e.code === "CHOOSE_WORKSPACE" && e.workspaces.length > 0) {
      return (
        <PortalNotice brand={null} email={user?.email ?? null} title="Which provider's report do you want to open?">
          <p>Your address has been invited by more than one company. Each keeps its own report; open one at a time.</p>
          <ul className="mt-6 flex flex-col border-y border-rule" data-testid="portal-choose">
            {e.workspaces.map((w) => (
              <li key={w.organizationId} className="border-b border-rule last:border-b-0">
                <Link href={portalHref(w.organizationId)} className="group flex items-center gap-4 py-4">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[17px] font-bold text-fg">{w.name}</span>
                    {w.clients.length > 0 ? <span className="mt-0.5 block text-[14px] text-fg-4">{w.clients.join(", ")}</span> : null}
                  </span>
                  <ArrowRight size={15} className="text-fg-4 transition-colors duration-150 group-hover:text-fg" />
                </Link>
              </li>
            ))}
          </ul>
        </PortalNotice>
      );
    }
    if (e instanceof PortalError && e.status === 400) {
      return (
        <PortalNotice brand={null} email={user?.email ?? null} title="This account has reports from more than one provider">
          <p>
            Your address has been invited by more than one company, and this page can show one at a time. Ask your provider
            for the direct link to their report.
          </p>
        </PortalNotice>
      );
    }
    if (e instanceof PortalError) {
      return (
        <PortalNotice brand={null} email={user?.email ?? null} title="Your report is unavailable just now">
          <p>This is a problem reaching the report, not a problem with your email. Please try again in a few minutes.</p>
        </PortalNotice>
      );
    }
    throw e;
  }

  const overview: PortalOverview = overviewResult.o;
  const agency = overview.branding?.workspaceName ?? overview.workspace.name;
  const now = Date.now();

  const domains = overview.clients.flatMap((c) => c.domains.map((d) => ({ ...d, clientName: c.name })));
  const [details, monthlyByClient, proposals] = await Promise.all([
    Promise.all(domains.map((d) => getPortalDomain(d.id, org).catch(() => null as PortalDomainDetail | null))),
    Promise.all(
      overview.clients.map(async (client) => ({
        client,
        reports: await getPortalMonthlyReports(client.id, org)
          .then((result) => result.reports)
          .catch(() => null),
      })),
    ),
    getPortalProposals(org).then(
      (result) => result.proposals,
      () => [] as PortalPolicyProposal[],
    ),
  ]);
  const rows = domains
    .map((d, i) => ({ d, detail: details[i], verdict: verdictFor(details[i], agency, now) }))
    .sort((a, b) => a.verdict.rank - b.verdict.rank || a.d.name.localeCompare(b.d.name));

  const attention = rows.filter((r) => r.verdict.kind === "attention");
  const silent = rows.filter((r) => r.verdict.kind === "silent");
  const clientNames = [...new Set(overview.clients.map((c) => c.name))];
  // An open approval is a step asked for and not taken: drawn dashed on that domain's strip.
  const askedFor = new Map<string, Stage>();
  for (const p of proposals) if (p.state === "pending") askedFor.set(p.domain.id, recordStage(p.recordValue));

  const summary =
    rows.length === 0
      ? `No domains are ready to show yet. They appear here once ${agency} has finished setting them up.`
      : attention.length > 0
        ? attention.length === rows.length
          ? `${rows.length === 1 ? "Your domain needs" : `All ${rows.length} of your domains need`} attention. Open ${rows.length === 1 ? "it" : "each one"} to see what was observed and what to do.`
          : `${attention.length} of ${rows.length} domains need${attention.length === 1 ? "s" : ""} attention. The rest are listed below with what was observed.`
        : silent.length > 0
          ? `Nothing is failing, but reports have stopped for ${silent.length} domain${silent.length === 1 ? "" : "s"}, so ${silent.length === 1 ? "it" : "they"} cannot be confirmed right now.`
          : rows.every((r) => r.verdict.kind === "waiting")
            ? "Your domains are set up. Reports have not arrived yet, which is normal in the first few days."
            : "Nothing needs attention. Every message mail servers observed being sent as your domains passed the checks.";

  return (
    <PortalFrame brand={overview.branding} email={user?.email ?? null} home={portalHref(org)}>
      <div className="flex flex-col gap-14 sm:gap-16">
        <header className="flex max-w-[48rem] flex-col">
          <p className="text-[15px] leading-[1.4] text-fg-4">
            {clientNames.length ? (
              <>
                For{" "}
                {clientNames.map((name, i) => (
                  <span key={name}>
                    {i > 0 ? (i === clientNames.length - 1 ? " and " : ", ") : null}
                    <span className="font-bold text-fg">{name}</span>
                  </span>
                ))}
              </>
            ) : (
              "Client reports"
            )}
          </p>
          <h1 className="mt-4 text-[40px] font-[760] leading-[0.98] tracking-[-0.035em] text-fg sm:text-[56px] min-[1100px]:text-[64px]">
            Your domains
          </h1>
          <p className="mt-6 max-w-[38rem] text-[17px] leading-[1.5] text-fg-2 sm:text-[19px]" data-testid="portal-summary">
            {summary}
          </p>
          {overview.lastReportAt ? (
            <p className="mt-3 text-[14px] text-fg-4">
              Most recent report received {dayLabel(overview.lastReportAt)}. Updated as reports arrive, usually once a day.
            </p>
          ) : null}
        </header>

        {proposals.length > 0 ? (
          <section
            aria-labelledby="approvals-head"
            className="flex max-w-[56rem] flex-col gap-4 rounded-sheet border border-rule-2 px-5 py-5 sm:px-7 sm:py-6"
            data-testid="portal-approvals"
          >
            <h2 id="approvals-head" className="text-[20px] font-[740] leading-[1.2] tracking-[-0.02em] text-fg sm:text-[22px]">
              {proposals.length === 1 ? `${agency} asks your approval` : `${agency} asks your approval on ${proposals.length} changes`}
            </h2>
            <ul className="flex flex-col border-t border-rule">
              {proposals.map((proposal) => (
                <li key={proposal.id} className="border-b border-rule last:border-b-0">
                  <Link
                    href={portalDomainHref(proposal.domain.id, org)}
                    className="group grid gap-x-6 gap-y-1 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  >
                    <span className="min-w-0">
                      <span className="block text-[16px] font-semibold text-fg underline decoration-rule-2 decoration-1 underline-offset-[3px] group-hover:decoration-current">
                        {proposal.words.headline}
                      </span>
                      <span className="mt-0.5 block text-[14px] text-fg-4">
                        <span className="text-fg-2">{proposal.domain.name}</span> · open until {dayLabel(proposal.expiresAt)}
                      </span>
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-act">
                      Review and answer <ArrowRight size={14} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {rows.length > 0 ? (
          <section aria-labelledby="domains-head">
            <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1 border-b border-rule pb-3">
              <h2 id="domains-head" className="text-[16px] font-bold text-fg">
                {rows.length} domain{rows.length === 1 ? "" : "s"}
              </h2>
              <span className="text-[14px] text-fg-4">What needs you first</span>
            </div>
            {/* The strip's three stations, named once over its column. */}
            <div aria-hidden className={`${ROW_GRID} hidden pb-1 pt-4 min-[1100px]:grid`}>
              <span />
              <span />
              <PolicyScale />
              <span />
            </div>
            <ol className="flex flex-col">
              {rows.map(({ d, detail, verdict }) => (
                <DomainRow
                  key={d.id}
                  href={portalDomainHref(d.slug || d.id, org)}
                  name={d.name}
                  clientName={clientNames.length > 1 ? d.clientName : null}
                  verdict={verdict}
                  policy={detail?.domain.dmarcPolicy ?? d.dmarcPolicy}
                  asked={askedFor.get(d.id) ?? null}
                />
              ))}
            </ol>
          </section>
        ) : null}

        {/* The board above already closes on a hairline; one rule between sections. */}
        <section
          aria-labelledby="monthly-head"
          className={`flex flex-col gap-5 ${rows.length > 0 ? "pt-2" : "border-t border-rule pt-10"}`}
          data-testid="portal-monthly-reports"
        >
          <div className="max-w-[44rem]">
            <h2 id="monthly-head" className="text-[22px] font-[740] leading-[1.15] tracking-[-0.02em] text-fg sm:text-[24px]">
              Monthly reports
            </h2>
            <p className="mt-2 text-[15.5px] leading-[1.55] text-fg-2">
              A report for each complete month, covering every domain. Download a copy or check its fingerprint with the
              reference printed on it.
            </p>
          </div>
          {monthlyByClient.length === 0 ? null : monthlyByClient.every((entry) => entry.reports === null) ? (
            <p className="text-[15px] text-fg-3">The monthly reports could not be read just now. This is not the same as there being none.</p>
          ) : (
            <div className="flex max-w-[56rem] flex-col gap-6">
              {monthlyByClient.map(({ client, reports }) => (
                <div key={client.id} className="flex flex-col gap-2">
                  {monthlyByClient.length > 1 ? <p className="text-[15px] font-bold text-fg">{client.name}</p> : null}
                  {reports === null ? (
                    <p className="text-[14px] text-fg-3">This client&rsquo;s monthly reports could not be read.</p>
                  ) : reports.length === 0 ? (
                    <p className="text-[14px] text-fg-4">No monthly report has been issued yet.</p>
                  ) : (
                    <ul className="flex flex-col border-y border-rule">
                      {reports.map((report) => (
                        <li key={report.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-rule py-3 last:border-b-0">
                          <span className="min-w-0">
                            <span className="block text-[15px] font-semibold text-fg">{portalMonthLabel(report.period)}</span>
                            <span className="data block break-all text-[12.5px] text-fg-4">{report.reference}</span>
                          </span>
                          {report.downloadable ? (
                            <a
                              href={`/api/portal/clients/${client.id}/monthly-reports/${report.id}/download`}
                              className={buttonClass("secondary", "sm")}
                            >
                              Download
                            </a>
                          ) : (
                            <span className="text-[13.5px] text-fg-4">No longer held</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="how-head" className="border-t border-rule pt-10">
          <h2 id="how-head" className="text-[22px] font-[740] leading-[1.15] tracking-[-0.02em] text-fg sm:text-[24px]">
            How to read this
          </h2>
          <dl className="mt-6 grid gap-x-12 gap-y-6 md:grid-cols-3">
            {[
              ["What the checks are", "When your company sends an email, the receiving mail server checks that it really came from you. A fake fails."],
              ["Where the figures come from", "Mail servers that receive email in your name send a daily report of what they observed. This page summarises those reports."],
              ["What you need to do", `Only what a domain's next step says. ${agency} looks after the settings.`],
            ].map(([k, v]) => (
              <div key={k} className="max-w-[34ch]">
                <dt className="text-[15.5px] font-bold text-fg">{k}</dt>
                <dd className="mt-1.5 text-[15px] leading-[1.55] text-fg-2">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </PortalFrame>
  );
}

const PORTAL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function portalMonthLabel(period: string | null): string {
  if (!period) return "Month not recorded";
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${PORTAL_MONTHS[month - 1]} ${match[1]}` : period;
}

/** Domain, verdict, strip, link: the board's columns from 1100px. */
const ROW_GRID = "grid gap-x-10 min-[1100px]:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_13rem_9rem]";

function DomainRow({
  href,
  name,
  clientName,
  verdict,
  policy,
  asked,
}: {
  href: string;
  name: string;
  clientName: string | null;
  verdict: Verdict;
  policy: string | null;
  asked: Stage;
}) {
  const stage = policyStage(policy);
  const plain = policyPlain(policy);
  return (
    <li data-verdict={verdict.kind} className="border-b border-rule">
      <Link href={href} className={`group ${ROW_GRID} gap-y-3 py-5 min-[1100px]:items-start`}>
        <div className="min-w-0">
          <p className="text-[17px] font-bold leading-[1.3] tracking-[-0.01em] text-fg [overflow-wrap:anywhere]">{name}</p>
          {clientName ? <p className="mt-0.5 text-[14px] text-fg-4">{clientName}</p> : null}
        </div>
        <div className="min-w-0">
          <VerdictWord verdict={verdict} />
          <p className="mt-1.5 max-w-[64ch] text-[15px] leading-[1.55] text-fg-2">{verdict.meaning}</p>
          {verdict.kind === "attention" || verdict.kind === "silent" ? (
            <p className="mt-1.5 max-w-[64ch] text-[15px] font-semibold leading-[1.55] text-fg">{verdict.next}</p>
          ) : null}
        </div>
        <div className="min-w-0 max-w-[16rem] min-[1100px]:pt-0.5">
          <PolicyStrip at={stage} to={asked} />
          <p className="mt-1 text-[13.5px] text-fg-4">
            <span className="sr-only">Domain setting: </span>
            {plain.name}
            {asked !== null ? <span className="text-fg-2">, approval asked</span> : null}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 self-start text-[14px] font-semibold text-act min-[1100px]:justify-self-end">
          See the evidence <ArrowRight size={14} className="transition-transform duration-150 group-hover:translate-x-0.5" />
        </span>
      </Link>
    </li>
  );
}
