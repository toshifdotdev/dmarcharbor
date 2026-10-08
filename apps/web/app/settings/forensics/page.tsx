import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getOnboardingState, listClients } from "@/lib/api";
import { OpsError, getWorkspaceEntitlements, listDomainForensics } from "@/lib/api-ops";
import { instantLabel } from "@/lib/instant";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { UpgradePrompt } from "@/components/upgrade-gate";
import { LoadingState } from "@/components/data-states";
import {
  ForensicsPanel,
  type ForensicDomainStateView,
  type ForensicReportListRow,
  type ForensicReportsView,
  type ForensicsDomainOption,
} from "@/components/forensics-client";
import type { ClientRow, ForensicReportRow } from "@/lib/types";

/**
 * Forensic reporting: what is collected, what identity sits behind it, the
 * reports already held, and the two ways to destroy them.
 *
 * WHY A SETTINGS SECTION FOR A PER DOMAIN FEATURE
 *
 * Two reasons, and they pull in the same direction. The licensing and retention
 * are workspace-wide facts that belong beside the other workspace policy, and
 * every forensic route in the API is scoped to a domain except the two that name
 * a single report id. There is no workspace-wide list to read, so a section that
 * listed all of them would have to fan out one request per domain, would show
 * each domain's first page without saying so, and would still have to make the
 * per-domain decision for every control below. So the section is one domain,
 * chosen with a picker, and the domain is in the URL: a reader can link to the
 * exact domain whose forensic history they mean to read or erase.
 *
 * TWO LICENCES, GATED SEPARATELY
 *
 * `reports.forensic` opens the section. Without it the list route and the ingest
 * route both refuse with a 402, so there is nothing to read and nothing to
 * store, and an upgrade prompt is the whole honest answer.
 *
 * `reports.forensicNamed` gates one control and is passed down separately rather
 * than folded into the section gate. It is a different and more expensive
 * licence, the identity route is the only forensic route that checks it, and a
 * workspace can hold the first without the second. Folding them together would
 * hide forensic reporting from a workspace that legitimately has it.
 *
 * THE READS, AND WHICH OF THEM MAY FAIL
 *
 * Four reads, each with its own failure state, because they are four different
 * claims and a failure of one must not quietly become an absence of another:
 *
 *   clients        which domains exist. Failure means the picker is short.
 *   forensics      the stored reports, with the retention windows. A 403 is a
 *                  role answer, a 402 is a plan answer, and neither is an empty
 *                  list.
 *   onboarding     this domain's collection and identity settings, its ruf=
 *                  configuration, and the API's own sentence about both.
 *
 * The retention windows and the collection state arrive from two different
 * endpoints, so a failure of one leaves the other on screen rather than blanking
 * the section.
 */
export default async function ForensicsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ domain?: string; cursor?: string }>;
}) {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const { domain: wantedDomain, cursor } = await searchParams;

  const entitlements = await getWorkspaceEntitlements(active.id).catch(() => null);
  const forensicEntitled = entitlements?.features["reports.forensic"] === true;
  const namedEntitled = entitlements?.features["reports.forensicNamed"] === true;

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Forensics</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            The per-message failure reports a domain's reporters send us:
            which host sent them, who failed to authenticate, and how the mail was
            disposed of. Every report is stored redacted, whether or not the
            recipient behind it is retained, and the two purges below are the only
            way any of it is destroyed.
          </p>
        </header>
        <SettingsNav current="forensics" />

        {!forensicEntitled ? (
          <UpgradePrompt
            error={{
              feature: "reports.forensic",
              message: entitlements
                ? "Forensic reporting is not included in this plan."
                : "Forensic reporting requires an entitlement the current plan does not carry.",
            }}
            context="The API owns which plan carries forensic reporting. Without it the report list and the manual ingest both refuse, so there is nothing to show on this page."
          />
        ) : (
          <Suspense fallback={<LoadingState label="Loading forensic reporting" />}>
            <ForensicsSection
              organizationId={active.id}
              wantedDomain={wantedDomain}
              cursor={cursor}
              namedEntitled={namedEntitled}
              planLabel={entitlements?.label ?? null}
            />
          </Suspense>
        )}
      </div>
    </Shell>
  );
}

async function ForensicsSection({
  organizationId,
  wantedDomain,
  cursor,
  namedEntitled,
  planLabel,
}: {
  organizationId: string;
  wantedDomain: string | undefined;
  /** The API's page cursor, passed through as it was given. */
  cursor: string | undefined;
  namedEntitled: boolean;
  planLabel: string | null;
}) {
  // The domain list is what the picker is built from, so a failure here is
  // tracked on its own rather than swallowed into "no domains".
  const clients = await listClients(organizationId).then(
    (rows: ClientRow[]) => ({ rows, failed: false }),
    () => ({ rows: [] as ClientRow[], failed: true }),
  );

  const domains: ForensicsDomainOption[] = clients.rows.flatMap((client) =>
    client.domains.map((domain) => ({
      id: domain.id,
      name: domain.name,
      clientName: client.name,
      status: domain.status,
    })),
  );

  /**
   * A selection that is not in this workspace falls back to the first domain and
   * says so, rather than rendering a section for a domain nothing else on the
   * page can name. The message is shown because the reader followed a link and
   * silently landing somewhere else is worse than saying why.
   */
  const selected =
    domains.find((domain) => domain.id === wantedDomain) ?? domains[0] ?? null;
  const ignoredDomain =
    wantedDomain && selected && selected.id !== wantedDomain ? wantedDomain : null;

  const [reports, domainState] = selected
    ? await Promise.all([
        readReports(organizationId, selected.id, cursor),
        readDomainState(organizationId, selected.id),
      ])
    : [emptyReports(), emptyState()];

  return (
    <ForensicsPanel
      organizationId={organizationId}
      domains={domains}
      domainsFailed={clients.failed}
      selectedDomain={selected}
      ignoredDomain={ignoredDomain}
      namedEntitled={namedEntitled}
      planLabel={planLabel}
      reports={reports}
      domainState={domainState}
    />
  );
}

/**
 * The stored reports, with every refusal kept distinct from an empty list.
 *
 * Three refusals are real answers and each has its own place on screen:
 *
 *   403 the caller's role does not hold forensic read. A viewer role cannot
 *       reach this route at all, so "nothing is stored" would be a lie told by a
 *       read that never happened.
 *   402 the plan stopped carrying forensic reporting between this page's
 *       entitlement check and this call. The gate above already covers the
 *       normal case; this is the race, and it is still not an empty domain.
 *   anything else a failed read, which is not evidence about the domain at all.
 */
async function readReports(
  organizationId: string,
  domainId: string,
  cursor: string | undefined,
): Promise<ForensicReportsView> {
  try {
    const response = await listDomainForensics(organizationId, domainId, {
      limit: 25,
      cursor,
    });
    return {
      status: "ok",
      rows: buildReportRows(response.items ?? []),
      detail: null,
      retention: {
        retentionDays: response.retentionDays,
        piiRetentionDays: response.piiRetentionDays,
        redactionVersion: response.redactionVersion,
      },
      hasMore: response.hasMore === true,
      nextCursor: response.nextCursor ?? null,
    };
  } catch (error) {
    if (error instanceof OpsError && error.status === 403) {
      return { ...emptyReports(), status: "forbidden", detail: error.message };
    }
    if (error instanceof OpsError && error.status === 402) {
      return { ...emptyReports(), status: "unlicensed", detail: error.message };
    }
    return { ...emptyReports(), status: "failed" };
  }
}

/**
 * The domain's collection and identity settings.
 *
 * Read from the onboarding endpoint because it is the only one that answers both
 * flags, whether a ruf= address is published, and the address one should be
 * published to. Its route carries requireOrganizationPermission('domain', 'read')
 * and no requireFeature, so the setting is readable by a role that could not
 * read the reports themselves: knowing a domain collects forensics is a fact
 * about its DNS, not a licence to see the evidence.
 */
async function readDomainState(
  organizationId: string,
  domainId: string,
): Promise<ForensicDomainStateView> {
  try {
    const state = await getOnboardingState(organizationId, domainId);
    const forensicStep = state.steps.find((step) => step.id === "forensic_optional");
    return {
      status: "ok",
      collectionEnabled: state.reporting.collectionEnabled,
      identityRetentionEnabled: state.reporting.identityRetentionEnabled,
      rufConfigured: state.reporting.forensicConfigured,
      forensicAddress: state.suggestedRecord.forensicAddress,
      // The API's own sentence about this domain's forensic reporting, quoted
      // rather than replaced: it already distinguishes "no ruf= address" from
      // "not collecting", and a paraphrase would flatten that.
      stepDetail: forensicStep?.detail ?? null,
    };
  } catch {
    return { ...emptyState(), status: "failed" };
  }
}

/**
 * Report rows with their timestamps written, and the three identity states
 * separated.
 *
 * The identity state is derived here rather than in the panel because it needs
 * three facts, not one: whether the report ever retained identities, whether
 * they are visible to this caller, and whether there are any. Collapsing them
 * into a boolean would make "withheld from your role" render as "pseudonyms
 * only", which is a different and wrong statement about the same report.
 */
function buildReportRows(items: ForensicReportRow[]): ForensicReportListRow[] {
  return items.map((report) => ({
    id: report.id,
    reportedDomain: report.reportedDomain,
    sourceIp: report.sourceIp,
    sourcePort: report.sourcePort,
    disposition: report.disposition,
    deliveryAction: report.deliveryAction,
    dkimResult: report.dkimResult,
    spfResult: report.spfResult,
    recipientCount: report.recipientCount,
    receivedLabel: instantLabel(report.receivedAt),
    identities: report.piiWithheld
      ? "withheld"
      : report.piiAvailable
        ? "stored"
        : "pseudonymous",
  }));
}

/** No domain selected: an empty panel, not a failed read and not a lie. */
function emptyReports(): ForensicReportsView {
  return { status: "ok", rows: [], detail: null, retention: null, hasMore: false, nextCursor: null };
}

/** No domain selected: nothing is claimed about a domain that was not chosen. */
function emptyState(): ForensicDomainStateView {
  return {
    status: "ok",
    collectionEnabled: false,
    identityRetentionEnabled: false,
    rufConfigured: false,
    forensicAddress: null,
    stepDetail: null,
  };
}