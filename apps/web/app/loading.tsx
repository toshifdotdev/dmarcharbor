import { LoadingState } from "@/components/data-states";

/**
 * loading.tsx — pending UI while a segment's server components stream in.
 * A slow page shows waiting (the Tide loader), never a white screen: a white
 * screen on a slow API reads as a broken app.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 py-12">
      <LoadingState label="Loading" />
    </div>
  );
}
