import { LegacyLoading } from "@/components/legacy-boundary";

/** The client portal is still on the dark theme: its wait is dark too. */
export default function Loading() {
  return <LegacyLoading label="Loading the portal" />;
}
