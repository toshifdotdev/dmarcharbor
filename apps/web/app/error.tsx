"use client";

/**
 * error.tsx — the boundary for every route without one of its own. One throw in
 * a server component replaces the PAGE, not the application. lib/session.ts
 * rethrows non-401/403 API failures, so a blip here is a recoverable page.
 *
 * On the paper ground (inside data-harbor), like the pages it stands in for;
 * the routes still on the dark theme carry their own boundary.
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
      <main className="mx-auto flex w-full max-w-[600px] flex-1 flex-col justify-center gap-4 px-6 py-16">
        <p role="alert" className="legend text-fail!">
          Something broke
        </p>
        <h1 className="display text-h1 text-fg">This page could not be shown.</h1>
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
            Back to the start
          </Link>
        </div>
      </main>
    </div>
  );
}
