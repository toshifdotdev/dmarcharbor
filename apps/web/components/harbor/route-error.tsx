"use client";

/**
 * route-error.tsx — the one body every error.tsx boundary renders.
 *
 * In the Routes language: the request is a line turned away at a short red
 * bar, the map's mark for something refused or failed. Red is the failure
 * itself, nothing decorative. Each boundary supplies only what is particular
 * to it: what could not be shown, what a failed read did NOT change, and the
 * ways back. Everything else is said the same way everywhere:
 *
 *   - it failed on our side, and retrying is safe;
 *   - Try again calls the boundary's `retry` (Next 16.3+), which re-fetches
 *     the segment from the server. `reset` only re-renders what is already
 *     in the browser, which can never recover a server render that threw;
 *   - the error's `digest` is shown as a reference an operator can quote, so
 *     support can find the failure in the server log. The error's message is
 *     never shown: in production a server error's message is a generic
 *     placeholder, and a browser error's message is not meant for a reader.
 *
 * No brand is named. A boundary is a client component and cannot read the
 * request's host, and on an agency's domain the name must be the agency's or
 * nothing; until the root layout hands the verified name down, it is nothing.
 *
 * The retry keeps data-testid="state-retry", which the clickthrough reads.
 */

import Link from "next/link";
import { useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Refresh } from "@/components/ui/icons";

/** The server log's identifier for this failure, when there is one. */
export function errorDigest(error: unknown): string | null {
  if (error && typeof error === "object" && "digest" in error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(digest)) return digest;
  }
  return null;
}

export function RouteError({
  error,
  retry,
  title,
  children,
  links,
  header,
  reportTo = "support",
}: {
  error: unknown;
  retry: () => void;
  /** What could not be shown, as a sentence: "Billing could not be shown." */
  title: string;
  /** What the failure did not change, and that retrying is safe. */
  children: ReactNode;
  /** The ways back, most useful first. */
  links: Array<{ href: string; label: string }>;
  /** A masthead above the message, for frames that keep one (the portal). */
  header?: ReactNode;
  /** Who the reader quotes the reference to. */
  reportTo?: string;
}) {
  const [pending, startTransition] = useTransition();
  const digest = errorDigest(error);

  return (
    <div data-harbor className="flex min-h-screen w-full flex-col bg-paper">
      {header}
      <main id="main" className="page-wrap flex flex-1 flex-col justify-center py-20">
        <div className="max-w-[38rem]">
          <svg viewBox="0 0 132 30" width="132" height="30" aria-hidden className="block overflow-visible">
            <path d="M12 15 H104" fill="none" stroke="var(--color-fg)" strokeWidth="5" strokeLinecap="round" />
            <circle cx="12" cy="15" r="7" fill="var(--color-paper)" stroke="var(--color-fg)" strokeWidth="3" />
            <rect x="112" y="3" width="5" height="24" rx="1.5" fill="var(--color-fail)" />
          </svg>
          <p role="alert" className="mt-6 text-[15px] font-bold text-fail">
            Something failed on our side
          </p>
          <h1 className="mt-3 text-[34px] font-[760] leading-[0.96] tracking-[-0.035em] text-fg [text-wrap:balance] sm:text-[46px]">
            {title}
          </h1>
          <div className="mt-5 text-[17px] leading-[1.5] text-fg-2">{children}</div>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
            <Button
              variant="primary"
              size="lg"
              onClick={() => startTransition(() => retry())}
              busy={pending}
              busyLabel="Trying again"
              data-testid="state-retry"
            >
              <Refresh size={15} />
              Try again
            </Button>
            {links.map((link) => (
              <Link key={link.href} href={link.href} className="link text-[16px] font-semibold">
                {link.label}
              </Link>
            ))}
          </div>
          {digest ? (
            <p className="mt-10 max-w-[34rem] border-t border-rule pt-4 text-[14px] leading-[1.5] text-fg-4">
              If it keeps failing, send this reference to {reportTo}: it finds this failure in the server log.
              <span className="mt-1.5 block">
                <span className="font-semibold text-fg-2">Reference</span>{" "}
                <span className="data select-all text-fg" data-testid="error-reference">
                  {digest}
                </span>
              </span>
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
