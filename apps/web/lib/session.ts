import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError, listWorkspaces } from "./api";
import type { WorkspaceSummary } from "./types";

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
  const jar = await cookies();
  const wanted = jar.get("harbor.workspace")?.value;
  const active = workspaces.find((w) => w.id === wanted) ?? workspaces[0] ?? null;
  return { workspaces, active };
}
