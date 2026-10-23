"use client";

import { SegmentError } from "@/components/segment-error";

/** Billing's boundary, on the dark theme the page is still on. */
export default function BillingError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SegmentError what="Billing" reset={reset} />;
}
