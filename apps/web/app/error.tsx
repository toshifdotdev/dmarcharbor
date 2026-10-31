"use client";

/**
 * error.tsx — the boundary for every route without one of its own, public
 * pages included. One throw in a server component replaces the PAGE, not the
 * application. lib/session.ts rethrows non-401/403 API failures, so a blip
 * here is a recoverable page.
 *
 * The body is shared with every segment boundary (components/harbor/route-error.tsx):
 * Try again re-fetches through `retry`, and the digest is the reference.
 */

import { RouteError } from "@/components/harbor/route-error";

export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError error={error} retry={retry} title="This page could not be shown." links={[{ href: "/", label: "Back to the start" }]}>
      <p>Nothing was deleted or changed: showing this page failed. Trying again is safe.</p>
    </RouteError>
  );
}
