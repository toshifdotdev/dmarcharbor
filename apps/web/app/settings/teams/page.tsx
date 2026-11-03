import type { Metadata } from "next";
import { getPlanCatalog, getTeamsDestination, getWorkspaceEntitlements, OpsError } from "@/lib/api-ops";
import { featureOf, includedFrom } from "@/lib/entitlements";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import type { TeamsDestination } from "@/lib/types";
import { PlanUnknown } from "@/components/harbor/plan-refusal";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { TeamsBoard } from "@/components/harbor/settings/teams";
import { ErrorState, PermissionState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Microsoft Teams alerts" };

/**
 * /settings/teams — reading it needs owner or admin. Connecting, replacing,
 * switching on and the test message need alerts.email; reading and removing a
 * kept destination stay on every plan.
 */
export default async function TeamsPage() {
  const ctx = await settingsContext();
  const [read, entitlements, catalog] = await Promise.all([
    getTeamsDestination(ctx.active.id)
      .then((d) => ({ kind: "ok" as const, destination: d as TeamsDestination | null }))
      .catch((e: unknown) => ({
        kind: e instanceof OpsError && e.status === 403 ? ("forbidden" as const) : ("failed" as const),
      })),
    getWorkspaceEntitlements(ctx.active.id).catch(() => null),
    getPlanCatalog().catch(() => null),
  ]);
  const alerting = featureOf(entitlements, "alerts.email");

  return (
    <SettingsFrame
      ctx={ctx}
      section="teams"
      lede="Alerts your rules raise can also go to one Microsoft Teams channel, through a Workflows webhook. Email alerts and Slack are unaffected either way."
    >
      {read.kind === "ok" ? (
        <>
          {entitlements === null ? <PlanUnknown what="Microsoft Teams alerts" /> : null}
          <TeamsBoard
            organizationId={ctx.active.id}
            destination={read.destination}
            canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
            lastDeliveredLabel={
              read.destination?.lastDeliveredAt ? instantLabel(read.destination.lastDeliveredAt) : null
            }
            alerting={alerting}
            includedFrom={includedFrom(catalog, "alerts.email")}
          />
        </>
      ) : read.kind === "forbidden" ? (
        <PermissionState what="the Teams destination" back={{ label: "All settings", href: "/settings" }} />
      ) : (
        <ErrorState what="the Teams destination" detail="Nothing was changed. Retry to read it." />
      )}
    </SettingsFrame>
  );
}
