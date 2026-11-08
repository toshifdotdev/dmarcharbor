import type { Metadata } from "next";
import { listClients } from "@/lib/api";
import { getPlanCatalog, getWorkspaceEntitlements, listChatDestinations, OpsError } from "@/lib/api-ops";
import { featureOf, includedFrom } from "@/lib/entitlements";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import { PlanUnknown } from "@/components/harbor/plan-refusal";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { TeamsBoard } from "@/components/harbor/settings/teams";
import { ErrorState, PermissionState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Microsoft Teams alerts" };

/**
 * /settings/teams — reading it needs owner or admin. Adding, changing, switching
 * on and the test message need alerts.email; reading, pausing and removing a
 * kept channel stay on every plan, so a downgrade never strands an address
 * nobody can delete. The clients are loaded to route channels by client.
 */
export default async function TeamsPage() {
  const ctx = await settingsContext();
  const [read, entitlements, catalog, clientRows] = await Promise.all([
    listChatDestinations(ctx.active.id, "teams")
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
      section="teams"
      lede="Alerts, DNS changes and expiry warnings can also go to Microsoft Teams channels, through Workflows webhooks: one channel for everything, or a channel per client or per kind of message. Email alerts and Slack are unaffected either way."
    >
      {read.kind === "ok" ? (
        <>
          {entitlements === null ? <PlanUnknown what="Microsoft Teams alerts" /> : null}
          <TeamsBoard
            organizationId={ctx.active.id}
            destinations={read.destinations}
            clients={clients}
            canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
            alerting={alerting}
            includedFrom={includedFrom(catalog, "alerts.email")}
          />
        </>
      ) : read.kind === "forbidden" ? (
        <PermissionState what="the Teams channels" back={{ label: "All settings", href: "/settings" }} />
      ) : (
        <ErrorState what="the Teams channels" detail="Nothing was changed. Retry to read them." />
      )}
    </SettingsFrame>
  );
}