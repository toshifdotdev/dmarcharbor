import { LegacyLoading } from "@/components/legacy-boundary";

/**
 * loading.tsx — pending UI for the settings sections, on the dark theme they
 * are still on. A slow settings API shows waiting, never a blank screen.
 */
export default function Loading() {
  return <LegacyLoading label="Loading settings" />;
}
