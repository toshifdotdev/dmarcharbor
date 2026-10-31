"use client";

/**
 * session-ended.tsx — what a refused action says when the API answered 401:
 * the session ended while the page was open (signed out elsewhere, revoked,
 * or simply expired). The page itself still renders from its last read, so
 * the one useful thing is a way to sign in that comes straight back here.
 *
 * A client component only because the return address is the current path;
 * the sign-in page accepts it as `next` (lib/session.ts safeNext).
 */

import { usePathname } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

export function SessionEndedNotice({ className }: { className?: string }) {
  const pathname = usePathname();
  const href = pathname && pathname !== "/" ? `/sign-in?next=${encodeURIComponent(pathname)}` : "/sign-in";
  return (
    <Notice
      tone="warn"
      title="Your session has ended"
      testId="session-ended"
      className={className}
      action={
        <ButtonLink href={href} size="sm">
          Sign in again
        </ButtonLink>
      }
    >
      Nothing was changed. Sign in again to carry on; you will come back to this page.
    </Notice>
  );
}
