"use client";

/**
 * The billing boundary. A throw here replaces this page only; nothing about
 * the plan or any payment was changed by a failed read.
 */

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Refresh } from "@/components/ui/icons";

export default function BillingError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div data-harbor className="flex min-h-screen flex-col bg-paper">
      <main className="mx-auto flex w-full max-w-[600px] flex-1 flex-col justify-center gap-4 px-6 py-16">
        <p role="alert" className="legend text-fail!">
          Something broke
        </p>
        <h1 className="display text-h1 text-fg">Billing could not be shown.</h1>
        <p className="text-body text-fg-2">
          The plan and any payment are unchanged: this request failed. Retrying is safe.
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
