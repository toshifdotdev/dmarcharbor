import { LoadingState } from "@/components/data-states";

/**
 * loading.tsx — pending UI while a segment's server components stream in.
 * A slow page shows waiting (the Tide loader), never a white screen: a white
 * screen on a slow API reads as a broken app.
 *
 * Full viewport height and centred. The loader used to sit at the top of the
 * page in a bordered box, which reads as a fragment that failed to load rather
 * than a page that is waiting: a centred mark in the middle of the viewport is
 * the one position that is unambiguously "still working on it".
 */
export default function Loading() {
  return (
    <div className="flex min-h-[70vh] w-full items-center justify-center px-6 py-12">
      <div className="w-full max-w-[320px]">
        <LoadingState label="Loading" />
      </div>
    </div>
  );
}
