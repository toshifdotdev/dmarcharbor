/**
 * artefact-frame.tsx — the frame for documents that leave the product: a
 * shared report a client contact opens, a Trust Center an auditor opens, a
 * prospect's email security check, the public document verifier.
 *
 * No marketing header, no sign-up button, no operator chrome: the reader has
 * no account and did not come to be sold to. The masthead is one line, set the
 * way the map labels a line: who published the document in bold (the agency's
 * own name and logo on its verified custom domain), and what the document is
 * beside it in a lighter weight. Print sits at the other end. The meta line
 * under it says what the reader is owed first: dates and scope.
 *
 * It prints as a document: the print control drops out, the masthead stays at
 * the top, and a closing line names who published it. The link itself is
 * never printed, because for a shared report the link is the key to it.
 *
 * Props are unchanged (kind, meta, children, testId, publisher), so the
 * verifier page that also uses this frame renders as before.
 */

import type { ReactNode } from "react";
import { readHostBrand } from "@/lib/host-brand";
import { chartBrandVars } from "@/lib/brand-vars";
import { PierMark } from "@/components/mark";
import { PrintButton } from "./legal-client";
import { HostUnverifiedBanner } from "./shell-banners";

/**
 * "Shared report" reads as "shared report" beside a name; a proper name such
 * as "Trust Center" keeps its capitals.
 */
function kindLabel(kind: string): string {
  return /^[A-Z][a-z]*(?: [a-z][\w-]*)*$/.test(kind) ? kind.charAt(0).toLowerCase() + kind.slice(1) : kind;
}

export async function ArtefactFrame({
  kind,
  meta,
  children,
  testId,
  publisher,
}: {
  /** What this document is, e.g. "Shared report". */
  kind: string;
  /** A short line under the masthead: dates, scope. */
  meta?: ReactNode;
  children: ReactNode;
  testId?: string;
  /**
   * The workspace that published the document, when the document says so
   * itself (a prospect report names its agency on any host). Its name always
   * heads the masthead; its logo and colours only when it is white-labelled.
   * Without it the masthead follows the host, as before.
   */
  publisher?: {
    workspaceName: string;
    logoUrl: string | null;
    primaryColor: string | null;
    accentColor: string | null;
    branded: boolean;
  };
}) {
  const brand = await readHostBrand();
  const hostBranded = brand.state === "verified";
  const name = publisher ? publisher.workspaceName : hostBranded ? brand.workspaceName : "DMARC Harbor";
  const logo = publisher ? (publisher.branded ? publisher.logoUrl : null) : hostBranded ? brand.logoUrl : null;
  // A document a workspace publishes under its own name carries that name, not
  // ours: the product mark appears only where the host is ours and unbranded.
  const showMark = !publisher && !hostBranded;
  const vars = publisher?.branded ? chartBrandVars(publisher.primaryColor, publisher.accentColor) : undefined;
  const label = kindLabel(kind);
  return (
    <div data-harbor data-host-brand={brand.state} data-testid={testId} style={vars} className="flex min-h-screen flex-col">
      {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      <header className="page-wrap print:max-w-none print:px-0">
        <div className="flex min-h-16 flex-wrap items-center gap-x-6 gap-y-2 py-3 sm:min-h-[72px]">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[16px] leading-[1.3] sm:text-[17px]">
            {logo ? (
              <img src={logo} alt="" height={28} className="h-7 w-auto max-w-[160px] object-contain" />
            ) : showMark ? (
              <PierMark size={22} className="shrink-0 text-fg" />
            ) : null}
            <span className="font-bold tracking-[-0.01em] text-fg">{name}</span>
            <span className="text-fg-4">{label}</span>
          </p>
          <span className="ml-auto">
            <PrintButton />
          </span>
        </div>
        <div className="border-t border-rule print:border-fg">
          {meta ? <p className="max-w-[80ch] py-3 text-[13.5px] leading-[1.45] text-fg-4 print:text-[9pt]">{meta}</p> : null}
        </div>
      </header>
      <main id="main" className="page-wrap flex-1 pb-24 pt-10 sm:pt-14 print:max-w-none print:px-0 print:pb-0 print:pt-6">
        {children}
      </main>
      <p className="page-wrap hidden pb-2 text-[9pt] text-fg-2 print:block print:max-w-none print:px-0">
        <span className="font-semibold text-fg">{name}</span> {label}. Printed from a read-only page.
      </p>
    </div>
  );
}
