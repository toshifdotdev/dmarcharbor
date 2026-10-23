import { PageLoading } from "@/components/harbor/page-loading";

/** Pending UI for the domain detail: the evidence arrives from several calls. */
export default function Loading() {
  return <PageLoading label="Reading the domain's evidence" rows={10} />;
}
