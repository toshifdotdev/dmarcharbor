import { redirect } from "next/navigation";
import { listClients } from "@/lib/api";
import { listExports } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { ExportPanel } from "@/components/export-client";
import { ErrorState } from "@/components/data-states";

/**
 * Data export — a data-subject right, free on every plan. The API's lifecycle
 * is request → prepare → available → expire; the panel presents exactly that,
 * never as an instant download.
 */
export default async function ExportSettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const [clients, exportsRes] = await Promise.all([
    listClients(active.id).catch(() => []),
    listExports(active.id)
      .then((r) => ({
        exports: r.exports ?? [],
        linkDays: r.linkDays ?? 7,
        recordRetentionDays: r.recordRetentionDays ?? 400,
        failed: false,
      }))
      .catch(() => ({
        exports: [],
        linkDays: 7,
        recordRetentionDays: 400,
        failed: true,
      })),
  ]);

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Data export</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            Request a copy of the data held in this workspace: for yourself or
            for a client's data-subject request. Free on every plan, always.
          </p>
        </header>
        <SettingsNav current="export" />
        {exportsRes.failed ? (
          <ErrorState
            what="the export job list"
            detail="A prepared export is a data-subject request somebody is waiting on: an empty list here would hide it, not show there are none."
          />
        ) : (
          <ExportPanel
            organizationId={active.id}
            jobs={exportsRes.exports ?? []}
            linkDays={exportsRes.linkDays ?? 7}
            clients={clients.map((c) => ({ id: c.id, name: c.name }))}
          />
        )}
      </div>
    </Shell>
  );
}
