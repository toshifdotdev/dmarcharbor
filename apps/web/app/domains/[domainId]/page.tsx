import Link from "next/link";
import { notFound, redirect, unstable_rethrow } from "next/navigation";
import {
  ApiError,
  deriveSignals,
  getDomainInsights,
  getOnboardingState,
  listClients,
  listDomainReports,
} from "@/lib/api";
import { getDomainSwitch, listDomainScans } from "@/lib/api-ops";
import { instantLabel } from "@/lib/instant";
import { daysSinceReport, fmtVolume, policyLabel, POSTURE_META, resolvePosture } from "@/lib/posture";
import { onboardingHref } from "@/lib/route-hrefs";
import { resolveActiveWorkspace } from "@/lib/session";
import type { DomainInsights, DomainSwitchView, OnboardingState, ReportRow, ScanRow, SenderRow, SourceAttribution } from "@/lib/types";
import { AppShell } from "@/components/harbor/app-shell";
import { DomainSwitchPanel } from "@/components/harbor/domain-switch";
import { PageHeader, SectionHead } from "@/components/harbor/page-header";
import { RefreshButton } from "@/components/harbor/refresh-button";
import { ScanHistory, type ScanHistoryRow } from "@/components/harbor/scan-history";
import { VolumeChart } from "@/components/harbor/volume-chart";
import { Badge, PostureBadge, type Tone } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Readout, ReadoutStrip } from "@/components/ui/readout";
import { ErrorState } from "@/components/ui/states";
import { Nil, Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";

/**
 * Domain detail: the evidence for one domain.
 *
 * Read top to bottom it answers, in order: what posture is this domain in and
 * why (header), how much was measured (readouts), how the volume moved and
 * whether the feed is still alive (chart), who is sending (senders, sources),
 * what the receivers actually said (reports), and what DNS says right now
 * (scans). Policy readiness sits beside the tables at wide sizes because it is
 * the decision the evidence feeds.
 *
 * Every figure is the API's. "Failed" is the API's own count: messages where
 * SPF or DKIM did not pass. That is stricter than DMARC's pass rule (one aligned
 * pass is enough), and the page says so where the figure appears.
 */
export default async function DomainPage({ params }: { params: Promise<{ domainId: string }> }) {
  const { domainId } = await params;
  const { workspaces, active } = await resolveActiveWorkspace();
  // No workspace is an onboarding step, never a 404.
  if (!active) redirect("/welcome");

  let insights: DomainInsights | undefined;
  let onboarding: OnboardingState | undefined;
  let reports: ReportRow[] = [];
  let clientName = "";
  let slug = domainId;
  // The URL carries a slug; the API calls below use the domain's id. Some API
  // reads resolve a slug for the domain but not for its child queries (senders
  // and reports came back empty by slug while full by id), so the id read from
  // the client list is the reliable key.
  let id = domainId;
  let failed = false;

  try {
    const clients = await listClients(active.id);
    for (const c of clients) {
      const hit = c.domains.find((d) => d.id === domainId || d.slug === domainId);
      if (hit) {
        clientName = c.name;
        slug = hit.slug;
        id = hit.id;
        break;
      }
    }
    if (!clientName) notFound();

    [insights, onboarding, reports] = await Promise.all([
      getDomainInsights(active.id, id),
      getOnboardingState(active.id, id),
      listDomainReports(active.id, id, 20).then((p) => p.items),
    ]);
  } catch (err) {
    // notFound() above throws a framework signal; it must reach Next, not
    // become "could not load".
    unstable_rethrow(err);
    if (err instanceof ApiError && err.status === 404) notFound();
    failed = true;
  }

  if (failed || !insights || !onboarding) {
    return (
      <AppShell
        workspaces={workspaces}
        activeWorkspace={active}
        trail={[{ label: "Portfolio", href: "/" }, { label: clientName || "Domain" }]}
      >
        <div className="flex flex-col gap-6">
          <PageHeader
            title="Domain evidence"
          />
          <ErrorState what="this domain's evidence" detail="Nothing about the domain was changed; its reports are still on record." />
        </div>
      </AppShell>
    );
  }

  const signals = deriveSignals(insights, insights.domain.name, reports[0]?.policyP ?? null);
  const resolved = resolvePosture(signals);
  const meta = POSTURE_META[resolved.posture];
  const agg = insights.aggregate;
  const now = Date.now();
  const lastReportAt = agg.lastReportAt;
  const ageDays = daysSinceReport(lastReportAt, now);
  const observedPolicy = policyLabel(insights.reporting.publishedPolicy, signals.reportedPolicy);
  const policySource = insights.reporting.publishedPolicy ? "from DNS scan" : signals.reportedPolicy ? "as reporters saw it" : null;
  const failShare = agg.messageCount > 0 ? agg.failedMessages / agg.messageCount : null;

  // A scan history is a different claim from the report evidence, so it fails
  // on its own and renders as a failure, never as an empty history.
  const [scanHistory, switchState] = await Promise.all([
    listDomainScans(active.id, id).then(
      (rows: ScanRow[]) => ({ rows, failed: false }),
      () => ({ rows: [] as ScanRow[], failed: true }),
    ),
    getDomainSwitch(active.id, id).then(
      (data: DomainSwitchView) => ({ data, failed: false }),
      () => ({ data: null as DomainSwitchView | null, failed: true }),
    ),
  ]);

  const today = new Date(now).toISOString().slice(0, 10);

  return (
    <AppShell
      workspaces={workspaces}
      activeWorkspace={active}
      trail={[
        { label: clientName, href: "/clients" },
        { label: insights.domain.name, mono: true },
      ]}
    >
      <div className="flex flex-col gap-7">
        <PageHeader
          title={insights.domain.name}
          titleMono
          status={<PostureBadge posture={resolved.posture} reason={resolved.reason} size="lg" />}
          lede={
            <>
              {meta.meaning} <span className="text-fg-3">{capitalise(resolved.reason)}.</span>
            </>
          }
          meta={
            <>
              <MetaItem k="Client">{clientName}</MetaItem>
              <MetaItem k="Ownership">
                <Ownership status={insights.domain.status} />
              </MetaItem>
              <MetaItem k="Policy">
                {observedPolicy === "not observed" ? (
                  <span className="text-fg-3">not observed</span>
                ) : (
                  <>
                    <span className="data font-semibold text-fg">p={observedPolicy}</span>
                    {policySource ? <span className="text-fg-3"> {policySource}</span> : null}
                  </>
                )}
              </MetaItem>
              <MetaItem k="Last report">
                {lastReportAt ? <span className="tnum text-fg-2">{instantLabel(lastReportAt)}</span> : <span className="text-fg-3">never</span>}
              </MetaItem>
            </>
          }
          actions={
            <>
              <RefreshButton />
              <ButtonLink href={onboardingHref(slug)} variant="secondary" size="sm">
                Setup and records
              </ButtonLink>
            </>
          }
        />

        {resolved.posture === "stale" || resolved.posture === "unmeasured" ? (
          <SilenceBand posture={resolved.posture} lastReportAt={lastReportAt} ageDays={ageDays} />
        ) : null}

        <ReadoutStrip>
          <Readout label="Messages observed" value={fmtVolume(agg.messageCount)} note={windowLabel(agg.messageWindow)} />
          <Readout
            label="Failed"
            value={fmtVolume(agg.failedMessages)}
            unit={failShare !== null && agg.failedMessages > 0 ? `${(failShare * 100).toFixed(1)}% of observed` : undefined}
            tone={agg.failedMessages > 0 ? "fail" : undefined}
            note="messages where SPF or DKIM did not pass"
          />
          <Readout label="Reports received" value={fmtVolume(agg.reportCount)} note={`${fmtVolume(agg.recordCount)} records in them`} />
          <Readout label="SPF pass" value={rate(agg.spfPassRate)} note="of observed messages" />
          <Readout label="DKIM pass" value={rate(agg.dkimPassRate)} note="of observed messages" />
          <Readout
            label="Forensic reports"
            value={fmtVolume(insights.forensic.count)}
            note={insights.reporting.forensicConfigured ? `${fmtVolume(insights.forensic.rejectedMessages)} rejected or quarantined` : "no ruf= address published"}
          />
        </ReadoutStrip>

        {/* The chart and the decision it feeds sit side by side; the tables
            below get the full width, because tables are what need it. */}
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_340px] xl:gap-10">
          <section aria-labelledby="volume-head" className="min-w-0">
            <SectionHead id="volume-head" title="Observed volume" aside={`last ${insights.trends.days} days, to today`} />
            <VolumeChart
              points={insights.trends.points}
              spikes={insights.trends.spikes}
              days={insights.trends.days}
              today={today}
              lastReportAt={lastReportAt}
              daysWithoutReport={ageDays}
              domainName={insights.domain.name}
            />
          </section>
          <PolicyPanel onboarding={onboarding} observedPolicy={observedPolicy} />
        </div>

        <DomainSwitchPanel
          organizationId={active.id}
          domainId={id}
          domainName={insights.domain.name}
          state={switchState}
        />

        <div>
          <section aria-label="Evidence tables" className="min-w-0">
            <Tabs
              label="Evidence"
              tabs={[
                {
                  id: "senders",
                  label: "Senders",
                  count: insights.senders.length,
                  panel: <SendersTable senders={insights.senders} domainName={insights.domain.name} />,
                },
                {
                  id: "sources",
                  label: "Sources",
                  count: insights.sources.length,
                  panel: <SourcesTable sources={insights.sources} />,
                },
                {
                  id: "reports",
                  label: "Aggregate reports",
                  count: reports.length,
                  panel: <ReportsTable reports={reports} />,
                },
                {
                  id: "scans",
                  label: "DNS scans",
                  count: scanHistory.failed ? null : scanHistory.rows.length,
                  panel: (
                    <ScanHistory
                      organizationId={active.id}
                      domainId={id}
                      domainName={insights.domain.name}
                      domainStatus={insights.domain.status}
                      scans={buildScanRows(scanHistory.rows)}
                      loadFailed={scanHistory.failed}
                    />
                  ),
                },
                {
                  id: "setup",
                  label: "Reporting and setup",
                  count: null,
                  panel: <SetupPanel onboarding={onboarding} insights={insights} slug={slug} />,
                },
              ]}
            />
          </section>
        </div>
      </div>
    </AppShell>
  );
}

// ─── header pieces ────────────────────────────────────────────────────────────

function MetaItem({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="legend">{k}</span>
      <span>{children}</span>
    </span>
  );
}

function Ownership({ status }: { status: string }) {
  if (status === "VERIFIED") return <span className="font-semibold text-ok">verified</span>;
  if (status === "FAILED") return <span className="font-semibold text-fail">check failed</span>;
  return <span className="font-semibold text-fg-3">pending</span>;
}

/**
 * Silence has two meanings and the band names whichever is true. The two
 * sentences are read by the clickthrough suite; keep their openings.
 */
function SilenceBand({
  posture,
  lastReportAt,
  ageDays,
}: {
  posture: "stale" | "unmeasured";
  lastReportAt: string | null;
  ageDays: number | null;
}) {
  return (
    <div role="status" className="border border-void/35 bg-void-wash/60 px-4 py-3">
      <p className="text-ui">
        <span className="font-bold text-void">{posture === "stale" ? "Stale: no report for more than 5 days. " : "Not measured: never. "}</span>
        <span className="text-fg-2">
          {posture === "stale" && lastReportAt
            ? `No aggregate report has been received for ${ageDays} days (last one ${instantLabel(lastReportAt)}). That says nothing about whether mail is still being sent, only that no receiver has reported it. The figures below are history, not current state.`
            : "No aggregate report has ever been received for this domain. Nothing below can be read as measured: absence is not compliance."}
        </span>
      </p>
    </div>
  );
}

// ─── evidence tables ──────────────────────────────────────────────────────────

const SENDER_STATUS: Record<SenderRow["status"], { tone: Tone; label: string }> = {
  clean: { tone: "ok", label: "Clean" },
  degraded: { tone: "warn", label: "Degraded" },
  failing: { tone: "fail", label: "Failing" },
  "insufficient-data": { tone: "void", label: "Too little data" },
};

function SendersTable({ senders, domainName }: { senders: SenderRow[]; domainName: string }) {
  if (senders.length === 0) {
    return <PanelNote>No sender has been observed yet. Senders appear here as receivers report mail claiming this domain.</PanelNote>;
  }
  const own = domainName.toLowerCase();
  const unattributed = senders.filter((s) => (s.senderDomain ?? "").toLowerCase() !== own).length;
  return (
    <div className="flex flex-col gap-3 pt-4">
      <p className="text-ui text-fg-2">
        <span className="tnum font-semibold text-fg">{senders.length - unattributed}</span> authenticating as {domainName},{" "}
        <span className={unattributed ? "tnum font-semibold text-warn" : "tnum font-semibold text-fg"}>{unattributed}</span> as some other
        domain. A sender authenticating as someone else is seen, not attributed: an open question, never a pass.
      </p>
      <p className="text-meta text-fg-3">
        Every percentage in this table is a share of <em className="not-italic font-semibold text-fg-2">that sender&rsquo;s own messages</em>, not of the domain&rsquo;s total.
      </p>
      <Table caption={`Senders observed for ${domainName}`} minWidth={900}>
        <THead>
          <tr>
            <Th>Sender</Th>
            <Th numeric>Sources</Th>
            <Th numeric>Messages</Th>
            <Th numeric>Failed</Th>
            <Th numeric title="Failed messages as a share of this sender's own messages">Failed share</Th>
            <Th numeric>DKIM pass</Th>
            <Th numeric>SPF pass</Th>
            <Th>Status</Th>
            <Th numeric>Last seen</Th>
          </tr>
        </THead>
        <TBody>
          {senders.map((s) => {
            const isOther = (s.senderDomain ?? "").toLowerCase() !== own;
            return (
              <Tr key={s.senderKey} tone={s.status === "failing" ? "fail" : undefined}>
                <Td>
                  <span className="data block font-semibold text-fg">{s.senderDomain ?? s.sourceIps[0] ?? "unknown"}</span>
                  <span className="mt-0.5 flex flex-wrap gap-x-2 text-meta">
                    {s.senderDomain ? null : <span className="text-fg-3">no authenticating domain</span>}
                    {isOther ? <span className="font-semibold text-warn">unattributed</span> : <span className="text-fg-3">this domain</span>}
                    {s.isNew ? (
                      <span className="font-semibold text-fg-2">
                        new{s.newSenderRisk ? `, ${s.newSenderRisk.replace("-", " ")}` : ""}
                      </span>
                    ) : null}
                  </span>
                </Td>
                <Td numeric muted title={s.sourceIps.slice(0, 8).join(", ")}>
                  {s.sourceIps.length}
                </Td>
                <Td numeric>{fmtVolume(s.totalMessages)}</Td>
                <Td numeric className={s.failedMessages > 0 ? "font-semibold text-fail" : undefined}>
                  {fmtVolume(s.failedMessages)}
                </Td>
                <Td numeric className={s.failedMessages > 0 ? "font-semibold text-fail" : "text-fg-3"}>
                  {s.failureSharePercent}%
                </Td>
                <Td numeric muted>
                  {share(s.dkimPassMessages, s.totalMessages)}
                </Td>
                <Td numeric muted>
                  {share(s.spfPassMessages, s.totalMessages)}
                </Td>
                <Td>
                  <Badge tone={SENDER_STATUS[s.status].tone}>{SENDER_STATUS[s.status].label}</Badge>
                </Td>
                <Td numeric muted title={`first seen ${instantLabel(s.firstSeenAt)}`}>
                  {shortDate(s.lastSeenAt)}
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}

const RISK: Record<SourceAttribution["risk"], { tone: Tone; label: string }> = {
  high: { tone: "fail", label: "High" },
  medium: { tone: "warn", label: "Medium" },
  low: { tone: "neutral", label: "Low" },
};

function SourcesTable({ sources }: { sources: SourceAttribution[] }) {
  if (sources.length === 0) {
    return <PanelNote>No sending source has been observed yet.</PanelNote>;
  }
  return (
    <div className="flex flex-col gap-3 pt-4">
      <p className="text-ui text-fg-2">
        Source addresses that sent mail claiming this domain, most failures first. Risk is the API&rsquo;s reading of
        failure volume and forensic evidence; the top {sources.length === 25 ? "25 are" : `${sources.length} are`} shown.
      </p>
      <Table caption="Sending sources" minWidth={860} dense>
        <THead>
          <tr>
            <Th>Source IP</Th>
            <Th>Sending domain</Th>
            <Th numeric>Messages</Th>
            <Th numeric>Failed</Th>
            <Th numeric>Forensic</Th>
            <Th numeric>Reports</Th>
            <Th>Risk</Th>
            <Th numeric>Last seen</Th>
          </tr>
        </THead>
        <TBody>
          {sources.map((s) => (
            <Tr key={s.sourceIp} tone={s.risk === "high" ? "fail" : undefined}>
              <Td mono className="font-semibold">
                {s.sourceIp}
              </Td>
              <Td mono muted={!s.topSendingDomain}>
                {s.topSendingDomain ?? <span className="text-meta">none reported</span>}
              </Td>
              <Td numeric>{fmtVolume(s.totalMessages)}</Td>
              <Td numeric className={s.failedMessages > 0 ? "font-semibold text-fail" : undefined}>
                {fmtVolume(s.failedMessages)}
              </Td>
              <Td numeric muted>
                {s.forensicMessages || <Nil label="none" />}
              </Td>
              <Td numeric muted>
                {s.reportCount}
              </Td>
              <Td>
                <Badge tone={RISK[s.risk].tone}>{RISK[s.risk].label}</Badge>
              </Td>
              <Td numeric muted>
                {s.lastSeenAt ? shortDate(s.lastSeenAt) : <Nil label="not recorded" />}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function ReportsTable({ reports }: { reports: ReportRow[] }) {
  if (reports.length === 0) {
    return (
      <PanelNote>
        No aggregate report has been received for this domain yet. Measurement begins when the first receiver sends
        one, usually within 24 to 48 hours of the DMARC record being published.
      </PanelNote>
    );
  }
  return (
    <div className="flex flex-col gap-3 pt-4">
      <p className="text-ui text-fg-2">The {reports.length} most recent aggregate (RUA) reports, as each receiver sent them.</p>
      <Table caption="Aggregate reports received" minWidth={900}>
        <THead>
          <tr>
            <Th>Reporter</Th>
            <Th>Report ID</Th>
            <Th>Period</Th>
            <Th numeric>Received</Th>
            <Th numeric>Records</Th>
            <Th numeric>Messages</Th>
            <Th numeric>Failed</Th>
            <Th>Policy</Th>
          </tr>
        </THead>
        <TBody>
          {reports.map((r) => {
            const messages = r.records.reduce((n, rec) => n + rec.messageCount, 0);
            // The API's own rule, so this column and the readout agree.
            const failed = r.records
              .filter((rec) => (rec.dkimResult ?? "").toLowerCase() !== "pass" || (rec.spfResult ?? "").toLowerCase() !== "pass")
              .reduce((n, rec) => n + rec.messageCount, 0);
            return (
              <Tr key={r.id}>
                <Td className="font-semibold">{r.reportingOrganization ?? <span className="text-fg-3">unknown reporter</span>}</Td>
                <Td mono muted className="max-w-[180px] truncate" title={r.reportId ?? undefined}>
                  {r.reportId ?? "none"}
                </Td>
                <Td className="tnum whitespace-nowrap text-fg-2">
                  {r.dateRangeBegin ? `${shortDate(r.dateRangeBegin)} – ${r.dateRangeEnd ? shortDate(r.dateRangeEnd) : "?"}` : <Nil label="no period stated" />}
                </Td>
                <Td numeric muted>
                  {shortDate(r.receivedAt)}
                </Td>
                <Td numeric muted>
                  {r.records.length}
                </Td>
                <Td numeric>{fmtVolume(messages)}</Td>
                <Td numeric className={failed > 0 ? "font-semibold text-fail" : undefined}>
                  {fmtVolume(failed)}
                </Td>
                <Td mono muted={!r.policyP}>
                  {r.policyP ? `p=${r.policyP}` : <Nil label="not stated" />}
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}

function PanelNote({ children }: { children: React.ReactNode }) {
  return <p className="border-b border-rule py-8 text-body text-fg-3">{children}</p>;
}

// ─── policy ───────────────────────────────────────────────────────────────────

/**
 * Posture is a ladder, not a traffic light. The published rung is chosen from
 * evidence (DNS scan, or what reporters saw), never from the scan-only field
 * alone, which is empty for a domain never scanned.
 */
function PolicyPanel({
  onboarding,
  observedPolicy,
}: {
  onboarding: OnboardingState;
  observedPolicy: string;
}) {
  const r = onboarding.readiness;
  const observed = observedPolicy.toLowerCase();
  const rungs = [
    { key: "none-record", label: "no record", live: observed === "not observed" && r.currentPolicy === "unknown" },
    { key: "none", label: "none", live: observed === "none" },
    { key: "quarantine", label: "quarantine", live: observed === "quarantine" },
    { key: "reject", label: "reject", live: observed === "reject" },
  ];
  return (
    <aside aria-labelledby="policy-head" className="flex flex-col gap-5 self-start border-t border-rule-2 pt-3">
      <h2 id="policy-head" className="text-h3 font-bold tracking-[-0.01em]">
        Policy posture
      </h2>

      <p className="-mb-3 text-meta text-fg-3">
        The DMARC <span className="data">p=</span> ladder, from watching to enforcing.
      </p>
      <ol className="grid grid-cols-4 border border-rule-2" aria-label="DMARC policy ladder">
        {rungs.map((rung, i) => (
          <li
            key={rung.key}
            aria-current={rung.live ? "step" : undefined}
            className={rung.live ? "bg-fg px-2 py-2 text-paper" : "border-l border-rule px-2 py-2 first:border-l-0"}
          >
            <span className={rung.live ? "legend text-paper-3!" : "legend"}>rung {i}</span>
            <span className="narrow mt-0.5 block text-ui font-semibold">{rung.label}</span>
            {rung.live ? (
              <span className="mt-0.5 block text-[10.5px] font-semibold uppercase tracking-[0.06em]">{i === 0 ? "current" : "published"}</span>
            ) : null}
          </li>
        ))}
      </ol>

      <dl className="flex flex-col border-t border-rule">
        <Fact k="Evidence">
          <span className="tnum">{r.daysObserved}</span> days, <span className="tnum">{fmtVolume(r.messagesObserved)}</span> messages
        </Fact>
        <Fact k="Pass rate">{r.passRatePercent === null ? <span className="text-fg-3">not measured</span> : <span className="tnum">{r.passRatePercent}%</span>}</Fact>
        <Fact k="Senders">
          <span className={r.failingSenders ? "tnum font-semibold text-fail" : "tnum"}>{r.failingSenders}</span> failing of{" "}
          <span className="tnum">{r.observedSenders}</span>
        </Fact>
        <Fact k="Open alerts">
          <span className="tnum">{r.openAlerts}</span>
          {r.staleAlerts ? <span className="text-fg-3"> ({r.staleAlerts} stale)</span> : null}
        </Fact>
        <Fact k="Next step">
          {r.ready ? (
            <span className="font-semibold text-ok">
              evidence supports <span className="data">p={r.level}</span>
            </span>
          ) : (
            <span className="text-fg-2">not ready{r.blockers.length ? "" : ": keep observing"}</span>
          )}
        </Fact>
      </dl>
      {!r.ready && r.blockers.length > 0 ? (
        <ul className="-mt-2 flex flex-col gap-1">
          {r.blockers.map((b) => (
            <li key={b} className="flex items-baseline gap-2 text-meta text-fg-2">
              <span aria-hidden className="block size-1.5 shrink-0 translate-y-[-1px] rotate-45 bg-warn-mark" />
              {b}
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}

/** How reports reach us for this domain, and where its setup stands. */
function SetupPanel({ onboarding, insights, slug }: { onboarding: OnboardingState; insights: DomainInsights; slug: string }) {
  const rep = insights.reporting;
  return (
    <div className="grid gap-8 pt-4 lg:grid-cols-2">
      <div>
        <p className="legend pb-1.5">Reporting</p>
        <dl className="flex flex-col border-t border-rule-2">
          <Fact k="Aggregate (rua)">{yesNo(rep.aggregateConfigured, "address published", "not published")}</Fact>
          <Fact k="Forensic (ruf)">{yesNo(rep.forensicConfigured, "address published", "not published")}</Fact>
          <Fact k="Collection">{yesNo(rep.collectionEnabled, "on", "off")}</Fact>
          <Fact k="Named recipients">{yesNo(rep.identityRetentionEnabled, "retained", "hashed")}</Fact>
        </dl>
        <p className="mt-3 text-meta text-fg-3">
          Records to publish, ownership verification and share links are on{" "}
          <Link href={onboardingHref(slug)} className="link">
            the domain&rsquo;s setup page
          </Link>
          .
        </p>
      </div>
      {onboarding.steps.length > 0 ? (
        <div>
          <p className="legend pb-1.5">
            Setup <span className="tnum">{onboarding.completedSteps}</span> of <span className="tnum">{onboarding.totalSteps}</span> done
          </p>
          <ul className="flex flex-col border-t border-rule-2">
            {onboarding.steps.map((s) => (
              <li key={s.id} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 border-b border-rule py-2 text-ui">
                <Badge tone={s.status === "done" ? "ok" : s.status === "blocked" ? "fail" : "neutral"}>{s.status}</Badge>
                <span>
                  <span className="font-semibold text-fg">{s.title}</span>
                  <span className="mt-0.5 block text-meta text-fg-3">{s.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule py-1.5">
      <dt className="text-meta font-semibold text-fg-3">{k}</dt>
      <dd className="text-right text-meta text-fg">{children}</dd>
    </div>
  );
}

function yesNo(v: boolean, yes: string, no: string) {
  return v ? <span className="font-semibold text-fg">{yes}</span> : <span className="text-fg-3">{no}</span>;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function buildScanRows(scans: ScanRow[]): ScanHistoryRow[] {
  return scans.map((scan) => ({
    id: scan.id,
    status: scan.status,
    startedLabel: instantLabel(scan.startedAt),
    completedLabel: scan.completedAt ? instantLabel(scan.completedAt) : null,
    // No member behind a scan means a scheduler or migration ran it.
    requestedBy: scan.requestedBy?.name?.trim() || scan.requestedBy?.email?.trim() || "an automated job",
    error: scan.error,
  }));
}

/** The API sends pass rates as percentages already (0–100, two decimals). */
function rate(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)}%`;
}

function share(part: number, total: number): string {
  return total > 0 ? `${((part / total) * 100).toFixed(0)}%` : "—";
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function windowLabel(w: { begin: string | null; end: string | null }): string {
  if (!w.begin || !w.end) return "no measurement window";
  return `${shortDate(w.begin)} – ${shortDate(w.end)}`;
}

function capitalise(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
