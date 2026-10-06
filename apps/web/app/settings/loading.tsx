import { LoadingState } from "@/components/data-states";

/**
 * loading.tsx — pending UI for the settings sections. A slow settings API
 * shows waiting, never a white screen: someone opening "who has access to
 * this account" should not watch nothing happen.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 py-10">
      <LoadingState label="Loading settings" />
    </div>
  );
}
