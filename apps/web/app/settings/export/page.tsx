import type { Metadata } from "next";
import { listClients } from "@/lib/api";
import { listExports } from "@/lib/api-ops";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { ExportBoard, type ExportView } from "@/components/harbor/settings/export";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { ErrorState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Data export" };

/** /settings/export — every role may request one (report:read). */
export default async function ExportPage() {
  const ctx = await settingsContext();
  const [listed, clients] = await Promise.all([
    listExports(ctx.active.id).catch(() => null),
    listClients(ctx.active.id).catch(() => null),
  ]);

  const jobs: ExportView[] = (listed?.exports ?? []).map((j) => ({
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
      {listed === null ? (
        <ErrorState what="the export list" detail="No export was requested or revoked. Retry to read the list." />
      ) : (
        <ExportBoard
          organizationId={ctx.active.id}
          jobs={jobs}
          linkDays={listed.linkDays}
          clients={(clients ?? []).map((c) => ({ id: c.id, name: c.name, domains: c.domains.map((d) => ({ id: d.id, name: d.name })) }))}
          canRevoke={ctx.role === null || ["owner", "admin", "analyst"].includes(ctx.role)}
        />
      )}
    </SettingsFrame>
  );
}
