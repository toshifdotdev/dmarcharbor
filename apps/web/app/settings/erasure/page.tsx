import { redirect } from "next/navigation";
import { listClients } from "@/lib/api";
import { listErasures, previewErasure } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { ErasurePanel } from "@/components/erasure-client";
import { ErrorState } from "@/components/data-states";

/**
 * Erasure — the destructive data-subject right. The page opens with the
 * API's own preview of what a request would do (built server-side, before
 * anything is touched), so the destructive nature is concrete rather than a
 * warning label. Free on every plan.
 *
 * A failed request list is NOT "no requests": this is the evidence trail for
 * data-subject rights, and a silent empty list would hide a request somebody
 * is waiting on.
 */
export default async function ErasureSettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const [clients, preview, erasuresRes] = await Promise.all([
    listClients(active.id).catch(() => []),
    previewErasure(active.id, "ORGANIZATION").catch(() => null),
    listErasures(active.id)
      .then((r) => ({
        requests: r.requests ?? [],
        certificateRetentionDays: r.certificateRetentionDays,
        failed: false,
      }))
      .catch(() => ({ requests: [], certificateRetentionDays: 1095, failed: true })),
  ]);

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Erasure</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            Erase personal data irreversibly: a data-subject right, free on
            every plan. The preview below is exactly what a request would do,
            before anything happens.
          </p>
        </header>
        <SettingsNav current="erasure" />
        {erasuresRes.failed ? (
          <ErrorState
            what="the erasure request list"
            detail="This is the evidence trail for data-subject rights: an empty list here would hide a request somebody is waiting on, not prove there are none."
          />
        ) : (
          <ErasurePanel
            organizationId={active.id}
            preview={preview}
            requests={erasuresRes.requests ?? []}
            clients={clients.map((c) => ({ id: c.id, name: c.name }))}
          />
        )}
      </div>
    </Shell>
  );
}
