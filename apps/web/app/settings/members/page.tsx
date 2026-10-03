import { listWorkspaceMembers } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";

/**
 * Members — read-only roster plus the role model named in full. Five roles,
 * not four: owner, admin, analyst, viewer, portal. `portal` is a client
 * contact, not agency staff — it reads reports and nothing else (no forensic
 * access, no billing, no member management).
 *
 * Invitations, role changes and offboarding go through better-auth
 * organization endpoints and are a separate surface.
 */
const ROLE_BLURB: Record<string, string> = {
  owner: "full control, and the only role that can change the plan",
  admin: "day-to-day operation of the workspace",
  analyst: "measurement work; no forensic identities, no billing",
  viewer: "read-only",
  portal: "client contact — reads reports and nothing else",
};

export default async function MembersSettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) return null;

  const members = await listWorkspaceMembers(active.id)
    .then((r) => r.members ?? [])
    .catch(() => []);

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Members</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            Who can work in this workspace, and what each role may do. Reading
            reports and seeing who failed are separate permissions — one never
            implies the other.
          </p>
        </header>
        <SettingsNav current="members" />

        <section
          className="lift rounded-[2px] border"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
        >
          <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
            <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
              {members.length} member{members.length === 1 ? "" : "s"}
            </h2>
          </header>
          <ul>
            {members.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-5 py-3.5"
                style={{ borderColor: "rgba(255,255,255,0.055)" }}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px]" style={{ color: "var(--color-ink)" }}>
                    {m.user?.name ?? m.user?.email ?? m.userId}
                  </div>
                  <div className="text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                    {m.user?.email}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className="num text-[10.5px] tracking-[0.14em] uppercase"
                    style={{ color: "var(--color-accent)" }}
                  >
                    {m.role}
                  </div>
                  <div className="text-[11px]" style={{ color: "var(--color-ink-3)" }}>
                    {ROLE_BLURB[m.role] ?? ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {/* The role model named in full: a membership list only shows roles
              people hold, so a role like `portal` would otherwise be invisible
              exactly where someone needs to understand it. */}
          <div className="border-t px-5 py-4" style={{ borderColor: "var(--color-line)" }}>
            <div className="label">The five roles</div>
            <dl className="mt-2.5 grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
              {Object.entries(ROLE_BLURB).map(([role, blurb]) => (
                <div key={role} className="flex items-baseline gap-2.5">
                  <dt
                    className="num text-[10.5px] tracking-[0.14em] uppercase"
                    style={{ color: "var(--color-ink-2)", minWidth: 64 }}
                  >
                    {role}
                  </dt>
                  <dd className="text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
                    {blurb}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-2.5 text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
              <strong style={{ color: "var(--color-ink-2)" }}>portal</strong> is a
              client contact, not agency staff: it reads reports and nothing else —
              no forensic access, no billing, no member management.
            </p>
          </div>
        </section>
      </div>
    </Shell>
  );
}
