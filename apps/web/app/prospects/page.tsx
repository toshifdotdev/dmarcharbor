import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getWorkspaceEntitlements, listProspectReports, OpsError } from "@/lib/api-ops";
import { featureOf } from "@/lib/entitlements";
import { resolveActiveWorkspace } from "@/lib/session";
import { AppShell } from "@/components/harbor/app-shell";
import { PageHeader } from "@/components/harbor/page-header";
import { PlanUnknown } from "@/components/harbor/plan-refusal";
import { ProspectBoard } from "@/components/harbor/prospect-board";
import { RefreshButton } from "@/components/harbor/refresh-button";
import { ErrorState, PermissionState, UpgradeNotice } from "@/components/ui/states";

export const metadata: Metadata = { title: "Prospects" };

/**
 * /prospects — email security checks of companies that are not clients yet.
 *
 * Gating follows the API: creating a report needs `prospects.reports` and
 * counts against the month's allowance; reading, revoking and removing do
 * not, so a downgraded workspace can still withdraw links it sent. A failed
 * list read is the failure state, never "no reports yet".
 */
export default async function ProspectsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");
  const [entitlements, data] = await Promise.all([
    getWorkspaceEntitlements(active.id).catch(() => null),
    listProspectReports(active.id).catch((error: unknown) =>
      error instanceof OpsError && error.status === 403 ? ("forbidden" as const) : null,
    ),
  ]);
  const onPlan = featureOf(entitlements, "prospects.reports");
  // The API checks the role on every write and answers a viewer with a 403,
  // which the board shows in words; the page does not guess the role here.
  const canManage = true;

  return (
    <AppShell workspaces={workspaces} activeWorkspace={active} trail={[{ label: "Prospects" }]}>
      <div className="flex flex-col gap-8">
        <PageHeader
          title="Prospects"
          lede="Check the email security of a company you want to win, and send them a plain-language report under your name. Their domain does not need to be a client or verified: it reads public DNS only."
          actions={<RefreshButton />}
        />
        {entitlements === null ? <PlanUnknown what="prospect risk reports" /> : null}
        {onPlan === false ? (
          <UpgradeNotice
            feature="prospects.reports"
            message="Prospect risk reports are included from Fairway."
            context="Reports already sent stay listed here, and can still be revoked."
          />
        ) : null}
        {data === "forbidden" ? (
          <PermissionState what="prospect reports" />
        ) : data === null ? (
          <ErrorState what="the prospect reports" detail="Nothing was changed. Retry to read them." />
        ) : (
          <ProspectBoard
            organizationId={active.id}
            reports={data.reports}
            usage={data.usage}
            canCreate={onPlan === true && canManage}
            canManage={canManage}
          />
        )}
      </div>
    </AppShell>
  );
}
