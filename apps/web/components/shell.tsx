/**
 * shell.tsx — the operator console frame.
 *
 * The workspace switcher is AMBIENT (context rule 2): the buyer is an MSP with
 * many clients, and the UI must never make someone ask "which client am I in"
 * before they can see anything. The portfolio is the front door; client and
 * workspace context lives in the topbar as quiet chrome, never as a gate.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import type { WorkspaceSummary } from "@/lib/types";
import { PierMark } from "@/components/mark";
import { SignOutButton } from "@/components/sign-out";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

export async function Shell({
  workspaces,
  activeWorkspace,
  children,
}: {
  workspaces: WorkspaceSummary[];
  activeWorkspace: WorkspaceSummary | null;
  children: React.ReactNode;
}) {
  if (!activeWorkspace) {
    // No workspace yet is an onboarding step, not an error.
    redirect("/welcome");
  }

  return (
    <div className="relative z-10 flex min-h-screen flex-col">
      <header
        className="flex items-center gap-6 border-b px-6 py-3"
        style={{ borderColor: "var(--color-line)" }}
      >
        <Link href="/" className="flex items-center gap-2.5" style={{ color: "var(--color-accent)" }}>
          <PierMark size={22} />
          <span
            className="text-[14px] font-semibold tracking-[-0.015em]"
            style={{ color: "var(--color-ink)" }}
          >
            DMARC Harbor
          </span>
        </Link>

        <nav className="flex items-center gap-5">
          <NavLink href="/">Portfolio</NavLink>
          <NavLink href="/reports">Reports</NavLink>
          <NavLink href="/trust">Trust</NavLink>
        </nav>

        <div className="ml-auto flex items-center gap-4">
          <WorkspaceSwitcher
            workspaces={workspaces}
            activeWorkspace={activeWorkspace}
          />
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-6 py-6">{children}</main>
    </div>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="text-[12.5px] font-medium transition-colors"
      style={{ color: "var(--color-ink-2)" }}
    >
      {children}
    </Link>
  );
}
