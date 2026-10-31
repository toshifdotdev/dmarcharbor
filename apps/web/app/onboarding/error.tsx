"use client";

/**
 * error.tsx — the setup page's boundary. A throw here (a slow verify call, a
 * dropped lookup) replaces THIS page only: the client list and the rest of the
 * app stay reachable, and the operator's domain has not gone anywhere.
 *
 * Drawn like the app's own error page (app/error.tsx): the request is a line
 * turned away at a short red bar. The retry keeps data-testid="state-retry".
 */

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Refresh } from "@/components/ui/icons";

export default function OnboardingError({
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
          <h1 className="mt-3 text-[34px] font-[760] leading-[1] tracking-[-0.035em] text-fg [text-wrap:balance] sm:text-[44px]">
            This domain&rsquo;s setup could not be shown.
          </h1>
          <p className="mt-5 text-[17px] leading-[1.5] text-fg-2">
            The domain and its records are unchanged: this request failed. Retrying is safe, and the rest of the app is
            still reachable.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
            <Button variant="primary" size="lg" onClick={reset} data-testid="state-retry">
              <Refresh size={15} />
              Try again
            </Button>
            <Link href="/clients" className="link text-[16px] font-semibold">
              Back to clients
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
