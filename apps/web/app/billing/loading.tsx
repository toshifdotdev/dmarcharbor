import { PageLoading } from "@/components/harbor/page-loading";

/** Pending UI for /billing, on the paper ground the page is on. */
export default function Loading() {
  return <PageLoading label="Reading billing" rows={6} />;
}
