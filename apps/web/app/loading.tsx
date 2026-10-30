import { LoadingState } from "@/components/ui/states";

/**
 * loading.tsx — pending UI for every route without a boundary of its own.
 *
 * It renders inside a data-harbor element so the accent and type tokens apply
 * while it waits, and it fills the viewport so the white ground is there for
 * the whole wait.
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
