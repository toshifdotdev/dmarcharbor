import type { Metadata } from "next";
import { getDnsConnections, getPlanCatalog, getWorkspaceEntitlements, OpsError } from "@/lib/api-ops";
import { featureOf } from "@/lib/entitlements";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { DnsConnectionsBoard } from "@/components/harbor/settings/dns";
import { ErrorState, PermissionState } from "@/components/ui/states";

export const metadata: Metadata = { title: "DNS publishing" };

/**
 * /settings/dns — the Cloudflare credential, and nothing else.
 *
 * Listing and removing a connection are available on every plan so a downgrade
 * never strands a stored token. Creating one is the paid feature; the board
 * explains the refusal instead of hiding the section.
 */
export default async function DnsSettingsPage() {
  const ctx = await settingsContext();
  const [listed, entitlements, catalog] = await Promise.all([
    getDnsConnections(ctx.active.id).catch((error: unknown) => {
      if (error instanceof OpsError && error.status === 403) return "forbidden" as const;
      return null;
    }),
    getWorkspaceEntitlements(ctx.active.id).catch(() => null),
    getPlanCatalog().catch(() => null),
  ]);

  const feature = featureOf(entitlements, "dns.automation");
  const planLabel =
    catalog?.order
      .map((tier) => catalog.plans.find((plan) => plan.tier === tier))
      .find((plan) => plan?.features["dns.automation"])?.label ?? "a paid plan";

  return (
    <SettingsFrame
      ctx={ctx}
      section="dns"
      lede="Store a scoped Cloudflare API Token so the records this service generates can be published directly, instead of copied into a DNS panel."
    >
      {listed === "forbidden" ? (
        <PermissionState what="the Cloudflare connections" back={{ label: "All settings", href: "/settings" }} />
      ) : listed === null ? (
        <ErrorState what="the Cloudflare connections" detail="Nothing was changed. Retry to read them." />
      ) : (
        <DnsConnectionsBoard
          organizationId={ctx.active.id}
          connections={listed.connections}
          canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
          feature={feature}
          planLabel={planLabel}
        />
      )}
    </SettingsFrame>
  );
}
