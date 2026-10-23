"use client";

/**
 * error.tsx — the setup page's boundary. A throw here (a slow verify call, a
 * dropped lookup) replaces THIS page only: the client list and the rest of the
 * app stay reachable, and the operator's domain has not gone anywhere.
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
    <div data-harbor>
      <main className="mx-auto flex min-h-[70vh] w-full max-w-[600px] flex-col justify-center gap-4 px-6 py-16">
        <p role="alert" className="legend text-fail!">
          Something broke
        </p>
        <h1 className="wide text-h1 font-bold tracking-[-0.02em]">This domain&rsquo;s setup could not be shown.</h1>
        <p className="text-body text-fg-2">
          The domain and its records are unchanged: this request failed. Retrying is safe, and the rest of the app is
          still reachable.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Button variant="primary" onClick={reset} data-testid="state-retry">
            <Refresh size={14} />
            Try again
          </Button>
          <Link href="/clients" className="link text-ui">
            Back to clients
          </Link>
        </div>
      </main>
    </div>
  );
}
