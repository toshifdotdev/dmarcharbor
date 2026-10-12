import { LoadingState } from "@/components/data-states";

/**
 * loading.tsx — pending UI for the settings sections. A slow settings API
 * shows waiting, never a white screen: someone opening "who has access to
 * this account" should not watch nothing happen.
 */
export default function Loading() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-[320px]">
        <LoadingState label="Loading settings" />
      </div>
    </div>
  );
}
