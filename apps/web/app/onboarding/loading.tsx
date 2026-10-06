import { LoadingState } from "@/components/data-states";

/**
 * loading.tsx — pending UI for the onboarding funnel. The steps and the
 * generated record arrive from the API; waiting is the honest render.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 py-10">
      <LoadingState label="Loading the setup steps" />
    </div>
  );
}
