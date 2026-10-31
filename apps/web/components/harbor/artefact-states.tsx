/**
 * artefact-states.tsx — what a document's address says when it has nothing
 * to show: a link that was withdrawn or has expired, or a page that could not
 * be fetched just now.
 *
 * The two must never read alike. A withdrawn link is drawn as a line ending
 * at a closed station (hollow and grey, the map's sign for a stop that is not
 * served); a failure to load has no drawing and says plainly that nothing is
 * wrong with the link. Wording and test ids are the callers'.
 */

import type { ReactNode } from "react";

export function DocumentUnavailable({
  title,
  children,
  closed,
  testId,
}: {
  title: ReactNode;
  children: ReactNode;
  /** The address no longer serves a document (withdrawn, expired, unknown). */
  closed?: boolean;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className="flex min-h-[48vh] max-w-[40rem] flex-col justify-center py-8">
      {closed ? <ClosedLine /> : null}
      <h1 className="text-[34px] font-[760] leading-[1] tracking-[-0.035em] text-fg [text-wrap:balance] sm:text-[46px]">
        {title}
      </h1>
      <div className="mt-5 max-w-[34rem] text-[17px] leading-[1.5] text-fg-2 sm:text-[19px]">{children}</div>
    </section>
  );
}

/** A line from its origin to a closed station. */
function ClosedLine() {
  return (
    <svg width="168" height="30" viewBox="0 0 168 30" aria-hidden className="mb-8 block">
      <path d="M12 15H146" stroke="var(--color-rule-2)" strokeWidth="5" strokeLinecap="round" strokeDasharray="0.1 10" />
      <path d="M12 15H92" stroke="var(--color-fg)" strokeWidth="5" strokeLinecap="round" />
      <circle cx="12" cy="15" r="7" fill="#ffffff" stroke="var(--color-fg)" strokeWidth="3" />
      <rect x="146" y="3" width="16" height="24" rx="8" fill="#ffffff" stroke="var(--color-rule-2)" strokeWidth="3" />
    </svg>
  );
}
