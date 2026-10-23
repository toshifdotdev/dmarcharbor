import { PageLoading } from "@/components/harbor/page-loading";

/** Pending UI for /notifications, on the paper ground the page is on. */
export default function Loading() {
  return <PageLoading label="Reading the inbox" rows={6} />;
}
