import type { Metadata } from "next";
import {
  getPlanCatalog,
  getWorkspaceEntitlements,
  listWebhookDeliveries,
  listWebhookEndpoints,
  OpsError,
} from "@/lib/api-ops";
import { featureOf } from "@/lib/entitlements";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import { canReplayWebhookDelivery } from "@/lib/webhooks-client";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { WebhooksBoard, type DeliveryView, type EndpointView } from "@/components/harbor/settings/webhooks";
import { ErrorState, PermissionState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Webhooks" };

/**
 * /settings/webhooks — webhooks are included from Fairway, but reading and
 * removing endpoints is available on every plan so a downgrade never strands
 * configuration the customer can no longer manage.
 */
export default async function WebhooksPage() {
  const ctx = await settingsContext();
  const [listed, log, entitlements, catalog] = await Promise.all([
    listWebhookEndpoints(ctx.active.id).catch((e: unknown) => (e instanceof OpsError && e.status === 403 ? ("forbidden" as const) : null)),
    listWebhookDeliveries(ctx.active.id).catch(() => null),
    getWorkspaceEntitlements(ctx.active.id).catch(() => null),
    getPlanCatalog().catch(() => null),
  ]);

  const webhookFeature = featureOf(entitlements, "integrations.webhooks");
  const webhooksPlanLabel =
    catalog?.order
      .map((tier) => catalog.plans.find((plan) => plan.tier === tier))
      .find((plan) => plan?.features["integrations.webhooks"])?.label ?? "a paid plan";

  const now = Date.now();
  const endpoints: EndpointView[] =
    listed && listed !== "forbidden"
      ? listed.endpoints.map((e) => ({
          id: e.id,
          name: e.name,
          url: e.url,
          events: e.events,
          active: e.active,
          suspendedUntilLabel: e.suspendedAt && new Date(e.suspendedAt).getTime() > now ? instantLabel(e.suspendedAt) : null,
          failureCount: e.failureCount,
          lastDeliveryLabel: e.lastDeliveryAt ? instantLabel(e.lastDeliveryAt) : null,
        }))
      : [];
  const names = new Map(endpoints.map((e) => [e.id, e.name]));
  const deliveries: DeliveryView[] | null = log
    ? log.deliveries.map((d) => ({
        id: d.id,
        endpointName: names.get(d.endpointId) ?? "A removed endpoint",
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        responseCode: d.responseCode,
        lastError: d.lastError,
        whenLabel: instantLabel(d.deliveredAt ?? d.createdAt),
        replayable: canReplayWebhookDelivery(d),
      }))
    : null;

  return (
    <SettingsFrame
      ctx={ctx}
      section="webhooks"
      lede="Events from this workspace, posted to your own systems as signed requests. Use them to open a ticket when an alert fires, or to sync domains into a PSA."
    >
      {listed === "forbidden" ? (
        <PermissionState what="webhooks" back={{ label: "All settings", href: "/settings" }} />
      ) : listed === null ? (
        <ErrorState what="the webhook endpoints" detail="Nothing was changed. Retry to read them." />
      ) : (
        <WebhooksBoard
          organizationId={ctx.active.id}
          endpoints={endpoints}
          deliveries={deliveries}
          events={listed.events}
          defaultEvents={listed.defaultEvents}
          canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
          webhookFeature={webhookFeature}
          webhooksPlanLabel={webhooksPlanLabel}
        />
      )}
    </SettingsFrame>
  );
}
