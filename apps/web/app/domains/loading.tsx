import { LoadingState } from "@/components/data-states";

/**
 * loading.tsx — pending UI for the domain detail. The evidence panels arrive
 * from several calls; a waiting state is the honest render while they do.
 */
export default function Loading() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-[320px]">
        <LoadingState label="Loading the domain" />
      </div>
    </div>
  );
}
