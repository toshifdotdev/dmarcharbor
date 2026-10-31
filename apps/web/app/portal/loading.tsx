import { LoadingState } from "@/components/ui/states";

/**
 * Pending UI for the client portal: the masthead's place held by its rule, and
 * the riding mark where the report will be. No operator chrome and no name:
 * the reader is the agency's client, and which agency is not known yet.
 */
export default function Loading() {
  return (
    <div data-harbor className="flex min-h-screen flex-col bg-paper">
      <div aria-hidden className="page-wrap">
        <div className="min-h-16 sm:min-h-[72px]" />
        <div className="border-t border-rule" />
      </div>
      <div className="page-wrap pt-12">
        <LoadingState label="Reading your report" rows={6} />
      </div>
    </div>
  );
}
