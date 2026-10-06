"use client";

/**
 * segment-error.tsx — the recoverable error body every segment boundary
 * re-exports. One throw in a server component must leave the rest of the app
 * reachable: this page names what failed, says plainly that nothing was
 * deleted, and offers the recovery (retry the segment) beside the safe route
 * back (the portfolio). Never names a cause we have not seen.
 */
import Link from "next/link";

export function SegmentError({
  what,
  reset,
}: {
  what: string;
  reset: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-[560px] flex-col items-start justify-center gap-4 px-6 py-16">
      <p className="label" role="alert">
        Something broke
      </p>
      <h1
        className="text-[25.5px] font-semibold tracking-[-0.03em]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {what} could not be shown.
      </h1>
      <p className="text-[14px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
        Nothing was deleted or hidden: this request failed. Retrying is safe,
        and the rest of the app is still reachable.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={reset}
          data-testid="state-retry"
          className="rounded-[2px] px-5 py-2.5 text-[13.5px] font-semibold"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
        >
          Try again
        </button>
        <Link href="/" className="text-[13.5px] underline" style={{ color: "var(--color-ink-2)" }}>
          Back to the portfolio
        </Link>
      </div>
    </div>
  );
}
