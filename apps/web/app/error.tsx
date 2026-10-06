"use client";

import { SegmentError } from "@/components/segment-error";

/**
 * error.tsx — the boundary for every route in this app. One throw in any
 * server component replaces the PAGE, not the application: the header, the
 * footer and every other route stay reachable. lib/session.ts rethrows
 * non-401/403 API failures, so a blip here is a recoverable page, not a blank
 * one.
 */
export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SegmentError what="This page" reset={reset} />;
}
