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
import { readHostBrand } from "@/lib/host-brand";
import { PierMark } from "@/components/mark";
import { LEGAL_FOOTER_LINKS } from "@/components/marketing";
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

  // Custom-domain resolution: middleware resolves the Host header against
  // GET /api/branding/host (cached), and this is where the agency's brand
  // becomes real chrome. An unverified record says so plainly rather than
  // serving half-branded.
  const hostBrand = await readHostBrand();
  const branded = hostBrand.state === "verified";

  return (
    <div
      className="relative z-10 flex min-h-screen flex-col"
      data-host-brand={hostBrand.state}
    >
      {hostBrand.state === "unverified" ? (
        <div
          role="status"
          data-testid="host-unverified"
          className="border-b px-6 py-2 text-center"
          style={{
            borderColor: "var(--color-unverified)",
            background: "var(--color-unverified-soft)",
          }}
        >
          <p className="num text-[11px]" style={{ color: "var(--color-unverified)" }}>
            This custom domain is pointed here but its record is not verified yet —
            the default brand is shown instead of yours. Verify the TXT record to
            serve your branding from this address.
          </p>
        </div>
      ) : null}
      <header
        className="flex items-center gap-6 border-b px-6 py-3"
        style={{ borderColor: "var(--color-line)" }}
      >
        <Link href="/" className="flex items-center gap-2.5" style={{ color: "var(--color-accent)" }}>
          {branded && hostBrand.logoUrl ? (
            // Only a platform-served uploaded object ever reaches an <img>
            // here: a typed logo URL is filtered out server-side, and
            // rendering one would be a security bug.
            <img src={hostBrand.logoUrl} alt={`${hostBrand.workspaceName} logo`} height={22} />
          ) : (
            <PierMark size={22} />
          )}
          <span
            className="text-[15.5px] font-semibold tracking-[-0.015em]"
            style={{ color: "var(--color-ink)" }}
          >
            {hostBrand.workspaceName}
          </span>
        </Link>

        <nav className="flex items-center gap-5">
          <NavLink href="/">Portfolio</NavLink>
          <NavLink href="/clients">Clients</NavLink>
          <NavLink href="/alerts">Alerts</NavLink>
          <NavLink href="/digests">Digests</NavLink>
          <NavLink href="/settings">Settings</NavLink>
          <NavLink href="/billing">Billing</NavLink>
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

      {/* The legal surface, reachable from every screen — signed in or out.
          A footer that omits them is why nothing used to be reachable at all. */}
      <footer
        className="border-t px-6 py-4"
        style={{ borderColor: "var(--color-line)" }}
      >
        <nav aria-label="Legal" className="mx-auto flex w-full max-w-[1400px] flex-wrap items-baseline gap-x-5 gap-y-2 text-[11.5px]">
          {LEGAL_FOOTER_LINKS.map(([href, label]) => (
            <Link key={href} href={href} style={{ color: "var(--color-ink-3)" }}>
              {label}
            </Link>
          ))}
        </nav>
      </footer>
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
      className="text-[14px] font-medium transition-colors"
      style={{ color: "var(--color-ink-2)" }}
    >
      {children}
    </Link>
  );
}
