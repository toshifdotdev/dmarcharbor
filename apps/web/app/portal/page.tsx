import type { Metadata } from "next";
import Link from "next/link";
import { getSessionUser } from "@/lib/api";
import { getPortalDomain, getPortalMonthlyReports, getPortalOverview, PortalError } from "@/lib/api-portal";
import { dayLabel, verdictFor, type Verdict } from "@/lib/portal-verdict";
import { portalDomainHref, portalHref } from "@/lib/route-hrefs";
import { signInRedirect } from "@/lib/session";
import type { PortalDomainDetail, PortalOverview } from "@/lib/types";
import { PortalFrame, PortalNotice, PortalPaused } from "@/components/harbor/portal-frame";
import { Badge } from "@/components/ui/badge";
import { ArrowRight } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Your domains", robots: { index: false, follow: false } };

/**
 * /portal — the agency's client, reading how their email is doing.
 *
 * The first screen answers the three questions in this order: is anything
 * wrong (the summary line and the domains that need attention, first), is my
 * mail protected (one verdict per domain), and what do I do (the next step,
 * on the domain itself). Each domain's page carries the evidence and the ways
 * to forward it.
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
          <ul className="mt-4 flex flex-col border-y border-rule" data-testid="portal-choose">
            {e.workspaces.map((w) => (
              <li key={w.organizationId} className="border-b border-rule last:border-b-0">
                <Link href={portalHref(w.organizationId)} className="group flex items-center gap-4 py-3 hover:bg-paper-2/70">
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-semibold text-fg group-hover:text-act">{w.name}</span>
                    {w.clients.length > 0 ? <span className="block text-meta text-fg-3">{w.clients.join(", ")}</span> : null}
                  </span>
                  <ArrowRight size={14} className="text-fg-4 group-hover:text-act" />
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
  const [details, monthlyByClient] = await Promise.all([
    Promise.all(domains.map((d) => getPortalDomain(d.id, org).catch(() => null as PortalDomainDetail | null))),
    Promise.all(
      overview.clients.map(async (client) => ({
        client,
        reports: await getPortalMonthlyReports(client.id, org)
          .then((result) => result.reports)
          .catch(() => null),
      })),
    ),
  ]);
  const rows = domains
    .map((d, i) => ({ d, detail: details[i], verdict: verdictFor(details[i], agency, now) }))
    .sort((a, b) => a.verdict.rank - b.verdict.rank || a.d.name.localeCompare(b.d.name));

  const attention = rows.filter((r) => r.verdict.kind === "attention");
  const silent = rows.filter((r) => r.verdict.kind === "silent");
  const clientNames = [...new Set(overview.clients.map((c) => c.name))];

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
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-2">
          <p className="legend">{clientNames.length ? clientNames.join(", ") : "Client reports"}</p>
          <h1 className="display text-[30px] leading-[1.05] text-fg sm:text-[38px]">Your domains</h1>
          <p className="max-w-[68ch] text-lead text-fg-2" data-testid="portal-summary">
            {summary}
          </p>
          {overview.lastReportAt ? (
            <p className="text-meta text-fg-3">
              Most recent report received {dayLabel(overview.lastReportAt)}. Updated as reports arrive, usually once a day.
            </p>
          ) : null}
        </header>

        {rows.length > 0 ? (
          <ol className="hb-stagger flex flex-col border-y border-fg">
            {rows.map(({ d, verdict }, i) => (
              <DomainRow key={d.id} index={i} href={portalDomainHref(d.slug || d.id, org)} name={d.name} clientName={clientNames.length > 1 ? d.clientName : null} verdict={verdict} />
            ))}
          </ol>
        ) : null}

        <section
          aria-labelledby="monthly-head"
          className="flex flex-col gap-3 border-t border-rule pt-6"
          data-testid="portal-monthly-reports"
        >
          <div>
            <h2 id="monthly-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
              Monthly reports
            </h2>
            <p className="mt-1 max-w-[70ch] text-ui text-fg-2">
              A report for each complete month, covering every domain. Download a copy or check its fingerprint with the
              reference printed on it.
            </p>
          </div>
          {monthlyByClient.length === 0 ? null : monthlyByClient.every((entry) => entry.reports === null) ? (
            <p className="text-ui text-fg-3">The monthly reports could not be read just now. This is not the same as there being none.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {monthlyByClient.map(({ client, reports }) => (
                <div key={client.id} className="flex flex-col gap-2">
                  {monthlyByClient.length > 1 ? (
                    <p className="text-ui font-semibold text-fg">{client.name}</p>
                  ) : null}
                  {reports === null ? (
                    <p className="text-meta text-fg-3">This client&rsquo;s monthly reports could not be read.</p>
                  ) : reports.length === 0 ? (
                    <p className="text-meta text-fg-3">No monthly report has been issued yet.</p>
                  ) : (
                    <ul className="flex flex-col border-y border-rule">
                      {reports.map((report) => (
                        <li key={report.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-rule py-2.5 last:border-b-0">
                          <span>
                            <span className="block text-ui font-semibold text-fg">{portalMonthLabel(report.period)}</span>
                            <span className="data block break-all text-meta text-fg-3">{report.reference}</span>
                          </span>
                          {report.downloadable ? (
                            <a
                              href={`/api/portal/clients/${client.id}/monthly-reports/${report.id}/download`}
                              className="link text-ui font-semibold"
                            >
                              Download
                            </a>
                          ) : (
                            <span className="text-meta text-fg-3">No longer held</span>
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

        <section aria-labelledby="how-head" className="grid gap-x-10 gap-y-4 border-t border-rule pt-6 md:grid-cols-3">
          <h2 id="how-head" className="sr-only">
            How to read this
          </h2>
          {[
            ["What the checks are", "When your company sends an email, the receiving mail server checks that it really came from you. A fake fails."],
            ["Where the figures come from", "Mail servers that receive email in your name send a daily report of what they observed. This page summarises those reports."],
            ["What you need to do", `Only what a domain's next step says. ${agency} looks after the settings.`],
          ].map(([k, v]) => (
            <div key={k}>
              <p className="text-ui font-semibold text-fg">{k}</p>
              <p className="mt-1 text-ui text-fg-2">{v}</p>
            </div>
          ))}
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

const TONE_BAR: Record<Verdict["tone"], string> = {
  fail: "shadow-[inset_3px_0_0_var(--color-fail)]",
  warn: "shadow-[inset_3px_0_0_var(--color-warn-mark)]",
  ok: "shadow-[inset_3px_0_0_var(--color-ok)]",
  neutral: "shadow-[inset_3px_0_0_var(--color-rule-2)]",
};

function DomainRow({
  href,
  name,
  clientName,
  verdict,
  index,
}: {
  href: string;
  name: string;
  clientName: string | null;
  verdict: Verdict;
  index: number;
}) {
  return (
    <li
      data-verdict={verdict.kind}
      style={{ "--i": Math.min(index, 10) } as React.CSSProperties}
      className={`border-b border-rule last:border-b-0 ${TONE_BAR[verdict.tone]}`}
    >
      <Link
        href={href}
        className="group grid gap-x-8 gap-y-2 py-4 pl-5 pr-2 hover:bg-paper-2/70 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto]"
      >
        <div className="min-w-0">
          <p className="data break-all text-body font-semibold text-fg group-hover:text-act">{name}</p>
          {clientName ? <p className="mt-0.5 text-meta text-fg-3">{clientName}</p> : null}
        </div>
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-2">
            <Badge tone={verdict.tone === "neutral" ? "neutral" : verdict.tone} boxed>
              {verdict.title}
            </Badge>
          </p>
          <p className="mt-1.5 max-w-[72ch] text-ui text-fg-2">{verdict.meaning}</p>
          {verdict.kind === "attention" || verdict.kind === "silent" ? (
            <p className="mt-1.5 max-w-[72ch] text-ui font-semibold text-fg">{verdict.next}</p>
          ) : null}
        </div>
        <span className="flex items-center gap-1 self-center text-meta font-semibold text-act">
          See the evidence <ArrowRight size={13} />
        </span>
      </Link>
    </li>
  );
}
