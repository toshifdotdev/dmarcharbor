"use client";

/**
 * error.tsx — the domain evidence boundary, in the Routes language. A throw in the
 * domain detail replaces THIS page only: the portfolio and every other route
 * stay reachable. It names what failed, says nothing was deleted, and offers
 * the retry beside the way back. It never names a cause it has not seen.
 */

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Refresh } from "@/components/ui/icons";

export default function DomainsError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div data-harbor>
      <main className="mx-auto flex min-h-[70vh] w-full max-w-[600px] flex-col justify-center gap-4 px-6 py-16">
        <p role="alert" className="legend text-fail!">
          Something broke
        </p>
        <h1 className="display text-h1 text-fg">This domain could not be shown.</h1>
        <p className="text-body text-fg-2">
          Nothing was deleted or hidden: this request failed. Retrying is safe, and the rest of the app is still
          reachable.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Button variant="primary" onClick={reset} data-testid="state-retry">
            <Refresh size={14} />
            Try again
          </Button>
          <Link href="/" className="link text-ui">
            Back to the portfolio
          </Link>
        </div>
      </main>
    </div>
  );
}
