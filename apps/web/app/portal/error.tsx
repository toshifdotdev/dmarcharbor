"use client";

/**
 * The portal's boundary. The reader is the agency's client: the wording says
 * the report failed to load, not that their email has a problem.
 */

import { Button } from "@/components/ui/button";
import { Refresh } from "@/components/ui/icons";

export default function PortalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div data-harbor className="flex min-h-screen flex-col bg-paper">
      <main className="mx-auto flex w-full max-w-[600px] flex-1 flex-col justify-center gap-4 px-6 py-16">
        <p role="alert" className="legend">
          Client reports
        </p>
        <h1 className="display text-h1 text-fg">Your report could not be shown.</h1>
        <p className="text-body text-fg-2">
          This is a problem loading the report, not a problem with your email. Trying again is safe.
        </p>
        <Button variant="primary" onClick={reset} data-testid="state-retry" className="self-start">
          <Refresh size={14} />
          Try again
        </Button>
      </main>
    </div>
  );
}
