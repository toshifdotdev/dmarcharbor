/**
 * portal-frame.tsx — the frame of the client portal.
 *
 * The reader is the agency's client, so the frame is the agency's: its logo
 * and colours when its plan carries white-label (resolved by the API, which
 * only ever returns a logo the platform itself serves), its name always. No
 * operator chrome: no workspace menu, no section row, no jump palette.
 *
 * The masthead is set the way the map labels a line: the agency's name in
 * bold, "client reports" beside it in a lighter weight. The signed-in address
 * sits at the other end, so a shared computer is obvious.
 *
 * The foot states the two boundaries the reader is owed: what this portal does
 * not show (message-level detail), and that export and erasure of their data
 * are available at no cost.
 */

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import type { PortalBranding } from "@/lib/types";
import { chartBrandVars } from "@/components/brand-applier";
import { PierMark } from "@/components/mark";
import { PortalSignOut } from "./portal-client";

export function PortalFrame({
  brand,
  email,
  back,
  home = "/portal",
  children,
}: {
  brand: PortalBranding | null;
  /** The signed-in contact, shown so a shared computer is obvious. */
  email: string | null;
  back?: { href: string; label: string };
  /** The overview, carrying the provider for a contact with several. */
  home?: string;
  children: ReactNode;
}) {
  const agency = brand?.workspaceName ?? "Your provider";
  const vars = brand?.branded ? chartBrandVars(brand.primaryColor, brand.accentColor) : {};
  return (
    <div data-harbor data-surface="portal" style={vars as CSSProperties} className="flex min-h-screen flex-col bg-paper">
      <header className="page-wrap print:max-w-none print:px-0">
        <div className="flex min-h-16 flex-wrap items-center gap-x-6 gap-y-2 py-3 sm:min-h-[72px]">
          <Link
            href={home}
            className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md text-[16px] leading-[1.3] sm:text-[17px]"
          >
            {brand?.branded && brand.logoUrl ? (
              <img src={brand.logoUrl} alt="" height={28} className="h-7 w-auto max-w-[160px] object-contain" />
            ) : brand?.branded ? null : (
              <PierMark size={22} className="shrink-0 text-fg" />
            )}
            <span className="font-bold tracking-[-0.01em] text-fg">{agency}</span>
            <span className="text-fg-4">client reports</span>
          </Link>
          <div className="ml-auto flex min-w-0 items-center gap-3 print:hidden">
            {email ? <span className="data hidden truncate text-[13px] text-fg-4 md:inline">{email}</span> : null}
            <PortalSignOut />
          </div>
        </div>
        <div aria-hidden className="border-t border-rule print:border-fg" />
      </header>

      <main id="main" className="page-wrap flex-1 pb-24 pt-8 sm:pt-12 print:max-w-none print:px-0 print:pb-0 print:pt-6">
        {back ? (
          <Link
            href={back.href}
            className="mb-8 inline-flex items-center gap-1.5 text-[15px] font-semibold text-fg-2 transition-colors duration-150 hover:text-fg print:hidden"
          >
            <span aria-hidden>←</span> {back.label}
          </Link>
        ) : null}
        {children}
      </main>

      <footer className="page-wrap print:max-w-none print:px-0">
        <div className="flex flex-col gap-2 border-t border-rule pb-12 pt-8 text-[13.5px] leading-[1.55] text-fg-4 print:border-fg print:pb-0 print:text-[9pt]">
          <p className="max-w-[78ch]">
            {agency} monitors these domains for you. The figures come from reports that mail servers around the world
            send about email claiming to be from your domains.
          </p>
          <p className="max-w-[78ch]">
            Message-level detail (forensic reports, with the names of individual recipients) is not part of this portal.
            You can ask {agency} for an export or erasure of the data held about you: export and erasure are available at
            no cost, on every plan.
          </p>
          {!brand?.branded ? <p>Reports produced with DMARC Harbor.</p> : null}
        </div>
      </footer>
    </div>
  );
}

/** The page a contact sees when the portal cannot show them anything. */
export function PortalNotice({
  brand,
  email,
  title,
  children,
}: {
  brand: PortalBranding | null;
  email: string | null;
  title: string;
  children: ReactNode;
}) {
  return (
    <PortalFrame brand={brand} email={email}>
      <div className="flex min-h-[46vh] max-w-[40rem] flex-col justify-center py-6">
        <h1 className="text-[34px] font-[760] leading-[1] tracking-[-0.035em] text-fg [text-wrap:balance] sm:text-[46px]">{title}</h1>
        <div className="mt-5 text-[17px] leading-[1.55] text-fg-2">{children}</div>
      </div>
    </PortalFrame>
  );
}

/**
 * The provider's plan no longer includes the client portal (API: PORTAL_PAUSED).
 * The contact is the provider's client, so the page names the provider and
 * never a plan or a price, and says plainly that nothing was taken away.
 */
export function PortalPaused({ email, provider }: { email: string | null; provider: string | null }) {
  const who = provider ?? "Your provider";
  return (
    <PortalNotice brand={null} email={email} title="This report is paused">
      <p data-testid="portal-paused">
        {who} has paused the reports shared through this page. Your access is kept: when they turn reports back on, this
        page shows them again with nothing to set up. If you need a report before then, ask {provider ?? "them"} directly.
      </p>
    </PortalNotice>
  );
}
