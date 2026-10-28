/**
 * artefact-frame.tsx — the frame for documents that leave the product: a
 * shared report a client contact opens, a Trust Center an auditor opens.
 *
 * No marketing header, no sign-up button, no operator chrome: the reader has
 * no account and did not come to be sold to. A masthead names who published
 * the document (the agency's own name on its verified custom domain), what the
 * document is, and offers print; the page prints as a document with its
 * address at the foot.
 */

import type { ReactNode } from "react";
import { readHostBrand } from "@/lib/host-brand";
import { chartBrandVars } from "@/lib/brand-vars";
import { PierMark } from "@/components/mark";
import { PrintButton } from "./legal-client";
import { HostUnverifiedBanner } from "./shell-banners";

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
  return (
    <div data-harbor data-host-brand={brand.state} data-testid={testId} style={vars}>
      {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      <header className="border-b border-rule">
        <div className="mx-auto flex min-h-14 w-full max-w-[1120px] flex-wrap items-center gap-x-4 gap-y-2 px-5 py-2 sm:px-8">
          <span className="flex items-center gap-2.5 text-act">
            {logo ? (
              <img src={logo} alt="" height={24} className="h-6 w-auto" />
            ) : showMark ? (
              <PierMark size={24} />
            ) : null}
            <span className="wide text-body font-bold text-fg">{name}</span>
          </span>
          <span aria-hidden className="h-5 w-px bg-rule-2" />
          <span className="legend text-fg-2!">{kind}</span>
          <span className="ml-auto">
            <PrintButton />
          </span>
        </div>
        {meta ? (
          <div className="mx-auto w-full max-w-[1120px] px-5 pb-2 text-meta text-fg-3 sm:px-8">{meta}</div>
        ) : null}
      </header>
      <main id="main" className="mx-auto w-full max-w-[1120px] px-5 pb-20 pt-10 sm:px-8">
        {children}
      </main>
    </div>
  );
}
