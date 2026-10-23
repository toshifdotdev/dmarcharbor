import { PageLoading } from "@/components/harbor/page-loading";

/** Pending UI for /alerts, on the paper ground the page is on. */
export default function Loading() {
  return <PageLoading label="Reading alerts and rules" rows={8} />;
}
