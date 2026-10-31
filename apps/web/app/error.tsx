"use client";

/**
 * error.tsx — the boundary for every route without one of its own. One throw in
 * a server component replaces the PAGE, not the application. lib/session.ts
 * rethrows non-401/403 API failures, so a blip here is a recoverable page.
 *
 * In the Routes language: the request is a line that was turned away at a
 * short red bar, the map's mark for something refused or failed. Red here is
 * the failure itself, nothing decorative. The retry keeps
 * data-testid="state-retry", which the clickthrough suite reads.
 */

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Refresh } from "@/components/ui/icons";

export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div data-harbor className="flex min-h-screen w-full flex-col bg-paper">
      <main className="page-wrap flex flex-1 flex-col justify-center py-20">
        <div className="max-w-[36rem]">
          <svg viewBox="0 0 132 30" width="132" height="30" aria-hidden className="block overflow-visible">
            <path d="M12 15 H104" fill="none" stroke="var(--color-fg)" strokeWidth="5" strokeLinecap="round" />
            <circle cx="12" cy="15" r="7" fill="#ffffff" stroke="var(--color-fg)" strokeWidth="3" />
            <rect x="112" y="3" width="5" height="24" rx="1.5" fill="var(--color-fail)" />
          </svg>
          <p role="alert" className="mt-6 text-[15px] font-bold text-fail">
            Something broke
          </p>
          <h1 className="mt-3 text-[38px] font-[760] leading-[0.98] tracking-[-0.035em] text-fg [text-wrap:balance] sm:text-[48px]">
            This page could not be shown.
          </h1>
          <p className="mt-5 text-[17px] leading-[1.5] text-fg-2">
            Nothing was deleted or hidden: this request failed. Retrying is safe, and the rest of the app is still
            reachable.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
            <Button variant="primary" size="lg" onClick={reset} data-testid="state-retry">
              <Refresh size={15} />
              Try again
            </Button>
            <Link href="/" className="link text-[16px] font-semibold">
              Back to the start
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
