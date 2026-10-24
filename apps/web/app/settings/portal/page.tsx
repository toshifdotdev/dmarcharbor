import type { Metadata } from "next";
import { listClients } from "@/lib/api";
import { getBranding, getWorkspaceEntitlements, listPortalAccess } from "@/lib/api-ops";
import { featureOf } from "@/lib/entitlements";
import { instantLabel } from "@/lib/instant";
import { requestOrigin } from "@/lib/metadata-origin";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import { PlanUnknown } from "@/components/harbor/plan-refusal";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { PortalBoard, type GrantView } from "@/components/harbor/settings/portal";
import { ErrorState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Client portal access" };

/** /settings/portal — grants per client; reading needs client:read (every role). */
export default async function PortalAccessPage() {
  const ctx = await settingsContext();
  const [clients, access, entitlements, branding, origin] = await Promise.all([
    listClients(ctx.active.id).catch(() => null),
    listPortalAccess(ctx.active.id).catch(() => null),
    getWorkspaceEntitlements(ctx.active.id).catch(() => null),
    getBranding(ctx.active.id).catch(() => null),
    requestOrigin(),
  ]);
  const host = branding?.customDomain && branding.customDomainVerifiedAt ? `https://${branding.customDomain}` : origin;

  const grants: GrantView[] = (access?.grants ?? []).map((g) => ({
    id: g.id,
    clientId: g.clientId,
    clientName: g.clientName,
    email: g.email,
    displayName: g.displayName,
    active: g.active,
    firstSeenLabel: g.firstSeenAt ? instantLabel(g.firstSeenAt) : null,
    grantedLabel: instantLabel(g.createdAt),
  }));

  return (
    <SettingsFrame
      ctx={ctx}
      section="portal"
      lede="Give a client's own people a read-only view of their domains. The decision is who sees a client's results: each grant is one email address and one client."
    >
      {entitlements === null ? <PlanUnknown what="the client portal" /> : null}
      {clients === null || access === null ? (
        <ErrorState what={clients === null ? "the client list" : "the portal access list"} detail="No access was changed. Retry to read it." />
      ) : (
        <PortalBoard
          organizationId={ctx.active.id}
          clients={clients.map((c) => ({ id: c.id, name: c.name, domainCount: c.domains.length }))}
          grants={grants}
          canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
          granting={featureOf(entitlements, "portal.client")}
          portalUrl={`${host}/portal`}
        />
      )}
    </SettingsFrame>
  );
}
