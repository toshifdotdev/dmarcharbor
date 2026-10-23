import { cookies, headers } from "next/headers";
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
 * A return path is only ever a same-site path: "/domains/x", never
 * "//evil.example" or "https://…". Anything else is dropped, so the sign-in
 * page cannot be used as an open redirect.
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (raw.startsWith("/sign-in") || raw.startsWith("/sign-up")) return null;
  return raw.length > 512 ? null : raw;
}

/**
 * Where a signed-out request goes: the sign-in page, carrying the path it was
 * on. A session that expired while an operator was on a domain's evidence
 * brings them back to that domain after signing in, not to the portfolio.
 * The path comes from the proxy's x-harbor-path header.
 */
export async function signInRedirect(): Promise<never> {
  let path: string | null;
  try {
    path = safeNext((await headers()).get("x-harbor-path"));
  } catch {
    path = null;
  }
  redirect(path && path !== "/" ? `/sign-in?next=${encodeURIComponent(path)}` : "/sign-in");
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
      await signInRedirect();
    }
    throw error;
  }
  return { workspaces, active: await pickActiveWorkspace(workspaces) };
}
