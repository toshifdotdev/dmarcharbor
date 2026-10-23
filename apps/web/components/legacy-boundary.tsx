import { LoadingState } from "@/components/data-states";

/**
 * legacy-boundary.tsx — the pending UI for routes still on the old dark theme
 * (portal, billing). Deliberately WITHOUT data-harbor: the dark ground is what
 * these pages paint, so their wait paints it too. Without a boundary of their
 * own they would use the root one, which is on paper, and flash light on the
 * way in. Delete with the last dark route.
 */
export function LegacyLoading({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-[320px]">
        <LoadingState label={label} />
      </div>
    </div>
  );
}
