import { redirect } from "next/navigation";
import { getSessionUserId } from "./api";
import { listWorkspaceMembers } from "./api-ops";
import { resolveActiveWorkspace } from "./session";
import { strongestRole } from "./settings-map";
import type { WorkspaceMemberRow, WorkspaceSummary } from "./types";

export interface SettingsContext {
  workspaces: WorkspaceSummary[];
  active: WorkspaceSummary;
  userId: string | null;
  /** The signed-in person's role here, or null when the roster did not load. */
  role: string | null;
  /** The roster, or null when it could not be read. Never an empty stand-in. */
  members: WorkspaceMemberRow[] | null;
}

/**
 * What every settings page needs before it can decide which controls to offer:
 * the workspace, and the role of the person looking at it.
 *
 * The role comes from the member roster cross-checked against the session user,
 * because the API decides permissions by role and a control the API will refuse
 * should be explained, not offered. When the roster fails the role is unknown,
 * and pages say so instead of guessing either way.
 */
export async function settingsContext(): Promise<SettingsContext> {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");
  const [members, userId] = await Promise.all([
    listWorkspaceMembers(active.id)
      .then((r) => r.members ?? [])
      .catch(() => null),
    getSessionUserId().catch(() => null),
  ]);
  const me = members && userId ? members.find((m) => m.userId === userId) : undefined;
  return { workspaces, active, userId, role: strongestRole(me?.role), members };
}
