"use client";

/**
 * The portal's boundary. The reader is the agency's client: the wording says
 * the report failed to load, not that their email has a problem. The agency's
 * name is not known here (the read that carries it is what failed), so the
 * page names no one rather than guess.
 */

import { Button } from "@/components/ui/button";
import { Refresh } from "@/components/ui/icons";

export default function PortalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div data-harbor className="flex min-h-screen flex-col bg-paper">
      <header className="page-wrap">
        <div className="flex min-h-16 items-center py-3 sm:min-h-[72px]">
          <p className="text-[16px] text-fg-4 sm:text-[17px]">Client reports</p>
        </div>
        <div aria-hidden className="border-t border-rule" />
      </header>
      <main id="main" className="page-wrap flex flex-1 flex-col justify-center pb-24 pt-10">
        <div role="alert" className="max-w-[40rem]">
          <h1 className="text-[34px] font-[760] leading-[1] tracking-[-0.035em] text-fg [text-wrap:balance] sm:text-[46px]">
            Your report could not be shown.
          </h1>
          <p className="mt-5 text-[17px] leading-[1.55] text-fg-2 sm:text-[19px]">
            This is a problem loading the report, not a problem with your email. Trying again is safe.
          </p>
          <Button variant="primary" size="lg" onClick={reset} data-testid="state-retry" className="mt-8">
            <Refresh size={15} />
            Try again
          </Button>
        </div>
      </main>
    </div>
  );
}
