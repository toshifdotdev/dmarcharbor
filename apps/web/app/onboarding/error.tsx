"use client";

import { SegmentError } from "@/components/segment-error";

/**
 * error.tsx — the onboarding funnel's boundary. A failure in the funnel (a
 * slow verify call, a dropped lookup) replaces THIS page: the client list and
 * the rest of the app stay reachable, and the operator's domain is not gone.
 */
export default function OnboardingError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SegmentError what="This domain's setup" reset={reset} />;
}
