import Link from "next/link";
import { listWorkspaceMembers } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav, SECTIONS } from "@/components/settings-nav";

/**
 * Settings hub. Each capability is its own section with its own route and its
 * own description, so this page is a directory rather than a wall of forms —
 * the brief's "independently understandable" applies to the whole surface.
 */
export default async function SettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) return null;

  const members = await listWorkspaceMembers(active.id)
    .then((r) => r.members ?? [])
    .catch(() => []);

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            Each capability has its own section. Pick the one you came for —
            every section explains itself and saves on its own.
          </p>
        </header>

        <SettingsNav current="hub" />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SECTIONS.map((s) => (
            <Link
              key={s.key}
              href={s.href}
              className="lift rounded-[2px] border p-4 transition-colors hover:bg-[var(--color-raised)]"
              style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
            >
              <div className="text-[15px] font-semibold" style={{ color: "var(--color-ink)" }}>
                {s.label}
              </div>
              <div className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: "var(--color-ink-3)" }}>
                {s.blurb}
              </div>
            </Link>
          ))}
        </div>

        <section
          className="lift rounded-[2px] border p-5"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
        >
          <h2 className="text-[15px] font-semibold tracking-[-0.012em]">
            Who is in this workspace
          </h2>
          <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
            {members.length} member{members.length === 1 ? "" : "s"} ·{" "}
            <Link href="/settings/members" className="underline" style={{ color: "var(--color-ink)" }}>
              open the members section
            </Link>{" "}
            for roles and permissions.
          </p>
        </section>
      </div>
    </Shell>
  );
}
