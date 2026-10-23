/**
 * portal-frame.tsx — the frame of the client portal.
 *
 * The reader is the agency's client, so the frame is the agency's: its logo
 * and colours when its plan carries white-label (resolved by the API, which
 * only ever returns a logo the platform itself serves), its name always. No
 * operator chrome: no workspace menu, no section row, no jump palette.
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
  children,
}: {
  brand: PortalBranding | null;
  /** The signed-in contact, shown so a shared computer is obvious. */
  email: string | null;
  back?: { href: string; label: string };
  children: ReactNode;
}) {
  const agency = brand?.workspaceName ?? "Your provider";
  const vars = brand?.branded ? chartBrandVars(brand.primaryColor, brand.accentColor) : {};
  return (
    <div data-harbor data-surface="portal" style={vars as CSSProperties} className="flex min-h-screen flex-col bg-paper">
      <header className="border-b border-rule print:border-fg">
        <div className="mx-auto flex min-h-14 w-full max-w-[1040px] flex-wrap items-center gap-x-4 gap-y-2 px-5 py-2 sm:px-8">
          <Link href="/portal" className="flex items-center gap-2.5 text-act">
            {brand?.branded && brand.logoUrl ? (
              <img src={brand.logoUrl} alt="" height={26} className="h-[26px] w-auto" />
            ) : brand?.branded ? null : (
              <PierMark size={24} />
            )}
            <span className="wide text-body font-bold text-fg">{agency}</span>
          </Link>
          <span aria-hidden className="hidden h-5 w-px bg-rule-2 sm:block" />
          <span className="legend hidden text-fg-2! sm:inline">Client reports</span>
          <div className="ml-auto flex items-center gap-3 print:hidden">
            {email ? <span className="data hidden text-meta text-fg-3 md:inline">{email}</span> : null}
            <PortalSignOut />
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-[1040px] flex-1 px-5 pb-16 pt-8 sm:px-8 sm:pt-10">
        {back ? (
          <Link href={back.href} className="link mb-5 inline-block text-ui font-semibold print:hidden">
            ← {back.label}
          </Link>
        ) : null}
        {children}
      </main>

      <footer className="border-t border-rule">
        <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-1.5 px-5 py-5 text-meta text-fg-3 sm:px-8">
          <p>
            {agency} monitors these domains for you. The figures come from reports that mail servers around the world
            send about email claiming to be from your domains.
          </p>
          <p>
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
      <div className="flex min-h-[46vh] max-w-[62ch] flex-col justify-center gap-3">
        <p className="legend">Client reports</p>
        <h1 className="display text-h1 text-fg">{title}</h1>
        <div className="text-body text-fg-2">{children}</div>
      </div>
    </PortalFrame>
  );
}
