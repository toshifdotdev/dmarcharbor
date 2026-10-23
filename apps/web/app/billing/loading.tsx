import { LegacyLoading } from "@/components/legacy-boundary";

/** Billing is still on the dark theme: its wait is dark too. */
export default function Loading() {
  return <LegacyLoading label="Loading billing" />;
}
