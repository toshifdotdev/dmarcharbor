import type { Metadata } from "next";
import {
  getPlanCatalog,
  getPsa,
  getPsaJobs,
  getPsaMappings,
  getWorkspaceEntitlements,
  OpsError,
} from "@/lib/api-ops";
import { featureOf } from "@/lib/entitlements";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { PsaBoard } from "@/components/harbor/settings/psa";
import { ErrorState, PermissionState } from "@/components/ui/states";

export const metadata: Metadata = { title: "PSA" };

/**
 * /settings/psa — ticketing into the MSP's own PSA.
 *
 * Reading, disabling, deleting and the job log are available on every plan, so
 * a downgrade never strands configuration the customer can no longer manage.
 * The entitlement only gates connecting and mapping.
 */
export default async function PsaPage() {
  const ctx = await settingsContext();
  const [view, mappings, jobs, entitlements, catalog] = await Promise.all([
    getPsa(ctx.active.id).catch((e: unknown) => (e instanceof OpsError && e.status === 403 ? ("forbidden" as const) : null)),
    getPsaMappings(ctx.active.id).catch(() => null),
    getPsaJobs(ctx.active.id).catch(() => null),
    getWorkspaceEntitlements(ctx.active.id).catch(() => null),
    getPlanCatalog().catch(() => null),
  ]);

  const psaFeature = featureOf(entitlements, "integrations.psa");
  const psaPlanLabel =
    catalog?.order
      .map((tier) => catalog.plans.find((plan) => plan.tier === tier))
      .find((plan) => plan?.features["integrations.psa"])?.label ?? "a paid plan";

  return (
    <SettingsFrame
      ctx={ctx}
      section="psa"
      lede="When an alert fires or DNS changes, open a ticket in your own PSA under the client it belongs to — and keep it updated as the alert is acknowledged and resolved."
    >
      {view === "forbidden" ? (
        <PermissionState what="the PSA connection" back={{ label: "All settings", href: "/settings" }} />
      ) : view === null ? (
        <ErrorState what="the PSA connection" detail="Nothing was changed. Retry to read it." />
      ) : (
        <PsaBoard
          organizationId={ctx.active.id}
          view={view}
          mappings={mappings?.mappings ?? null}
          jobs={jobs?.jobs ?? null}
          canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
          psaFeature={psaFeature}
          psaPlanLabel={psaPlanLabel}
        />
      )}
    </SettingsFrame>
  );
}
