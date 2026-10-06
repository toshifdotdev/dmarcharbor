import { redirect } from "next/navigation";
import { listPendingInvitations, listWorkspaceMembers } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { MembersManager } from "@/components/members-client";
import { ErrorState } from "@/components/data-states";
import type { WorkspaceInvitation } from "@/lib/types";

/**
 * Members — read-only roster plus the role model named in full. Five roles,
 * not four: owner, admin, analyst, viewer, portal. `portal` is a client
 * contact, not agency staff — it reads reports and nothing else (no forensic
 * access, no billing, no member management).
 *
 * Invitations, role changes and offboarding go through better-auth
 * organization endpoints and are a separate surface.
 *
 * A failed roster load is NOT "0 members": a workspace cannot audit who has
 * access while the list silently lies. Failure renders as failure with a
 * retry.
 */
const ROLE_BLURB: Record<string, string> = {
  owner: "full control, and the only role that can change the plan",
  admin: "day-to-day operation of the workspace",
  analyst: "measurement work; no forensic identities, no billing",
  viewer: "read-only",
  portal: "client contact: reads reports and nothing else",
};

export default async function MembersSettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const loaded = await Promise.all([
    listWorkspaceMembers(active.id)
      .then((r) => ({ members: r.members ?? [], failed: false }))
      .catch(() => ({ members: [], failed: true })),
    listPendingInvitations(active.id)
      .then((rows) => ({ invitations: rows ?? [], failed: false }))
      .catch(() => ({ invitations: [] as WorkspaceInvitation[], failed: false })),
  ]);
  const members = loaded[0].members;
  const invitations = loaded[1].invitations;

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Members</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            Who can work in this workspace, and what each role may do. Reading
            reports and seeing who failed are separate permissions: one never
            implies the other.
          </p>
        </header>
        <SettingsNav current="members" />

        {loaded[0].failed ? (
          <ErrorState
            what="the member list"
            detail="Who can work in this workspace is a question worth a correct answer: nothing here means we could not look, not that the workspace is empty."
          />
        ) : (
          <MembersManager
            organizationId={active.id}
            members={members}
            invitations={invitations}
          />
        )}

        {/* The role model named in full: a membership list only shows roles
            people hold, so a role like `portal` would otherwise be invisible
            exactly where someone needs to understand it. */}
        <section
          className="lift rounded-[2px] border"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
        >
          <div className="px-5 py-4">
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
              client contact, not agency staff: it reads reports and nothing else:
              no forensic access, no billing, no member management.
            </p>
          </div>
        </section>
      </div>
    </Shell>
  );
}
