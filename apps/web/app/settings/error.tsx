"use client";

import { SegmentError } from "@/components/segment-error";

/**
 * error.tsx — the settings segment's boundary. A failure in one settings
 * section must leave the rest of the app reachable: this replaces the SECTION,
 * not the application. The sidebar, the header and every other route stay
 * where they are, and the reader can retry or walk away to the portfolio.
 */
export default function SettingsError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SegmentError what="This settings section" reset={reset} />;
}
