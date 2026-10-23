import { LoadingState } from "@/components/ui/states";

/**
 * Pending UI for the client portal, on the paper ground the portal is on. No
 * operator chrome: the reader is the agency's client.
 */
export default function Loading() {
  return (
    <div data-harbor className="flex min-h-screen flex-col bg-paper">
      <div aria-hidden className="h-14 border-b border-rule" />
      <div className="mx-auto w-full max-w-[1040px] px-5 pt-10 sm:px-8">
        <LoadingState label="Reading your report" rows={6} />
      </div>
    </div>
  );
}
