import type { Metadata } from "next";
import { getTeamsDestination, OpsError } from "@/lib/api-ops";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import type { TeamsDestination } from "@/lib/types";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { TeamsBoard } from "@/components/harbor/settings/teams";
import { ErrorState, PermissionState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Microsoft Teams alerts" };

/** /settings/teams — on every plan; reading it needs owner or admin. */
export default async function TeamsPage() {
  const ctx = await settingsContext();
  const read = await getTeamsDestination(ctx.active.id)
    .then((d) => ({ kind: "ok" as const, destination: d as TeamsDestination | null }))
    .catch((e: unknown) => ({
      kind: e instanceof OpsError && e.status === 403 ? ("forbidden" as const) : ("failed" as const),
    }));

  return (
    <SettingsFrame
      ctx={ctx}
      section="teams"
      lede="Alerts your rules raise can also go to one Microsoft Teams channel, through a Workflows webhook. Email alerts and Slack are unaffected either way."
    >
      {read.kind === "ok" ? (
        <TeamsBoard
          organizationId={ctx.active.id}
          destination={read.destination}
          canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
          lastDeliveredLabel={
            read.destination?.lastDeliveredAt ? instantLabel(read.destination.lastDeliveredAt) : null
          }
        />
      ) : read.kind === "forbidden" ? (
        <PermissionState what="the Teams destination" back={{ label: "All settings", href: "/settings" }} />
      ) : (
        <ErrorState what="the Teams destination" detail="Nothing was changed. Retry to read it." />
      )}
    </SettingsFrame>
  );
}
