import { redirect } from "next/navigation";
import { listWebhookDeliveries, listWebhookEndpoints } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { WebhooksPanel } from "@/components/webhooks-client";
import type { WebhookDeliveryRow, WebhookEndpointRow, WebhookEventName } from "@/lib/types";

/**
 * Outbound webhooks: where this workspace posts signed events, and what came
 * back each time it tried.
 *
 * THREE STATES, NEVER TWO. Both reads are attempted and each one records whether
 * it failed, because a failed endpoint list must not render as "no integrations"
 * and a failed delivery log must not render as "nothing was ever sent". Both are
 * passed down to the panel rather than being collapsed here: the endpoint list
 * and the delivery log are separate claims, and failing one must not erase the
 * other.
 *
 * NO ENTITLEMENT GATE, deliberately. The webhook routes carry requireSession and
 * requireOrganizationPermission('organization', 'update') and nothing else: there
 * is no requireFeature on them, and no webhooks key exists in the plan catalog
 * (apps/api/src/services/entitlements/plan-catalog.ts). An earlier version of
 * this section gated on `api.access`, which would have hidden the feature from
 * a workspace the API would have served. The API owns that decision; this page
 * must not invent a second one.
 *
 * The signing secret never reaches this component. It exists only in the create
 * response, in the browser, in the client panel, once.
 */
export default async function WebhooksSettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const [endpointRes, deliveryRes] = await Promise.all([
    listWebhookEndpoints(active.id)
      .then((r) => ({
        endpoints: r.endpoints ?? ([] as WebhookEndpointRow[]),
        // The catalogue comes from the API. It cannot be empty in practice, but
        // an empty one would render a form with no checkboxes, so the fallback
        // keeps the create form usable rather than presenting a dead control.
        events: (r.events ?? []) as WebhookEventName[],
        defaultEvents: (r.defaultEvents ?? []) as WebhookEventName[],
        failed: false,
      }))
      .catch(() => ({
        endpoints: [] as WebhookEndpointRow[],
        events: [] as WebhookEventName[],
        defaultEvents: [] as WebhookEventName[],
        failed: true,
      })),
    listWebhookDeliveries(active.id)
      .then((r) => ({ deliveries: r.deliveries ?? ([] as WebhookDeliveryRow[]), failed: false }))
      .catch(() => ({ deliveries: [] as WebhookDeliveryRow[], failed: true })),
  ]);

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Webhooks</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            Signed events posted to an address you control: a domain verified, an
            alert fired, a report arrived. Every delivery is recorded with the
            response your endpoint gave, so a broken integration is visible before
            a customer reports it.
          </p>
        </header>
        <SettingsNav current="webhooks" />

        <WebhooksPanel
          organizationId={active.id}
          endpoints={endpointRes.endpoints}
          events={endpointRes.events}
          defaultEvents={endpointRes.defaultEvents}
          deliveries={deliveryRes.deliveries}
          endpointsFailed={endpointRes.failed}
          deliveriesFailed={deliveryRes.failed}
        />
      </div>
    </Shell>
  );
}
