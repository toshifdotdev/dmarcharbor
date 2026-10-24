import type { Metadata } from "next";
import { listClients } from "@/lib/api";
import { listErasures, OpsError, previewErasure } from "@/lib/api-ops";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { ErasureBoard, type ErasureView } from "@/components/harbor/settings/erasure";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { ErrorState, PermissionState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Erasure" };

/**
 * /settings/erasure — reading needs owner or admin (organization:read);
 * scheduling and cancelling are the owner's (organization:delete).
 */
export default async function ErasurePage() {
  const ctx = await settingsContext();
  const [listed, preview, clients] = await Promise.all([
    listErasures(ctx.active.id).catch((e: unknown) => (e instanceof OpsError && e.status === 403 ? ("forbidden" as const) : null)),
    previewErasure(ctx.active.id, "ORGANIZATION").catch(() => null),
    listClients(ctx.active.id).catch(() => null),
  ]);

  const clientName = new Map((clients ?? []).map((c) => [c.id, c.name]));
  const domainName = new Map((clients ?? []).flatMap((c) => c.domains.map((d) => [d.id, d.name] as const)));
  const requests: ErasureView[] =
    listed && listed !== "forbidden"
      ? listed.requests.map((r) => ({
          id: r.id,
          scope: r.scope,
          targetId: r.targetId,
          scopeLabel:
            r.scope === "ORGANIZATION"
              ? "The whole workspace"
              : r.scope === "CLIENT"
                ? `Client: ${clientName.get(r.targetId ?? "") ?? "a removed client"}`
                : `Domain: ${domainName.get(r.targetId ?? "") ?? "a removed domain"}`,
          state: r.state,
          reason: r.reason,
          requestedLabel: r.createdAt ? instantLabel(r.createdAt) : null,
          runsAfterLabel: instantLabel(r.purgeAfter),
        }))
      : [];

  return (
    <SettingsFrame
      ctx={ctx}
      section="erasure"
      lede="Permanently erase personal data for the whole workspace, one client, or one domain: for a client who leaves, or a data-protection request. Free on every plan."
    >
      {listed === "forbidden" ? (
        <PermissionState
          what="erasure"
          detail="Erasure is scheduled by the workspace owner, and reviewed by owners and admins. Ask the owner if a client has asked for their data to be erased."
          back={{ label: "All settings", href: "/settings" }}
        />
      ) : listed === null ? (
        <ErrorState what="the erasure requests" detail="Nothing was scheduled or cancelled. Retry to read them." />
      ) : (
        <ErasureBoard
          organizationId={ctx.active.id}
          initialPreview={preview}
          requests={requests}
          clients={(clients ?? []).map((c) => ({ id: c.id, name: c.name, domains: c.domains.map((d) => ({ id: d.id, name: d.name })) }))}
          isOwner={ctx.role === null ? null : ctx.role === "owner"}
        />
      )}
    </SettingsFrame>
  );
}
