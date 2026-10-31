import { Suspense } from "react";
import type { Metadata } from "next";
import { ApiError, getAllDomainSignals, getSessionUser, listClients, listWorkspaces } from "@/lib/api";
import { instantLabel } from "@/lib/instant";
import { daysSinceReport, policyLabel, resolvePosture, type Posture } from "@/lib/posture";
import { pickActiveWorkspace } from "@/lib/session";
import { requestOrigin } from "@/lib/metadata-origin";
import { publicMetadata } from "@/lib/seo";
import type { WorkspaceSummary } from "@/lib/types";
import { AppShell } from "@/components/harbor/app-shell";
import { Landing } from "@/components/harbor/landing";
import { PageHeader } from "@/components/harbor/page-header";
import { PortfolioBoard, type BoardRow } from "@/components/harbor/portfolio-board";
import { RefreshButton } from "@/components/harbor/refresh-button";
import { FirstDomain } from "@/components/harbor/first-domain";
import { InvitationsForYou } from "@/components/harbor/invitations";
import { getWorkspaceEntitlements } from "@/lib/api-ops";
import { ErrorState, LoadingState, UpgradeNotice } from "@/components/ui/states";

/** The root route serves two different readers (stranger and operator), and
 *  the stranger's page is the one a search engine sees. Its metadata describes
 *  the product. A signed-in operator's tab names the screen instead, like every
 *  other console route ("Clients", "Alerts"), rather than the marketing line. */
export async function generateMetadata(): Promise<Metadata> {
  // Per-request memo shared with the shell, so this adds no API call for an
  // operator; a crawler is never signed in and gets the product metadata.
  if (await getSessionUser()) return { title: "Portfolio" };
  const origin = await requestOrigin();
  return publicMetadata({
    title: "DMARC reports for MSPs managing client domains",
    description:
      "DMARC monitoring for agencies and MSPs: posture per client domain, evidence you can hand over, and a client portal in your brand. Measurement first; DNS changes only when you ask.",
    path: "/",
    origin,
  });
}

/**
 * The root route serves two audiences, and must never collapse into one:
 *
 *   stranger   the public landing page. A definite 401/403 from the workspace
 *              read is the only thing that means "stranger".
 *   signed in  the Portfolio, in distinguishable states: loading (the data is
 *              slow, not missing), empty (a first run, which teaches the next
 *              step), failed (says what failed, never "no domains"), plan
 *              (a 402, in the API's own words), and the board itself.
 *
 * A slow or failing API must never show a landing page to someone who has just
 * signed in, which is why anything other than 401/403 is rethrown into the
 * app's error boundary rather than treated as "not signed in".
 */
export default async function RootPage() {
  let workspaces: WorkspaceSummary[];
  try {
    workspaces = await listWorkspaces();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return <Landing />;
    }
    throw error;
  }

  const active = await pickActiveWorkspace(workspaces);

  return (
    <AppShell workspaces={workspaces} activeWorkspace={active} trail={[{ label: "Portfolio" }]}>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Portfolio"
          actions={<RefreshButton />}
        />
        {/* Invitations into other workspaces, for someone who already has one. Renders nothing when there are none. */}
        <InvitationsForYou />
        <Suspense fallback={<LoadingState label="Loading the portfolio" rows={8} />}>
          <PortfolioData organizationId={active ? active.id : ""} workspaceName={active?.name ?? "This workspace"} />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function PortfolioData({ organizationId, workspaceName }: { organizationId: string; workspaceName: string }) {
  let rows: BoardRow[];
  let clientCount: number;
  let clientList: Array<{ id: string; name: string }>;

  try {
    const clients = await listClients(organizationId);
    clientCount = clients.length;
    clientList = clients.map((c) => ({ id: c.id, name: c.name }));
    const signals = await getAllDomainSignals(
      organizationId,
      clients.flatMap((c) => c.domains),
    );
    // One clock read, on the server, for every age on the board.
    const now = Date.now();

    rows = clients.flatMap((client) =>
      client.domains.map((domain): BoardRow => {
        const s = signals.get(domain.id) ?? null;
        // Rule Zero: no signals, no posture. resolvePosture only ever runs on
        // a real measurement.
        const resolved = s ? resolvePosture(s) : null;
        const policy = policyLabel(domain.dmarcPolicy, s?.reportedPolicy ?? null);
        return {
          domainId: domain.id,
          slug: domain.slug,
          domain: domain.name,
          ownership: domain.status,
          clientName: client.name,
          posture: resolved?.posture ?? null,
          reason: resolved?.reason ?? null,
          messages: s ? s.messageCount : null,
          failed: s ? s.failedMessages : null,
          spfRate: s?.spfPassRate ?? null,
          dkimRate: s?.dkimPassRate ?? null,
          policy: policy === "not observed" ? null : policy,
          lastReportAgeDays: daysSinceReport(s?.lastReportAt ?? null, now),
          lastReportLabel: s?.lastReportAt ? instantLabel(s.lastReportAt) : null,
        };
      }),
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 402) {
      return (
        <UpgradeNotice
          message={err.message}
          feature={err.feature ?? "reports.aggregate"}
          context="Portfolio monitoring needs a plan that carries it."
        />
      );
    }
    // A failed load is never shown as "nothing here".
    return (
      <ErrorState
        what="the portfolio"
        detail="This is a connection or API problem, not an empty portfolio."
      />
    );
  }

  if (rows.length === 0) {
    // The empty portfolio is the setup itself. The plan's limits are shown
    // when they can be read; a failed read only drops the line, never the form.
    const ent = await getWorkspaceEntitlements(organizationId).catch(() => null);
    return (
      <FirstDomain
        organizationId={organizationId}
        workspaceName={workspaceName}
        clients={clientList}
        limits={ent ? { plan: ent.label, maxClients: ent.maxClients, maxActiveDomains: ent.maxActiveDomains } : null}
      />
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <Summary rows={rows} clientCount={clientCount} />
      <PortfolioBoard rows={rows} clientCount={clientCount} />
    </div>
  );
}

/**
 * The answer to "what needs me today", from the same counts as the board: a
 * headline that says it, the breakdown beside it, and one line of scale (how
 * many domains, and how far they have gone towards p=reject).
 */
function Summary({ rows, clientCount }: { rows: BoardRow[]; clientCount: number }) {
  const n = (p: Posture) => rows.filter((r) => r.posture === p).length;
  const block = n("block");
  const unverified = n("unverified");
  const stale = n("stale");
  const unmeasured = n("unmeasured");
  const pass = n("pass");
  const unread = rows.filter((r) => r.posture === null).length;
  const attention = block + unverified;
  const silent = stale + unmeasured;
  const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;

  let headline: string;
  let detail: string | null;
  if (attention > 0) {
    const parts = [block ? `${block} blocking` : null, unverified ? `${unverified} unverified` : null].filter(Boolean);
    headline = `${plural(attention, "domain")} need${attention === 1 ? "s" : ""} you today.`;
    detail = `${parts.join(", ")}.${
      silent > 0 ? ` ${silent} more ${silent === 1 ? "has" : "have"} no current measurement: ${stale} stale, ${unmeasured} not measured.` : ""
    }`;
  } else if (silent > 0) {
    headline = "Nothing is blocking or unverified.";
    detail = `${silent} of ${rows.length} prove nothing either way yet: ${stale} stale, ${unmeasured} not measured.`;
  } else if (pass === rows.length) {
    headline = `All ${plural(pass, "domain")} aligned.`;
    detail = "Within each domain's current report window.";
  } else {
    headline = "Some domains could not be read just now.";
    detail = "Their posture is unknown, not aligned.";
  }

  // How far the portfolio has gone towards enforcement, by the policy each row shows.
  const policyCount = (p: string) => rows.filter((r) => r.policy?.toLowerCase() === p).length;
  const atReject = policyCount("reject");
  const atQuarantine = policyCount("quarantine");
  const atNone = policyCount("none");
  const noRecord = policyCount("unknown");
  const notObserved = rows.length - atReject - atQuarantine - atNone - noRecord;
  const policyParts = [
    atReject ? `${atReject} at p=reject` : null,
    atQuarantine ? `${atQuarantine} at p=quarantine` : null,
    atNone ? `${atNone} at p=none` : null,
    noRecord ? `${noRecord} with no DMARC record in DNS` : null,
    notObserved ? `${notObserved} with no policy observed yet` : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-1" data-testid="portfolio-summary">
      <p className="display text-h2 text-fg">{headline}</p>
      {detail ? <p className="max-w-[80ch] text-lead text-fg-2">{detail}</p> : null}
      <p className="tnum mt-1 text-meta text-fg-3">
        {plural(rows.length, "domain")} across {plural(clientCount, "client")}
        {policyParts.length > 0 ? `: ${policyParts.join(", ")}` : ""}.
        {unread > 0 ? ` ${unread} could not be read just now.` : ""}
      </p>
    </div>
  );
}
