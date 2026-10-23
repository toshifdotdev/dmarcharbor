"use client";

/**
 * refresh-button.tsx — re-read this screen's data from the API, in place.
 *
 * A server refresh, not a reload: the shell, scroll position and any open
 * filter state survive, and the button reports that it is working.
 */

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Refresh } from "@/components/ui/icons";

export function RefreshButton({ label = "Refresh" }: { label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button variant="secondary" size="sm" busy={pending} busyLabel="Refreshing" onClick={() => start(() => router.refresh())}>
      <Refresh size={13} />
      {label}
    </Button>
  );
}
