import { PageLoading } from "@/components/harbor/page-loading";

/** Pending UI for /clients, on the paper ground the page is on. */
export default function Loading() {
  return <PageLoading label="Reading the client list" rows={10} />;
}
