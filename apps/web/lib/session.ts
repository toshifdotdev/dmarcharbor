import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError, listWorkspaces } from "./api";
import type { WorkspaceSummary } from "./types";

/** The ambient workspace choice, shared by the fetch-and-pick helper below and
 *  by callers that already hold the workspace list (the root page's session
 *  probe needs the list once, not twice). */
export async function pickActiveWorkspace(
  workspaces: WorkspaceSummary[],
): Promise<WorkspaceSummary | null> {
  const jar = await cookies();
  const wanted = jar.get("harbor.workspace")?.value;
  return workspaces.find((w) => w.id === wanted) ?? workspaces[0] ?? null;
}

/**
 * The active workspace is ambient context: a cookie, defaulting to the first
 * workspace the account can see. The portfolio renders regardless of which one
 * is active — context is never a gate.
 */
export async function resolveActiveWorkspace(): Promise<{
  workspaces: WorkspaceSummary[];
  active: WorkspaceSummary | null;
}> {
  let workspaces: WorkspaceSummary[];
  try {
    workspaces = await listWorkspaces();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      redirect("/sign-in");
    }
    throw error;
  }
  return { workspaces, active: await pickActiveWorkspace(workspaces) };
}
