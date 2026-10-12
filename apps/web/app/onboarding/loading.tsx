import { LoadingState } from "@/components/data-states";

/**
 * loading.tsx — pending UI for the onboarding funnel. The steps and the
 * generated record arrive from the API; waiting is the honest render.
 */
export default function Loading() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-[320px]">
        <LoadingState label="Loading the setup steps" />
      </div>
    </div>
  );
}
