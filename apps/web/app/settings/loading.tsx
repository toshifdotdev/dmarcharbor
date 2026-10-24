import { PageLoading } from "@/components/harbor/page-loading";

/** Pending UI for every settings section, on the paper ground they are on. */
export default function Loading() {
  return <PageLoading label="Reading settings" rows={6} />;
}
