import { PageLoading } from "@/components/harbor/page-loading";

/** Pending UI for a domain's setup page: the steps and the generated record. */
export default function Loading() {
  return <PageLoading label="Reading this domain's setup" rows={8} />;
}
