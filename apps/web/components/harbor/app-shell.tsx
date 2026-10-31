/**
 * app-shell.tsx — the operator frame.
 *
 * Designed from what the operator does all day, not from a dashboard template:
 *
 * 1. They work in wide tables (every domain, every sender, every report), so
 *    the frame takes no width. Everything lives in two short rows across the
 *    top; the content gets the whole screen.
 *
 * 2. "Where am I" has one answer, read left to right as an address:
 *    workspace / client / domain. The workspace is the first segment and is
 *    also the switcher, because switching workspace is moving to a different
 *    root, not changing a setting.
 *
 * 3. They navigate by name more than by section: a client calls about one
 *    domain. Jump (Ctrl K, or "/") finds any domain, client, workspace or
 *    screen from anywhere.
 *
 * 4. "Does anything need me" must be answerable without opening a page: open
 *    alerts and unread notifications sit in the bar, read after paint, and a
 *    failed read says "not checked", never zero.
 *
 * 5. Conditions that change what the workspace can do (a superseded DPA, an
 *    unverified custom domain, a plan in trouble) are stated under the bar on
 *    every screen until they are resolved.
 *
 * Carried behaviour: no workspace redirects to /welcome; a verified custom
 * domain shows the agency's uploaded logo and name; BrandApplier recolours the
 * accent and primary actions; the DPA state is read on the server because the
 * API enforces it there.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { Fragment, type ReactNode } from "react";
import type { WorkspaceSummary } from "@/lib/types";
import { getSessionUser } from "@/lib/api";
import { getDpaAcceptance, getMySecurity } from "@/lib/api-ops";
import { readHostBrand, type HostBrand } from "@/lib/host-brand";
import { LEGAL_FOOTER_LINKS } from "@/lib/site-links";
import { PierMark } from "@/components/mark";
import { ToastProvider } from "@/components/ui/toast";
import { AccountMenu } from "./account-menu";
import { AssistantWidget } from "./assistant/assistant-widget";
import { brandName } from "./public-frame";
import { Jump } from "./jump";
import { SectionNav } from "./section-nav";
import { DpaBanner, HostUnverifiedBanner } from "./shell-banners";
import { PlanWatch, Watch } from "./watch";
import { WorkspaceMenu } from "./workspace-menu";

/** A segment of the address after the workspace. The last one is the page. */
export interface TrailItem {
  label: string;
  href?: string;
  /** Identifiers (domains) are set in the data face. */
  mono?: boolean;
}

export async function AppShell({
  workspaces,
  activeWorkspace,
  trail = [],
  accountLevel = false,
  children,
}: {
  workspaces: WorkspaceSummary[];
  activeWorkspace: WorkspaceSummary | null;
  trail?: TrailItem[];
  /**
   * Account screens are outside the workspace gate. They must not read DPA,
   * alerts or plan state, because those are workspace routes and a member who
   * has not enrolled would be redirected back to the page they are on.
   */
  accountLevel?: boolean;
  children: ReactNode;
}) {
  // No workspace yet is an onboarding step, not an error.
  if (!activeWorkspace) redirect("/welcome");

  // In parallel: the frame must not add a round trip per read.
  const [hostBrand, dpaOutOfDate, security, user] = await Promise.all([
    readHostBrand(),
    // A failed read renders nothing: failing to reach the agreement state is
    // not proof that the agreement is out of date.
    accountLevel
      ? Promise.resolve(null)
      : getDpaAcceptance(activeWorkspace.id)
          .then((a) => (a.requiresReconsent ? { acceptedVersion: a.version, currentVersion: a.currentVersion } : null))
          .catch(() => null),
    accountLevel ? Promise.resolve(null) : getMySecurity().catch(() => null),
    getSessionUser(),
  ]);

  /**
   * The API refuses every workspace route when a member has not enrolled, but
   * many page reads turn a failed fetch into an inline error state. Asking the
   * account-level endpoint here turns that into the one destination that can
   * fix it, without relying on each page to rethrow a redirect.
   */
  if (
    !accountLevel &&
    security &&
    security.requiredBy.some((workspace) => workspace.id === activeWorkspace.id) &&
    !security.twoFactorEnabled &&
    security.sessionAuthMethod !== "sso"
  ) {
    redirect("/account/security?required=1");
  }

  return (
    // --hb-dock is the corner the question launcher keeps: the footer gets that
    // much more room at the bottom and toasts rise above it (ui/toast.tsx).
    <div
      data-harbor
      data-host-brand={hostBrand.state}
      className={`flex min-h-screen flex-col ${accountLevel ? "" : "[--hb-dock:60px] sm:[--hb-dock:68px]"}`}
    >
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-cta px-4 py-2 text-ui font-semibold text-cta-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>

      {/* White and solid, never translucent: the bar is part of the page, not
          a pane floating over it. */}
      <header className="sticky top-0 z-30 border-b border-rule bg-paper">
        <div className="flex h-[52px] items-center gap-2 px-4 sm:gap-3 sm:px-6 lg:px-8">
          <Brand brand={hostBrand} />
          <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-rule" />

          <nav aria-label="Location" className="flex min-w-0 flex-1 items-center">
            <ol className="flex min-w-0 items-center gap-0.5">
              <li className="min-w-0 shrink-0">
                <WorkspaceMenu workspaces={workspaces} active={activeWorkspace} />
              </li>
              {trail.map((t, i) => {
                const last = i === trail.length - 1;
                return (
                  <Fragment key={`${t.label}-${i}`}>
                    <li aria-hidden className="hidden shrink-0 px-0.5 text-fg-4 lg:block">
                      /
                    </li>
                    <li className="hidden min-w-0 lg:block">
                      {t.href && !last ? (
                        <Link
                          href={t.href}
                          className={`block truncate rounded-full px-2.5 py-1 text-ui font-medium text-fg-2 hover:bg-paper-3 hover:text-fg ${t.mono ? "data" : ""}`}
                        >
                          {t.label}
                        </Link>
                      ) : (
                        <span
                          aria-current={last ? "page" : undefined}
                          className={`block truncate px-2.5 py-1 text-ui ${last ? "font-semibold text-fg" : "font-medium text-fg-2"} ${t.mono ? "data" : ""}`}
                        >
                          {t.label}
                        </span>
                      )}
                    </li>
                  </Fragment>
                );
              })}
            </ol>
          </nav>

          {accountLevel ? null : <Watch organizationId={activeWorkspace.id} />}
          {accountLevel ? null : (
            <Jump organizationId={activeWorkspace.id} workspaces={workspaces} activeId={activeWorkspace.id} />
          )}
          <AccountMenu name={user?.name ?? null} email={user?.email ?? null} />
        </div>

        <div className="px-4 sm:px-6 lg:px-8">
          <SectionNav />
        </div>

        {/* Narrow screens: the rest of the address gets its own line rather
            than being dropped. It is an answer, not decoration. */}
        {trail.length > 0 ? (
          <p className="truncate border-t border-rule px-4 py-1.5 text-meta text-fg-3 sm:px-6 lg:hidden">
            {trail.map((t, i) => (
              <Fragment key={i}>
                {i > 0 ? <span aria-hidden> / </span> : null}
                <span className={`${i === trail.length - 1 ? "font-semibold text-fg" : ""} ${t.mono ? "data" : ""}`}>{t.label}</span>
              </Fragment>
            ))}
          </p>
        ) : null}
      </header>

      {dpaOutOfDate ? (
        <DpaBanner
          organizationId={activeWorkspace.id}
          acceptedVersion={dpaOutOfDate.acceptedVersion}
          currentVersion={dpaOutOfDate.currentVersion}
        />
      ) : null}
      {hostBrand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      {accountLevel ? null : <PlanWatch organizationId={activeWorkspace.id} />}

      <ToastProvider>
        <main id="main" tabIndex={-1} className="w-full flex-1 px-4 pb-16 pt-6 outline-none sm:px-6 lg:px-8 lg:pt-7">
          {children}
        </main>
      </ToastProvider>

      <footer className="border-t border-rule px-4 pb-[calc(20px+var(--hb-dock,0px))] pt-5 sm:px-6 lg:px-8">
        <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-1.5 text-meta">
          {LEGAL_FOOTER_LINKS.map(([href, label]) => (
            <Link key={href} href={href} className="text-fg-3 hover:text-fg">
              {label}
            </Link>
          ))}
        </nav>
      </footer>

      {accountLevel ? null : <AssistantWidget organizationId={activeWorkspace.id} brand={brandName(hostBrand)} />}
    </div>
  );
}

/**
 * The Pier mark takes the accent through currentColor: ink for our own brand,
 * and a verified tenant's colour reaches it untouched. A tenant's uploaded logo
 * replaces it only on their verified domain; only a platform-served object
 * reaches the <img>.
 */
function Brand({ brand }: { brand: HostBrand }) {
  const branded = brand.state === "verified";
  const name = branded ? brand.workspaceName : "DMARC Harbor";
  return (
    <Link href="/" className="flex shrink-0 items-center gap-2.5 rounded-full text-act" aria-label={`${name}, portfolio`}>
      {branded && brand.logoUrl ? (
        <img src={brand.logoUrl} alt="" height={24} className="h-6 w-auto" />
      ) : (
        <PierMark size={22} />
      )}
      <span className="hidden text-[15.5px] font-bold tracking-[-0.01em] text-fg xl:block">{name}</span>
    </Link>
  );
}
