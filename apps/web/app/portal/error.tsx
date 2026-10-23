"use client";

import { SegmentError } from "@/components/segment-error";

/** The portal's boundary, on the dark theme the page is still on. */
export default function PortalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SegmentError what="The portal" reset={reset} />;
}
