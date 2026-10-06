import { LoadingState } from "@/components/data-states";

/**
 * loading.tsx — pending UI for the domain detail. The evidence panels arrive
 * from several calls; a waiting state is the honest render while they do.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 py-10">
      <LoadingState label="Loading the domain" />
    </div>
  );
}
