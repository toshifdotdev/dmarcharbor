import { PageLoading } from "@/components/harbor/page-loading";

/** Pending UI for /digests, on the paper ground the page is on. */
export default function Loading() {
  return <PageLoading label="Reading the scheduled digests" rows={6} />;
}
