import { LoadingState } from "@/components/ui/states";

/**
 * page-loading.tsx — the pending UI for an app route: the white ground, a band
 * where the shell's two bars sit (52px and 40px, plus the hairline), and the
 * waiting mark with rule lines holding the content's height.
 */
export function PageLoading({ label, rows = 8 }: { label: string; rows?: number }) {
  return (
    <div data-harbor className="min-h-screen bg-paper">
      <div aria-hidden className="h-[93px] border-b border-rule" />
      <div className="w-full px-4 pt-7 sm:px-6 lg:px-8">
        <LoadingState label={label} rows={rows} />
      </div>
    </div>
  );
}
