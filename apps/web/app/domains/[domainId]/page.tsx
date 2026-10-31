import Link from "next/link";
import { notFound, redirect, unstable_rethrow } from "next/navigation";
import {
  ApiError,
  deriveSignals,
  getDomainInsights,
  getOnboardingState,
  getSessionUser,
  listClients,
  listDomainReports,
} from "@/lib/api";
import {
  getDnsChanges,
  getDnsConnections,
  getDomainSwitch,
  getHostedBimi,
  getHostedDmarc,
  getPolicyProposals,
  getHostedMtaSts,
  getManagedSpf,
  getMailboxCompliance,
  getPlanCatalog,
  getSubdomains,
  getTlsReportSummary,
  getTlsReports,
  getDomainRegistration,
  getWorkspaceEntitlements,
  listDomainScans,
  listWorkspaceMembers,
  OpsError,
} from "@/lib/api-ops";
import { getServiceMeta } from "@/lib/api-public";
import { readHostBrand } from "@/lib/host-brand";
import { featureOf } from "@/lib/entitlements";
import { dmarcFailedMessages } from "@/lib/dmarc";
import { toDnsChangeView } from "@/lib/dns-change-view";
import { instantLabel } from "@/lib/instant";
import { daysSinceReport, fmtVolume, policyLabel, policySourceOf, POSTURE_META, resolvePosture } from "@/lib/posture";
import { onboardingHref } from "@/lib/route-hrefs";
import { resolveActiveWorkspace } from "@/lib/session";
import type {
  DnsChangePage,
  DomainInsights,
  DomainPolicyProposals,
  DomainRegistrationView,
  DomainSwitchView,
  HostedBimiView,
  HostedDmarcView,
  HostedMtaStsView,
  ManagedSpfView,
  MailboxComplianceView,
  OnboardingState,
  ReportRow,
  ScanRow,
  SourceAttribution,
  SubdomainDiscovery,
  TlsReportPage,
  TlsReportSummary,
} from "@/lib/types";
import { AppShell } from "@/components/harbor/app-shell";
import { DnsChangesPanel } from "@/components/harbor/dns-changes";
import { DomainSwitchPanel } from "@/components/harbor/domain-switch";
import { HostedBimi } from "@/components/harbor/hosted-bimi";
import { HostedDmarc } from "@/components/harbor/hosted-dmarc";
import { HostedMtaSts } from "@/components/harbor/hosted-mta-sts";
import { PolicyProposals } from "@/components/harbor/policy-proposals";
import { ManagedSpf } from "@/components/harbor/managed-spf";
import { MailboxCompliance } from "@/components/harbor/mailbox-compliance";
import { ScanHistory } from "@/components/harbor/scan-history";
import { toScanHistoryRow } from "@/lib/scan-history-view";
import { SendersTable } from "@/components/harbor/senders-table";
import { SpfUsage } from "@/components/harbor/spf-usage";
import { SubdomainsTable } from "@/components/harbor/subdomains-table";
import { TlsReports } from "@/components/harbor/tls-reports";
import { PageHeader, SectionHead } from "@/components/harbor/page-header";
import { brandName } from "@/components/harbor/public-frame";
import { RefreshButton } from "@/components/harbor/refresh-button";
import { VolumeChart } from "@/components/harbor/volume-chart";
import { DomainRouteMap, type RouteMode } from "@/components/harbor/domain-route-map";
import { passPercent, routeLines } from "@/components/harbor/domain-routes";
import { StationList, StationStrip, type SegmentState } from "@/components/harbor/station-strip";
import { Badge, PostureBadge, PostureMark, type Tone } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Readout, ReadoutStrip } from "@/components/ui/readout";
import { ErrorState } from "@/components/ui/states";
import { Nil, Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";

/**
 * Domain detail: the evidence for one domain, for the technician who came
 * here from the portfolio because something is wrong or because it is time
 * for the next policy step.
 *
 * Read top to bottom it answers their questions in their order:
 * - Is mail being lost or forged right now? The header's posture and one-line
 *   answer, the readouts, and the red line on the map.
 * - What sends as this domain, and does each sender authenticate and align?
 *   The mail routes map: every measured sender a line, the two aligned checks
 *   its stations, failing mail on the red line to wherever the policy sends it.
 * - What do I fix, and where? The crossed-out line, the senders and sources
 *   tables, DNS changes (raised above the tables while one is unread).
 * - Is it safe to move to quarantine or reject? The policy ladder beside the
 *   map, its blockers, and the client approval under it.
 * Then the volume chart (is the feed alive) and the evidence tables.
 *
 * Every figure is the API's. Aggregate failures are DMARC failures (both
 * aligned checks failed), because a message that passes one is delivered under
 * p=reject. The Reports table uses the same shared rule as the API. Nothing
 * not measured is drawn as zero or as passing.
 */
export default async function DomainPage({
  params,
  searchParams,
}: {
  params: Promise<{ domainId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ domainId }, { tab }] = await Promise.all([params, searchParams]);
  const { workspaces, active } = await resolveActiveWorkspace();
  // No workspace is an onboarding step, never a 404.
  if (!active) redirect("/welcome");

  let insights: DomainInsights | undefined;
  let onboarding: OnboardingState | undefined;
  let reports: ReportRow[] = [];
  let clientName = "";
  let clientId = "";
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
        clientId = c.id;
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
  const policySourceKind = policySourceOf(insights.reporting.publishedPolicy, signals.reportedPolicy);
  const policySource = policySourceKind === "scan" ? "from DNS scan" : policySourceKind === "reports" ? "as reporters saw it" : null;
  const failShare = agg.messageCount > 0 ? agg.failedMessages / agg.messageCount : null;

  // A scan history is a different claim from the report evidence, so it fails
  // on its own and renders as a failure, never as an empty history.
  const [scanHistory, switchState, dnsChanges, serviceMeta, members, me, entitlements, catalog, dnsConnections, mailboxCompliance, hostedDmarc, managedSpf, hostedBimi, hostedMtaSts, tlsSummary, tlsReports, registration, policyProposals, subdomains] = await Promise.all([
    listDomainScans(active.id, id).then(
      (page) => ({ rows: page.rows, nextCursor: page.nextCursor, failed: false }),
      () => ({ rows: [] as ScanRow[], nextCursor: null as string | null, failed: true }),
    ),
    getDomainSwitch(active.id, id).then(
      (data: DomainSwitchView) => ({ data, failed: false }),
      () => ({ data: null as DomainSwitchView | null, failed: true }),
    ),
    getDnsChanges(active.id, id).then(
      (page: DnsChangePage) => ({ page, failed: false }),
      () => ({ page: null as DnsChangePage | null, failed: true }),
    ),
    getServiceMeta().catch(() => null),
    listWorkspaceMembers(active.id).catch(() => null),
    getSessionUser().catch(() => null),
    getWorkspaceEntitlements(active.id).catch(() => null),
    getPlanCatalog().catch(() => null),
    getDnsConnections(active.id).catch(() => null),
    getMailboxCompliance(active.id, id).then(
      (data: MailboxComplianceView) => ({ data, failed: false }),
      () => ({ data: null as MailboxComplianceView | null, failed: true }),
    ),
    getHostedDmarc(active.id, id).then(
      (data: HostedDmarcView) => ({ data, failed: false }),
      () => ({ data: null as HostedDmarcView | null, failed: true }),
    ),
    getManagedSpf(active.id, id).then(
      (data: ManagedSpfView) => ({ data, failed: false }),
      () => ({ data: null as ManagedSpfView | null, failed: true }),
    ),
    getHostedBimi(active.id, id).then(
      (data: HostedBimiView) => ({ data, failed: false }),
      () => ({ data: null as HostedBimiView | null, failed: true }),
    ),
    getHostedMtaSts(active.id, id).then(
      (data: HostedMtaStsView) => ({ data, failed: false }),
      () => ({ data: null as HostedMtaStsView | null, failed: true }),
    ),
    getTlsReportSummary(active.id, id).then(
      (data: TlsReportSummary) => ({ data, failed: false, notInPlan: false }),
      (error: unknown) =>
        error instanceof OpsError && error.status === 402
          ? { data: null as TlsReportSummary | null, failed: false, notInPlan: true }
          : { data: null as TlsReportSummary | null, failed: true, notInPlan: false },
    ),
    getTlsReports(active.id, id, { limit: 25 }).then(
      (data: TlsReportPage) => ({ data, failed: false, notInPlan: false }),
      (error: unknown) =>
        error instanceof OpsError && error.status === 402
          ? { data: null as TlsReportPage | null, failed: false, notInPlan: true }
          : { data: null as TlsReportPage | null, failed: true, notInPlan: false },
    ),
    // `undefined` when the read failed: the header then says nothing rather
    // than "not checked yet", which would be a claim.
    getDomainRegistration(active.id, id).then(
      (data) => data.registration,
      () => undefined,
    ),
    // null when the read failed: the panel then says so, never "none sent".
    getPolicyProposals(active.id, id).catch(() => null as DomainPolicyProposals | null),
    // null when the read failed: the tab then says so, never "none seen".
    getSubdomains(active.id, id).catch(() => null as SubdomainDiscovery | null),
  ]);

  const role =
    members?.members.find((member) => (member.userId ?? member.user?.id) === me?.id)?.role ?? null;
  const canAcknowledgeDnsChanges = role === null || ["owner", "admin", "analyst"].includes(role);
  const ownerFeature = featureOf(entitlements, "senders.owners");
  const hostedFeature = featureOf(entitlements, "dns.hosted");
  const portalFeature = featureOf(entitlements, "portal.client");
  const managedSpfFeature = featureOf(entitlements, "dns.managedSpf");
  const hostedBimiFeature = featureOf(entitlements, "dns.hostedBimi");
  const hostedMtaStsFeature = featureOf(entitlements, "dns.hostedMtaSts");
  const spfUsageFeature = featureOf(entitlements, "dns.spfUsage");
  const spfUsagePlanLabel =
    catalog?.order
      .map((tier) => catalog.plans.find((plan) => plan.tier === tier))
      .find((plan) => plan?.features["dns.spfUsage"])?.label ?? "a paid plan";
  const canEditDomain = role === null || ["owner", "admin", "analyst"].includes(role);
  const latestSpfScan = scanHistory.rows.find((row) => row.result?.spf) ?? null;
  const currentSpf = latestSpfScan?.result?.spf
    ? {
        record: latestSpfScan.result.spf.record ?? null,
        lookupCount: latestSpfScan.result.spf.lookupCount ?? null,
      }
    : null;
  const latestScan = scanHistory.rows.find((row) => row.result) ?? null;
  const mtaStsPresent =
    latestScan?.result?.mtaSts?.status === "found"
      ? true
      : latestScan?.result?.mtaSts
        ? false
        : null;
  const tlsCount =
    tlsSummary.notInPlan || tlsSummary.failed || !tlsSummary.data
      ? null
      : tlsSummary.data.reportCount;
  const ownersPlanLabel =
    catalog?.order
      .map((tier) => catalog.plans.find((plan) => plan.tier === tier))
      .find((plan) => plan?.features["senders.owners"])?.label ?? "a paid plan";
  const dnsInitial = dnsChanges.page
    ? {
        rows: dnsChanges.page.rows.map((row) => toDnsChangeView(row)),
        nextCursor: dnsChanges.page.nextCursor,
      }
    : null;

  const today = new Date(now).toISOString().slice(0, 10);
  // The hosted panels name whoever serves the record: the agency on its own domain.
  const brand = brandName(await readHostBrand());

  // The map draws only measured senders; silence is drawn as silence.
  const routeMode: RouteMode =
    resolved.posture === "unmeasured" ? "unmeasured" : resolved.posture === "stale" ? "stale" : "live";
  const routes = routeLines(insights.senders, insights.domain.name);
  const testing = onboarding.reporting.publishedTesting || onboarding.readiness.testing === true;
  // An unread WARNING or CRITICAL DNS change may be why mail is failing, so it
  // is raised above the evidence tables until someone acknowledges it.
  const dnsUnread = Boolean(dnsInitial?.rows.some((row) => row.severity !== "INFO" && !row.acknowledgedAt));
  const dnsPanel = (
    <DnsChangesPanel
      organizationId={active.id}
      domainId={id}
      domainName={insights.domain.name}
      initial={dnsInitial}
      loadFailed={dnsChanges.failed}
      canAcknowledge={canAcknowledgeDnsChanges}
      rescanIntervalMinutes={serviceMeta?.monitoring?.rescanIntervalMinutes ?? null}
    />
  );

  return (
    <AppShell
      workspaces={workspaces}
      activeWorkspace={active}
      trail={[
        { label: clientName, href: "/clients" },
        { label: insights.domain.name, mono: true },
      ]}
    >
      <div className="flex flex-col gap-8">
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
                ) : observedPolicy === "unknown" ? (
                  <span className="text-fg-3">no usable record{policySource ? ` ${policySource}` : ""}</span>
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
              {registration !== undefined ? (
                <MetaItem k="Registration">
                  <RegistrationExpiry registration={registration} />
                </MetaItem>
              ) : null}
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
            label="Failed DMARC"
            // With no message observed, "0 failed" would read as a pass.
            value={agg.messageCount > 0 ? fmtVolume(agg.failedMessages) : "—"}
            unit={failShare !== null && agg.failedMessages > 0 ? `${(failShare * 100).toFixed(1)}% of observed` : undefined}
            tone={agg.failedMessages > 0 ? "fail" : undefined}
            note={agg.messageCount > 0 ? "messages where both SPF and DKIM failed alignment" : "not measured"}
          />
          <Readout label="Reports received" value={fmtVolume(agg.reportCount)} note={`${fmtVolume(agg.recordCount)} records in them`} />
          <Readout
            label="SPF aligned"
            value={agg.spfPassRate === null ? "—" : passPercent(agg.spfPassRate)}
            note={agg.spfPassRate === null ? "not measured" : "of observed messages"}
          />
          <Readout
            label="DKIM aligned"
            value={agg.dkimPassRate === null ? "—" : passPercent(agg.dkimPassRate)}
            note={agg.dkimPassRate === null ? "not measured" : "of observed messages"}
          />
          <Readout
            label="Forensic reports"
            value={fmtVolume(insights.forensic.count)}
            note={insights.reporting.forensicConfigured ? `${fmtVolume(insights.forensic.rejectedMessages)} rejected or quarantined` : "no ruf= address published"}
          />
        </ReadoutStrip>

        {agg.partiallyAlignedMessages > 0 ? (
          <p className="-mt-3 text-ui text-fg-2" data-testid="partially-aligned">
            {fmtVolume(agg.partiallyAlignedMessages)} message
            {agg.partiallyAlignedMessages === 1 ? "" : "s"} passed DMARC on one check only. They are delivered under
            p=reject, but fixing the other check makes them robust.
          </p>
        ) : null}

        {/* The routes and the volume are the evidence; the policy ladder beside
            them is the decision that evidence feeds. The tables below get the
            full width, because tables are what need it. */}
        <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_340px] xl:gap-12">
          <div className="flex min-w-0 flex-col gap-10">
            <section aria-labelledby="routes-head" className="min-w-0">
              <figure className="m-0 flex flex-col gap-3">
                <SectionHead
                  id="routes-head"
                  title="Mail routes"
                  aside={routesMeta(routeMode, routes.lines.length, agg.messageCount, windowLabel(agg.messageWindow), ageDays)}
                  className="border-b border-rule"
                />
                <DomainRouteMap
                  domainName={insights.domain.name}
                  lines={routes.lines}
                  mode={routeMode}
                  messages={agg.messageCount}
                  failed={agg.failedMessages}
                  spfRate={agg.spfPassRate}
                  dkimRate={agg.dkimPassRate}
                  policy={observedPolicy}
                  testing={testing}
                />
                <figcaption className="max-w-[86ch] text-meta text-fg-3">
                  {routeMode === "unmeasured"
                    ? "Lines appear here once receivers send aggregate reports, usually 24 to 48 hours after a DMARC record with a rua= address is published. Until then every station is closed: not measured, not passing."
                    : `Each line is a sender from the aggregate reports, named by the domain it authenticated as; a service is named only where DKIM or reverse DNS supports it. Mail that failed both aligned checks failed DMARC and leaves on the red line, which ends where the published policy sends it. From ${fmtVolume(agg.reportCount)} report${agg.reportCount === 1 ? "" : "s"}${routeMode === "stale" ? "; these are the last routes measured, not today’s" : ""}.`}
                </figcaption>
              </figure>
            </section>
            <section aria-labelledby="volume-head" className="min-w-0">
              <SectionHead
                id="volume-head"
                title="Observed volume"
                aside={`last ${insights.trends.days} days, to today`}
                className="mb-3 border-b border-rule"
              />
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
          </div>
          <PolicyPanel onboarding={onboarding} observedPolicy={observedPolicy} testing={testing}>
            <PolicyProposals
              organizationId={active.id}
              domainId={id}
              domainName={insights.domain.name}
              data={policyProposals}
              readiness={onboarding.readiness}
              canEdit={canEditDomain}
              hasPortal={portalFeature}
            />
          </PolicyPanel>
        </div>

        <DomainSwitchPanel
          organizationId={active.id}
          domainId={id}
          domainName={insights.domain.name}
          state={switchState}
          publish={{
            organizationId: active.id,
            domainId: id,
            connections: dnsConnections?.connections ?? [],
            canPublish: role === null || ["owner", "admin", "analyst"].includes(role),
          }}
        />

        {dnsUnread ? dnsPanel : null}

        <div>
          <section aria-label="Evidence tables" className="min-w-0">
            <Tabs
              label="Evidence"
              defaultTab={tab === "setup" ? "setup" : tab === "tls" ? "tls" : undefined}
              tabs={[
                {
                  id: "senders",
                  label: "Senders",
                  count: insights.senders.length,
                  panel: (
                    <SendersTable
                      organizationId={active.id}
                      domainId={id}
                      domainName={insights.domain.name}
                      senders={insights.senders}
                      canReview={role === null || ["owner", "admin", "analyst"].includes(role)}
                      ownerFeature={ownerFeature}
                      ownersPlanLabel={ownersPlanLabel}
                      members={members?.members ?? []}
                    />
                  ),
                },
                {
                  id: "sources",
                  label: "Sources",
                  count: insights.sources.length,
                  panel: <SourcesTable sources={insights.sources} />,
                },
                {
                  id: "subdomains",
                  label: "Subdomains",
                  count: subdomains ? subdomains.subdomains.filter((row) => !row.dismissed).length : null,
                  panel: (
                    <SubdomainsTable
                      organizationId={active.id}
                      domainId={id}
                      clientId={clientId}
                      domainName={insights.domain.name}
                      subdomains={subdomains?.subdomains ?? null}
                      windowDays={subdomains?.windowDays ?? 90}
                      failed={subdomains === null}
                      canEdit={canEditDomain}
                    />
                  ),
                },
                {
                  id: "mailbox",
                  label: "Gmail, Yahoo, Outlook",
                  count: mailboxCompliance.failed ? null : (mailboxCompliance.data?.counts.fails ?? null),
                  panel: <MailboxCompliance data={mailboxCompliance.data} failed={mailboxCompliance.failed} />,
                },
                {
                  id: "reports",
                  label: "Aggregate reports",
                  count: reports.length,
                  panel: <ReportsTable reports={reports} />,
                },
                {
                  id: "tls",
                  label: "TLS reports",
                  count: tlsCount,
                  panel: (
                    <TlsReports
                      organizationId={active.id}
                      domainName={insights.domain.name}
                      summary={tlsSummary.data}
                      reports={tlsReports.data}
                      failed={tlsSummary.failed || tlsReports.failed}
                      notInPlan={tlsSummary.notInPlan || tlsReports.notInPlan}
                      mtaStsPresent={mtaStsPresent}
                    />
                  ),
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
                      scans={scanHistory.rows.map(toScanHistoryRow)}
                      nextCursor={scanHistory.nextCursor}
                      loadFailed={scanHistory.failed}
                      hostedZone={serviceMeta?.hostedZone ?? null}
                    />
                  ),
                },
                {
                  id: "setup",
                  label: "Reporting and setup",
                  count: null,
                  panel: (
                    <SetupPanel
                      onboarding={onboarding}
                      insights={insights}
                      slug={slug}
                      domainId={id}
                      organizationId={active.id}
                      domainName={insights.domain.name}
                      hosted={hostedDmarc}
                      hasHostedFeature={hostedFeature}
                      managedSpf={managedSpf}
                      hasManagedSpfFeature={managedSpfFeature}
                      hostedBimi={hostedBimi}
                      hasHostedBimiFeature={hostedBimiFeature}
                      hostedMtaSts={hostedMtaSts}
                      hasHostedMtaStsFeature={hostedMtaStsFeature}
                      hasSpfUsageFeature={spfUsageFeature}
                      spfUsagePlanLabel={spfUsagePlanLabel}
                      spfServices={serviceMeta?.spfServices ?? []}
                      currentSpf={currentSpf}
                      canEdit={canEditDomain}
                      brand={brand}
                    />
                  ),
                },
              ]}
            />
          </section>
        </div>

        {dnsUnread ? null : dnsPanel}
      </div>
    </AppShell>
  );
}

/** The figure head's meta: what the map covers, or that nothing does. */
function routesMeta(mode: RouteMode, lines: number, messages: number, span: string, ageDays: number | null): string {
  if (mode === "unmeasured") return "nothing measured yet";
  const what = `${lines} line${lines === 1 ? "" : "s"} · ${fmtVolume(messages)} messages · ${span}`;
  return mode === "stale" && ageDays !== null ? `${what} · no report for ${ageDays} days` : what;
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

/**
 * When the registration lapses, as the registry reported it.
 *
 * Red from seven days (and once expired), amber inside thirty, plain beyond.
 * The registry's own words are used for the cases with no date, because "no
 * date" and "not looked up yet" are different claims.
 */
function RegistrationExpiry({ registration }: { registration: DomainRegistrationView | null }) {
  if (!registration) {
    return (
      <span className="text-fg-3" data-testid="domain-registration">
        not checked yet
      </span>
    );
  }
  if (!registration.expiresAt || registration.daysLeft === null) {
    const words: Record<string, string> = {
      no_expiry: "the registry publishes no expiry date",
      unsupported: "this registry has no RDAP service",
      not_found: "the registry has no record of it",
      error: "the registry could not be read",
    };
    return (
      <span className="text-fg-3" data-testid="domain-registration">
        {words[registration.status] ?? "no expiry date"}
      </span>
    );
  }
  const days = registration.daysLeft;
  const date = new Date(registration.expiresAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const tone = days <= 7 ? "font-semibold text-fail" : days <= 30 ? "font-semibold text-warn" : "text-fg-2";
  const label =
    days < 0
      ? `expired ${date}`
      : days === 0
        ? `expires today (${date})`
        : days <= 30
          ? `expires in ${days} day${days === 1 ? "" : "s"} (${date})`
          : `expires ${date}`;
  return (
    <span
      className={`tnum ${tone}`}
      data-testid="domain-registration"
      title={registration.registrar ? `Registrar: ${registration.registrar}` : undefined}
    >
      {label}
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
    <div role="status" className="flex items-start gap-3 rounded-[10px] border border-rule-2 bg-void-wash px-3.5 py-3">
      <span className="mt-[3px]">
        <PostureMark posture={posture} size={11} />
      </span>
      <p className="max-w-[110ch] text-ui">
        <span className="font-bold text-fg">{posture === "stale" ? "Stale: no report for more than 5 days. " : "Not measured: never. "}</span>
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
      <Table caption="Sending sources" minWidth={1080} dense>
        <THead>
          <tr>
            <Th>Source IP</Th>
            <Th>Service</Th>
            <Th>Confidence</Th>
            <Th>Sending domain</Th>
            <Th numeric>Messages</Th>
            <Th numeric>Failed DMARC</Th>
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
              <Td>
                <span className="block text-ui font-semibold text-fg">
                  {s.service && (s.confidence === "confirmed" || s.confidence === "likely")
                    ? s.service.name
                    : s.confidence === "network"
                      ? "Network only"
                      : s.confidence === "own"
                        ? "Your own mail server"
                        : "Not identified"}
                </span>
              </Td>
              <Td muted className="text-meta">
                {s.confidence === "confirmed"
                  ? "Confirmed"
                  : s.confidence === "likely"
                    ? "Likely"
                    : s.confidence === "network"
                      ? "ASN only"
                      : s.confidence === "own"
                        ? "Own server"
                        : "No evidence"}
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
            <Th numeric>Failed DMARC</Th>
            <Th>Policy</Th>
          </tr>
        </THead>
        <TBody>
          {reports.map((r) => {
            const messages = r.records.reduce((n, rec) => n + rec.messageCount, 0);
            const failed = dmarcFailedMessages(r.records);
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
 * Posture is a ladder, not a traffic light, drawn as the portfolio's strip
 * map: p=none, p=quarantine and p=reject as stations, ink up to the policy in
 * force, the next segment dashed only when the API says the evidence supports
 * it. The published station is chosen from evidence (DNS scan, or what
 * reporters saw), never from the scan-only field alone, which is empty for a
 * domain never scanned; no observed policy is a dotted line on no station.
 */
function PolicyPanel({
  onboarding,
  observedPolicy,
  testing,
  children,
}: {
  onboarding: OnboardingState;
  observedPolicy: string;
  /** t=y is published. */
  testing: boolean;
  /** The client-approval control, under the evidence it rests on. */
  children?: React.ReactNode;
}) {
  const r = onboarding.readiness;
  const observed = observedPolicy.trim().toLowerCase();
  const stage = observed === "none" ? 0 : observed === "quarantine" ? 1 : observed === "reject" ? 2 : null;
  const target = r.level === "reject" ? 2 : r.level === "quarantine" ? 1 : 0;
  // Only the next step can be "planned": stages are taken one at a time.
  const segments: SegmentState[] = [0, 1].map((i) =>
    stage !== null && i < stage ? "built" : stage !== null && i === stage && r.ready && target > stage ? "planned" : "unbuilt",
  );
  const stations = (["none", "quarantine", "reject"] as const).map((p, i) => ({
    key: p,
    name: <span className="data">p={p}</span>,
    note:
      stage === i
        ? testing
          ? "published, t=y"
          : "published"
        : stage !== null && i === stage + 1 && segments[stage] === "planned"
          ? <span className="font-semibold text-ok">ready</span>
          : undefined,
    state: (stage === null || i > stage ? "ahead" : i === stage ? "here" : "passed") as "ahead" | "here" | "passed",
  }));
  return (
    <aside aria-labelledby="policy-head" className="flex flex-col gap-5 self-start">
      <SectionHead id="policy-head" title="Policy posture" aside="the DMARC p= ladder" className="border-b border-rule" />

      <div className="flex flex-col gap-2">
        <StationStrip label="DMARC policy ladder" stations={stations} segments={segments} unobserved={stage === null} />
        {stage === null ? (
          <p className="text-meta text-fg-3">
            {observed === "unknown"
              ? "No usable DMARC record is on file, so the domain is on no step yet."
              : "No policy has been observed in DNS or in reports, so the domain is on no step yet."}
          </p>
        ) : testing ? (
          <p className="text-meta text-fg-3">
            t=y is published: receivers apply the policy one step softer while it is tested.
          </p>
        ) : null}
      </div>

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
          {stage === 2 && !testing ? (
            <span className="text-fg-2">none: p=reject is the strictest</span>
          ) : r.ready ? (
            <span className="font-semibold text-ok">
              evidence supports <span className="data">p={r.level}</span>
            </span>
          ) : (
            <span className="text-fg-2">not ready{r.blockers.length ? "" : ": keep observing"}</span>
          )}
        </Fact>
      </dl>
      {!r.ready && r.blockers.length > 0 ? (
        <div className="-mt-1">
          <p className="legend pb-1.5">{stage === 2 ? "Open points" : "In the way of the next step"}</p>
          <ul className="flex flex-col gap-1.5">
            {r.blockers.map((b) => (
              <li key={b} className="flex items-baseline gap-2 text-meta text-fg-2">
                <span aria-hidden className="block size-1.5 shrink-0 translate-y-[-1px] rotate-45 bg-warn-mark" />
                {b}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {children}
    </aside>
  );
}

/** How reports reach us for this domain, and where its setup stands. */
function SetupPanel({
  onboarding,
  insights,
  slug,
  domainId,
  organizationId,
  domainName,
  hosted,
  hasHostedFeature,
  managedSpf,
  hasManagedSpfFeature,
  hostedBimi,
  hasHostedBimiFeature,
  hostedMtaSts,
  hasHostedMtaStsFeature,
  hasSpfUsageFeature,
  spfUsagePlanLabel,
  spfServices,
  currentSpf,
  canEdit,
  brand,
}: {
  onboarding: OnboardingState;
  insights: DomainInsights;
  slug: string;
  domainId: string;
  organizationId: string;
  domainName: string;
  hosted: { data: HostedDmarcView | null; failed: boolean };
  hasHostedFeature: boolean | null;
  managedSpf: { data: ManagedSpfView | null; failed: boolean };
  hasManagedSpfFeature: boolean | null;
  hostedBimi: { data: HostedBimiView | null; failed: boolean };
  hasHostedBimiFeature: boolean | null;
  hostedMtaSts: { data: HostedMtaStsView | null; failed: boolean };
  hasHostedMtaStsFeature: boolean | null;
  hasSpfUsageFeature: boolean | null;
  spfUsagePlanLabel: string;
  spfServices: Array<{ id: string; name: string; include: string }>;
  currentSpf: { record: string | null; lookupCount: number | null } | null;
  canEdit: boolean;
  /** The name on this host, for the panels that say who serves a record. */
  brand: string;
}) {
  const rep = insights.reporting;
  return (
    <div className="flex flex-col gap-6 pt-5">
      {/* Where setup stands comes first; the hosted records are the tools. */}
      <div className="grid gap-x-12 gap-y-8 border-b border-rule-2 pb-6 lg:grid-cols-2">
        {onboarding.steps.length > 0 ? (
          <div>
            <p className="legend pb-1.5">
              Setup <span className="tnum">{onboarding.completedSteps}</span> of{" "}
              <span className="tnum">{onboarding.totalSteps}</span> done
            </p>
            <StationList
              label="Setup steps"
              className="border-t border-rule-2 pt-3"
              stops={onboarding.steps.map((s) => ({ key: s.id, title: s.title, detail: s.detail, state: s.status }))}
            />
          </div>
        ) : null}
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
      </div>
      <HostedDmarc
        organizationId={organizationId}
        domainId={domainId}
        domainName={domainName}
        view={hosted.data}
        failed={hosted.failed}
        canEdit={canEdit}
        hasFeature={hasHostedFeature}
        brand={brand}
      />
      <ManagedSpf
        organizationId={organizationId}
        domainId={domainId}
        domainName={domainName}
        view={managedSpf.data}
        failed={managedSpf.failed}
        canEdit={canEdit}
        hasFeature={hasManagedSpfFeature}
        spfServices={spfServices}
        currentSpf={currentSpf}
        brand={brand}
      />
      <SpfUsage
        organizationId={organizationId}
        domainId={domainId}
        hasFeature={hasSpfUsageFeature}
        planLabel={spfUsagePlanLabel}
      />
      <HostedBimi
        organizationId={organizationId}
        domainId={domainId}
        domainName={domainName}
        view={hostedBimi.data}
        failed={hostedBimi.failed}
        canEdit={canEdit}
        hasFeature={hasHostedBimiFeature}
        brand={brand}
      />
      <HostedMtaSts
        organizationId={organizationId}
        domainId={domainId}
        domainName={domainName}
        view={hostedMtaSts.data}
        failed={hostedMtaSts.failed}
        canEdit={canEdit}
        hasFeature={hasHostedMtaStsFeature}
        brand={brand}
      />
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
