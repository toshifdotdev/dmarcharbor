import type { Metadata } from "next";
import { getPlanCatalog, getSlackDestination, getWorkspaceEntitlements, OpsError } from "@/lib/api-ops";
import { featureOf, includedFrom } from "@/lib/entitlements";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import type { SlackDestination } from "@/lib/types";
import { PlanUnknown } from "@/components/harbor/plan-refusal";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { SlackBoard } from "@/components/harbor/settings/slack";
import { ErrorState, PermissionState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Slack alerts" };

/**
 * /settings/slack — reading it needs owner or admin. Connecting, replacing and
 * switching it on need alerts.email (the same key as every alert channel);
 * reading and removing a kept destination stay on every plan, so a downgrade
 * never strands a webhook nobody can delete.
 */
export default async function SlackPage() {
  const ctx = await settingsContext();
  const [read, entitlements, catalog] = await Promise.all([
    getSlackDestination(ctx.active.id)
      .then((d) => ({ kind: "ok" as const, destination: d as SlackDestination | null }))
      .catch((e: unknown) => ({ kind: e instanceof OpsError && e.status === 403 ? ("forbidden" as const) : ("failed" as const) })),
    getWorkspaceEntitlements(ctx.active.id).catch(() => null),
    getPlanCatalog().catch(() => null),
  ]);
  const alerting = featureOf(entitlements, "alerts.email");

  return (
    <SettingsFrame
      ctx={ctx}
      section="slack"
      lede="Alerts your rules raise can also go to one Slack channel, through a Slack incoming webhook. Email alerts are unaffected either way."
    >
      {read.kind === "ok" ? (
        <>
          {entitlements === null ? <PlanUnknown what="Slack alerts" /> : null}
          <SlackBoard
            organizationId={ctx.active.id}
            destination={read.destination}
            canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
            lastDeliveredLabel={read.destination?.lastDeliveredAt ? instantLabel(read.destination.lastDeliveredAt) : null}
            alerting={alerting}
            includedFrom={includedFrom(catalog, "alerts.email")}
          />
        </>
      ) : read.kind === "forbidden" ? (
        <PermissionState what="the Slack destination" back={{ label: "All settings", href: "/settings" }} />
      ) : (
        <ErrorState what="the Slack destination" detail="Nothing was changed. Retry to read it." />
      )}
    </SettingsFrame>
  );
}
