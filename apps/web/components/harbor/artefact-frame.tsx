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
import { PierMark } from "@/components/mark";
import { PrintButton } from "./legal-client";
import { HostUnverifiedBanner } from "./shell-banners";

export async function ArtefactFrame({
  kind,
  meta,
  children,
  testId,
}: {
  /** What this document is, e.g. "Shared report". */
  kind: string;
  /** A short line under the masthead: dates, scope. */
  meta?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const brand = await readHostBrand();
  const branded = brand.state === "verified";
  return (
    <div data-harbor data-host-brand={brand.state} data-testid={testId}>
      {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      <header className="border-b border-rule">
        <div className="mx-auto flex min-h-14 w-full max-w-[1120px] flex-wrap items-center gap-x-4 gap-y-2 px-5 py-2 sm:px-8">
          <span className="flex items-center gap-2.5 text-act">
            {branded && brand.logoUrl ? (
              <img src={brand.logoUrl} alt="" height={24} className="h-6 w-auto" />
            ) : branded ? null : (
              <PierMark size={24} />
            )}
            <span className="wide text-body font-bold text-fg">{branded ? brand.workspaceName : "DMARC Harbor"}</span>
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
