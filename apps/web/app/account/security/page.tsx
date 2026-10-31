import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/api";
import { getMySecurity } from "@/lib/api-ops";
import { readHostBrand } from "@/lib/host-brand";
import { resolveActiveWorkspace } from "@/lib/session";
import { settingsGroupOf } from "@/lib/settings-map";
import { AppShell } from "@/components/harbor/app-shell";
import { brandName } from "@/components/harbor/public-frame";
import { AccountSecurityBoard } from "@/components/harbor/security";
import { SettingsRail } from "@/components/harbor/settings/rail";
import { ErrorState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Two-step verification" };

/**
 * /account/security — a personal setting, outside every workspace.
 *
 * It reads /api/me/security and the workspace list, nothing else. The shell is
 * in account mode for the same reason: a workspace-scoped read would be refused
 * by the very requirement this page exists to satisfy, and would redirect the
 * browser back here in a loop.
 *
 * It is laid out like every settings section, with the rail beside it, because
 * the settings index lists it there. The rail reads nothing. It is left out
 * when a workspace's requirement sent the person here: every link in it would
 * bounce them straight back until they finish.
 */
export default async function AccountSecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ required?: string }>;
}) {
  const { required } = await searchParams;
  const [{ workspaces, active }, security, user, hostBrand] = await Promise.all([
    resolveActiveWorkspace(),
    getMySecurity().catch(() => null),
    getSessionUser().catch(() => null),
    readHostBrand(),
  ]);

  if (!active) redirect("/welcome");
  const gated = required === "1";
  const group = settingsGroupOf("security");

  return (
    <AppShell
      workspaces={workspaces}
      activeWorkspace={active}
      accountLevel
      trail={[{ label: "Account security" }]}
    >
      <div className={gated ? "flex flex-col" : "grid gap-x-12 gap-y-6 lg:grid-cols-[212px_minmax(0,1fr)] xl:gap-x-16"}>
        {gated ? null : <SettingsRail current="security" currentLabel="Two-step verification" />}
        <div className="flex min-w-0 max-w-[1040px] flex-col gap-12">
          <header className="flex flex-col gap-2.5">
            <p className="text-meta text-fg-3">
              {gated ? (
                "Your account"
              ) : (
                <>
                  <Link href="/settings" className="font-semibold text-fg-2 hover:text-fg hover:underline">
                    Settings
                  </Link>
                  <span aria-hidden className="px-1.5 text-fg-4">
                    /
                  </span>
                  {group.title}
                </>
              )}
            </p>
            <h1 className="display text-h1 text-fg [text-wrap:balance]">Two-step verification</h1>
            <p className="max-w-[68ch] text-body text-fg-2">
              Your account&rsquo;s second step, wherever you sign in. It belongs to you, not to a workspace; a workspace can
              require it, but only you can set it up.
            </p>
          </header>
          {security ? (
            <AccountSecurityBoard
              initial={security}
              email={user?.email ?? null}
              requiredArrival={gated}
              serviceName={brandName(hostBrand)}
            />
          ) : (
            <ErrorState
              what="your two-step verification settings"
              detail="Nothing was changed. Reload the page to try again."
            />
          )}
        </div>
      </div>
    </AppShell>
  );
}
