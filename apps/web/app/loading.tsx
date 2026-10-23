import { LoadingState } from "@/components/ui/states";

/**
 * loading.tsx — pending UI for every route without a boundary of its own.
 *
 * It renders inside a data-harbor element on purpose. The paper ground exists
 * only while one is mounted (globals.css: body:has([data-harbor])); without it
 * the body falls back to the old dark ground, and a transition between two
 * light pages flashed black. The wrapper fills the viewport, so the paper is
 * there for the whole wait.
 *
 * Routes still on the old dark theme carry their own dark boundary, so they do
 * not flash light on the way in.
 */
export default function Loading() {
  return (
    <div data-harbor className="flex min-h-screen w-full flex-col bg-paper">
      <div className="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center px-6 py-16">
        <LoadingState label="Loading" />
      </div>
    </div>
  );
}
