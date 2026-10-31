import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { listClients } from "@/lib/api";
import { getWorkspaceEntitlements, listReportDigests } from "@/lib/api-ops";
import { nextDigestDue, scheduleLabel } from "@/lib/digest-schedule";
import { featureOf } from "@/lib/entitlements";
import { instantLabel } from "@/lib/instant";
import { resolveActiveWorkspace } from "@/lib/session";
import { AppShell } from "@/components/harbor/app-shell";
import { DigestBoard, type DigestView } from "@/components/harbor/digest-board";
import { DigestForm } from "@/components/harbor/digest-form";
import { OpsSection } from "@/components/harbor/ops-parts";
import { PageHeader } from "@/components/harbor/page-header";
import { PlanUnknown } from "@/components/harbor/plan-refusal";
import { RefreshButton } from "@/components/harbor/refresh-button";
import { ErrorState, UpgradeNotice } from "@/components/ui/states";

export const metadata: Metadata = { title: "Digests" };

/**
 * /digests — the report emails that go out on a schedule, per domain.
 *
 * Each digest is one domain's summary, sent weekly or monthly at an hour in
 * UTC to up to 20 addresses: the client's IT contact, a colleague, the
 * account manager. The list says when each one goes next, worked out with the
 * scheduler's own rule (lib/digest-schedule.ts), when it last went, and lets
 * it be sent at once with what was sent shown back.
 *
 * Gating follows the API: creating a digest needs `digests` on the plan;
 * reading, pausing, editing, sending and deleting do not. A failed list read
 * is the failure state, never "no digests yet".
 */
export default async function DigestsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const [entitlements, clients, digests] = await Promise.all([
    getWorkspaceEntitlements(active.id).catch(() => null),
    listClients(active.id).catch(() => null),
    listReportDigests(active.id).catch(() => null),
  ]);
  const digestsOnPlan = featureOf(entitlements, "digests");
  const forensicsOnPlan = featureOf(entitlements, "reports.forensic");

  const now = new Date();
  // Departures order: due now first, then the soonest, paused last.
  const order = new Map<string, number>();
  const views: DigestView[] = (digests?.items ?? []).map((d) => {
    const next = d.enabled ? nextDigestDue(d, now) : null;
    order.set(
      d.id,
      next === null ? Number.POSITIVE_INFINITY : next === "now" ? Number.NEGATIVE_INFINITY : Number.isNaN(next.getTime()) ? Number.MAX_VALUE : next.getTime(),
    );
    return {
      ...d,
      scheduleLabel: scheduleLabel(d),
      // In UTC, like the schedule it is computed from: "Mondays at 09:00 UTC,
      // next 14:30" in another zone reads as a contradiction.
      nextLabel:
        next === null
          ? null
          : next === "now"
            ? "now"
            : Number.isNaN(next.getTime())
              ? null
              : `${next.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`,
      lastSentLabel: d.lastSentAt ? instantLabel(d.lastSentAt) : null,
    };
  });
  views.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || a.domain.name.localeCompare(b.domain.name));
  const enabled = views.filter((d) => d.enabled).length;
  const dueNow = views.filter((d) => d.nextLabel === "now").length;
  const clientsServed = new Set(views.filter((d) => d.enabled).map((d) => d.domain.client.id)).size;
  const domainGroups = (clients ?? [])
    .filter((c) => c.domains.length > 0)
    .map((c) => ({ clientName: c.name, domains: c.domains.map((d) => ({ id: d.id, name: d.name })) }));

  return (
    <AppShell workspaces={workspaces} activeWorkspace={active} trail={[{ label: "Digests" }]}>
      <div className="flex flex-col gap-10">
        <PageHeader
          title="Digests"
          lede="A domain's report summary, emailed on a schedule to the people who need it: the client's IT contact, a colleague, the account manager. Weekly or monthly, at an hour in UTC."
          meta={
            digests && views.length > 0 ? (
              <>
                <span>
                  <span className="tnum font-semibold text-fg-2">{enabled}</span> of <span className="tnum">{views.length}</span> scheduled digest
                  {views.length === 1 ? "" : "s"} active
                </span>
                <span>
                  <span className="tnum font-semibold text-fg-2">{clientsServed}</span> client{clientsServed === 1 ? "" : "s"} receiving one
                </span>
                {dueNow > 0 ? (
                  <span>
                    <span className="tnum font-semibold text-fg">{dueNow}</span> due now
                  </span>
                ) : null}
              </>
            ) : null
          }
          actions={<RefreshButton />}
        />

        {entitlements === null ? <PlanUnknown what="scheduled digests" /> : null}

        <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_380px]">
          <OpsSection
            id="scheduled-head"
            title="Scheduled"
            meta={digests && views.length > 0 ? "Soonest first" : null}
          >
            {digests === null ? (
              <ErrorState what="the scheduled digests" detail="This is a connection or API problem, not an empty schedule." />
            ) : (
              <DigestBoard organizationId={active.id} digests={views} forensicsOnPlan={forensicsOnPlan === true} />
            )}
          </OpsSection>

          <aside className="flex flex-col gap-3 self-start lg:sticky lg:top-[104px]">
            {digestsOnPlan === false ? (
              <UpgradeNotice
                message="Scheduled digests are not included in this workspace's plan."
                feature="digests"
                context="Digests already scheduled keep their settings and can still be paused, edited, sent or deleted."
              />
            ) : clients === null ? (
              <ErrorState what="the domain list" detail="The new-digest form needs it to offer domains." />
            ) : (
              <DigestForm organizationId={active.id} domainGroups={domainGroups} forensicsOnPlan={forensicsOnPlan === true} />
            )}
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
