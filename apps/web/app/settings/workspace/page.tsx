import { redirect } from "next/navigation";
import { getSessionUserId, listClients } from "@/lib/api";
import { listWorkspaceMembers } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import type { WorkspaceMemberRow } from "@/lib/types";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { WorkspaceDelete } from "@/components/workspace-delete";

/**
 * Workspace — identity at the top, deletion at the bottom, and nothing in
 * between that could be mistaken for either.
 *
 * The delete control is owner-only, decided from the member roster cross-checked
 * against the session user rather than from "this account created it". An admin
 * who can see the owner's row in the members list must not be shown the owner's
 * button; the API refuses them anyway, and a control that can only ever fail is
 * worse than no control.
 */
export default async function WorkspaceSettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const [userId, members, clientCount] = await Promise.all([
    getSessionUserId(),
    listWorkspaceMembers(active.id)
      .then((r) => r.members)
      .catch(() => [] as WorkspaceMemberRow[]),
    listClients(active.id).then((c) => c.length).catch(() => null),
  ]);

  const isOwner =
    userId !== null && members.some((member) => member.userId === userId && member.role === "owner");

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Workspace</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            The workspace your clients, domains and reports live in. Everything
            here belongs to everyone in it.
          </p>
        </header>

        <SettingsNav current="workspace" />

        <section
          className="lift rounded-[2px] border p-5"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
        >
          <h2 className="text-[16px] font-semibold tracking-[-0.012em]">Identity</h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            <div>
              <dt className="label">Name</dt>
              <dd className="mt-1 text-[14px]">{active.name}</dd>
            </div>
            <div>
              <dt className="label">Address</dt>
              <dd className="num mt-1 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                harbor.dmarcharbor.com/w/{active.slug}
              </dd>
            </div>
            <div>
              <dt className="label">Clients</dt>
              <dd className="num mt-1 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                {clientCount === null ? "unavailable" : clientCount}
              </dd>
            </div>
            <div>
              <dt className="label">Members</dt>
              <dd className="num mt-1 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                {members.length}
              </dd>
            </div>
          </dl>
        </section>

        <section
          className="lift rounded-[2px] border p-5"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
        >
          <h2 className="text-[16px] font-semibold tracking-[-0.012em]">Delete this workspace</h2>
          {isOwner ? (
            <>
              <p className="mt-1.5 max-w-3xl text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                For closing an account down, not for removing one client. This
                destroys every client, domain, report, scan, alert and key in the
                workspace for every member, and it cannot be undone. To offboard a
                single client, delete that client from the{" "}
                <a href="/clients" className="underline" style={{ color: "var(--color-ink)" }}>
                  clients page
                </a>{" "}
                instead.
              </p>
              <div className="mt-4 max-w-[520px]">
                <WorkspaceDelete organizationId={active.id} workspaceName={active.name} />
              </div>
            </>
          ) : (
            <p className="mt-1.5 max-w-3xl text-[13px]" style={{ color: "var(--color-ink-2)" }}>
              Only the workspace owner can delete it. Ask the owner if this account
              is being closed down — they will find these exact controls on this
              page.
            </p>
          )}
        </section>
      </div>
    </Shell>
  );
}
