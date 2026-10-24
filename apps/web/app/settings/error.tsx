"use client";

/**
 * The settings boundary. A throw in one section replaces that page only, and
 * says the one thing a person changing settings needs to hear: a failed read
 * changed nothing.
 */
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Refresh } from "@/components/ui/icons";

export default function SettingsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div data-harbor className="flex min-h-screen flex-col bg-paper">
      <main className="mx-auto flex w-full max-w-[600px] flex-1 flex-col justify-center gap-4 px-6 py-16">
        <p role="alert" className="legend text-fail!">
          Something broke
        </p>
        <h1 className="display text-h1 text-fg">This settings section could not be shown.</h1>
        <p className="text-body text-fg-2">
          Showing the section failed. A failed read changes no setting, and anything you saved before this is kept.
          Retrying is safe.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Button variant="primary" onClick={reset} data-testid="state-retry">
            <Refresh size={14} />
            Try again
          </Button>
          <Link href="/settings" className="link text-ui">
            All settings
          </Link>
          <Link href="/" className="link text-ui">
            Back to the portfolio
          </Link>
        </div>
      </main>
    </div>
  );
}
