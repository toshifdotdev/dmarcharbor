import type { Metadata } from "next";
import { listClients } from "@/lib/api";
import { listExports, OpsError } from "@/lib/api-ops";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { ExportBoard, type ExportView } from "@/components/harbor/settings/export";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { ErrorState, PermissionState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Data export" };

/**
 * /settings/export — owners and admins (organization:read), as erasure.
 *
 * An export holds the forensic reports, every member's sessions, the
 * invitations, the API keys and the audit trail, so it is not a report view
 * that every role may take (session 16).
 */
export default async function ExportPage() {
  const ctx = await settingsContext();
  const [listed, clients] = await Promise.all([
    listExports(ctx.active.id).catch((e: unknown) => (e instanceof OpsError && e.status === 403 ? ("forbidden" as const) : null)),
    listClients(ctx.active.id).catch(() => null),
  ]);

  const jobs: ExportView[] = (listed && listed !== "forbidden" ? listed.exports : []).map((j) => ({
    id: j.id,
    scopeLabel: j.scopeLabel,
    format: j.format,
    state: j.state,
    requestedLabel: instantLabel(j.createdAt),
    linkEndsLabel: j.downloadExpiresAt ? instantLabel(j.downloadExpiresAt) : null,
    downloadedLabel: j.downloadedAt ? instantLabel(j.downloadedAt) : null,
  }));

  return (
    <SettingsFrame
      ctx={ctx}
      section="export"
      lede="A complete copy of what this workspace holds, for a data-protection request, a migration, or your own records. Free on every plan."
    >
      {listed === "forbidden" ? (
        <PermissionState
          what="data export"
          detail="An export holds everyone's data in this workspace, so owners and admins request it. Ask one of them if a client has asked for a copy of their data."
          back={{ label: "All settings", href: "/settings" }}
        />
      ) : listed === null ? (
        <ErrorState what="the export list" detail="No export was requested or revoked. Retry to read the list." />
      ) : (
        <ExportBoard
          organizationId={ctx.active.id}
          jobs={jobs}
          linkDays={listed.linkDays}
          clients={(clients ?? []).map((c) => ({ id: c.id, name: c.name, domains: c.domains.map((d) => ({ id: d.id, name: d.name })) }))}
          canRevoke
        />
      )}
    </SettingsFrame>
  );
}
