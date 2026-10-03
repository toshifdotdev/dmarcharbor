import { listClients } from "@/lib/api";
import { listExports } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { ExportPanel } from "@/components/export-client";

/**
 * Data export — a data-subject right, free on every plan. The API's lifecycle
 * is request → prepare → available → expire; the panel presents exactly that,
 * never as an instant download.
 */
export default async function ExportSettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) return null;

  const [clients, exportsRes] = await Promise.all([
    listClients(active.id).catch(() => []),
    listExports(active.id).catch(() => ({
      exports: [],
      linkDays: 7,
      recordRetentionDays: 400,
    })),
  ]);

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Data export</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            Request a copy of the data held in this workspace — for yourself or
            for a client's data-subject request. Free on every plan, always.
          </p>
        </header>
        <SettingsNav current="export" />
        <ExportPanel
          organizationId={active.id}
          jobs={exportsRes.exports ?? []}
          linkDays={exportsRes.linkDays ?? 7}
          clients={clients.map((c) => ({ id: c.id, name: c.name }))}
        />
      </div>
    </Shell>
  );
}
