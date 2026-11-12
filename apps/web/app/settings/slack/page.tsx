import type { Metadata } from "next";
import { listClients } from "@/lib/api";
import { getPlanCatalog, getWorkspaceEntitlements, listChatDestinations, OpsError } from "@/lib/api-ops";
import { featureOf, includedFrom } from "@/lib/entitlements";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import { PlanUnknown } from "@/components/harbor/plan-refusal";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { SlackBoard } from "@/components/harbor/settings/slack";
import { ErrorState, PermissionState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Slack alerts" };

/**
 * /settings/slack — every team member can read it (addresses masked), so an analyst can see where alerts go; changing it needs owner or admin. Adding, changing, switching
 * on and the test message need alerts.email; reading, pausing and removing a
 * kept channel stay on every plan, so a downgrade never strands an address
 * nobody can delete. The clients are loaded to route channels by client.
 */
export default async function SlackPage() {
  const ctx = await settingsContext();
  const [read, entitlements, catalog, clientRows] = await Promise.all([
    listChatDestinations(ctx.active.id, "slack")
      .then((destinations) => ({ kind: "ok" as const, destinations }))
      .catch((e: unknown) => ({ kind: e instanceof OpsError && e.status === 403 ? ("forbidden" as const) : ("failed" as const) })),
    getWorkspaceEntitlements(ctx.active.id).catch(() => null),
    getPlanCatalog().catch(() => null),
    listClients(ctx.active.id).catch(() => null),
  ]);
  const alerting = featureOf(entitlements, "alerts.email");
  const clients = clientRows ? clientRows.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)) : null;
  return (
    <SettingsFrame
      ctx={ctx}
      section="slack"
      lede="Alerts, DNS changes and expiry warnings can also go to Slack channels, through Slack incoming webhooks: one channel for everything, or a channel per client or per kind of message. Email alerts are unaffected either way."
    >
      {read.kind === "ok" ? (
        <>
          {entitlements === null ? <PlanUnknown what="Slack alerts" /> : null}
          <SlackBoard
            organizationId={ctx.active.id}
            destinations={read.destinations}
            clients={clients}
            canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
            alerting={alerting}
            includedFrom={includedFrom(catalog, "alerts.email")}
          />
        </>
      ) : read.kind === "forbidden" ? (
        <PermissionState what="the Slack channels" back={{ label: "All settings", href: "/settings" }} />
      ) : (
        <ErrorState what="the Slack channels" detail="Nothing was changed. Retry to read them." />
      )}
    </SettingsFrame>
  );
}