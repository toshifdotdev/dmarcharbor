import { redirect } from "next/navigation";
import Link from "next/link";
import { listClients } from "@/lib/api";
import { getWorkspaceEntitlements, listPortalAccess } from "@/lib/api-ops";
import { requestOrigin } from "@/lib/metadata-origin";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { PortalAccessPanel } from "@/components/portal-access-client";
import { ErrorState } from "@/components/data-states";

/**
 * Client portal access — the agency-side grants surface. The portal routes
 * (/portal, /portal/domain/[id]) already existed and could never be reached:
 * no grant could ever exist, so the paid feature was dead on arrival. This is
 * where a contact is granted, listed and revoked.
 *
 * The boundary is stated where the grant is made: a contact sees report
 * volume, sending sources and spoofing warnings, and never forensic data or
 * named recipients.
 */
export default async function PortalSettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const [clientsResult, grantsResult, entitlements] = await Promise.all([
    listClients(active.id)
      .then((rows) => ({ clients: rows, failed: false }))
      .catch(() => ({ clients: [], failed: true })),
    listPortalAccess(active.id)
      .then((r) => ({ grants: r.grants ?? [], failed: false }))
      .catch(() => ({ grants: [], failed: true })),
    getWorkspaceEntitlements(active.id).catch(() => null),
  ]);

  const allowPortal = entitlements?.features["portal.client"] === true;
  const origin = await requestOrigin();

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Client portal</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            A read-only portal for one client contact per client: report
            volume, sending sources and spoofing warnings, in your brand.
            Forensic data and named recipients are never shown there, no matter
            who asks.
          </p>
        </header>
        <SettingsNav current="portal" />

        {clientsResult.failed || grantsResult.failed ? (
          <ErrorState
            what="the portal access surface"
            detail="Grants and clients could not be loaded. Nothing was created or removed."
          />
        ) : !allowPortal ? (
          <section
            className="lift rounded-[2px] border p-5"
            style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
            data-feature="portal.client"
          >
            <h2 className="text-[16px] font-semibold tracking-[-0.012em]">Client portal</h2>
            <p className="mt-2 text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
              The client portal is not included in your current plan.
            </p>
            <Link
              href="/billing"
              className="mt-2 inline-block text-[13px] font-semibold underline"
              style={{ color: "var(--color-ink)" }}
            >
              See plan options
            </Link>
          </section>
        ) : (
          <PortalAccessPanel
            organizationId={active.id}
            clients={clientsResult.clients.map((c) => ({ id: c.id, name: c.name }))}
            grants={grantsResult.grants}
            origin={origin}
          />
        )}
      </div>
    </Shell>
  );
}
