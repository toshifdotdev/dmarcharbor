import type { Metadata } from "next";
import { getSlackDestination, OpsError } from "@/lib/api-ops";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import type { SlackDestination } from "@/lib/types";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { SlackBoard } from "@/components/harbor/settings/slack";
import { ErrorState, PermissionState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Slack alerts" };

/** /settings/slack — on every plan; reading it needs owner or admin. */
export default async function SlackPage() {
  const ctx = await settingsContext();
  const read = await getSlackDestination(ctx.active.id)
    .then((d) => ({ kind: "ok" as const, destination: d as SlackDestination | null }))
    .catch((e: unknown) => ({ kind: e instanceof OpsError && e.status === 403 ? ("forbidden" as const) : ("failed" as const) }));

  return (
    <SettingsFrame
      ctx={ctx}
      section="slack"
      lede="Alerts your rules raise can also go to one Slack channel, through a Slack incoming webhook. Email alerts are unaffected either way."
    >
      {read.kind === "ok" ? (
        <SlackBoard
          organizationId={ctx.active.id}
          destination={read.destination}
          canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
          lastDeliveredLabel={read.destination?.lastDeliveredAt ? instantLabel(read.destination.lastDeliveredAt) : null}
        />
      ) : read.kind === "forbidden" ? (
        <PermissionState what="the Slack destination" back={{ label: "All settings", href: "/settings" }} />
      ) : (
        <ErrorState what="the Slack destination" detail="Nothing was changed. Retry to read it." />
      )}
    </SettingsFrame>
  );
}
