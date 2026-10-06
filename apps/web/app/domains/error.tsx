"use client";

import { SegmentError } from "@/components/segment-error";

/**
 * error.tsx — the domain evidence screens' boundary. A throw in the domain
 * detail (one slow insights call is enough) replaces THIS page: the portfolio
 * and every other route stay reachable.
 */
export default function DomainsError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SegmentError what="This domain" reset={reset} />;
}
