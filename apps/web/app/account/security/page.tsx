import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/api";
import { getMySecurity } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { AppShell } from "@/components/harbor/app-shell";
import { PageHeader } from "@/components/harbor/page-header";
import { AccountSecurityBoard } from "@/components/harbor/security";
import { ErrorState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Two-step verification" };

/**
 * /account/security — a personal setting, outside every workspace.
 *
 * It reads /api/me/security and the workspace list, nothing else. The shell is
 * in account mode for the same reason: a workspace-scoped read would be refused
 * by the very requirement this page exists to satisfy, and would redirect the
 * browser back here in a loop.
 */
export default async function AccountSecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ required?: string }>;
}) {
  const { required } = await searchParams;
  const [{ workspaces, active }, security, user] = await Promise.all([
    resolveActiveWorkspace(),
    getMySecurity().catch(() => null),
    getSessionUser().catch(() => null),
  ]);

  if (!active) redirect("/welcome");

  return (
    <AppShell
      workspaces={workspaces}
      activeWorkspace={active}
      accountLevel
      trail={[{ label: "Account security" }]}
    >
      <div className="flex flex-col gap-7">
        <PageHeader
          title="Two-step verification"
          lede="Your account's second step, wherever you sign in. It belongs to you, not to a workspace; a workspace can require it, but only you can set it up."
        />
        {security ? (
          <AccountSecurityBoard
            initial={security}
            email={user?.email ?? null}
            requiredArrival={required === "1"}
          />
        ) : (
          <ErrorState
            what="your two-step verification settings"
            detail="Nothing was changed. Reload the page to try again."
          />
        )}
      </div>
    </AppShell>
  );
}
