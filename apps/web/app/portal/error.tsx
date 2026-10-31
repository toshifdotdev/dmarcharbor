"use client";
/**
 * The portal's boundary. The reader is the agency's client: the wording says
 * the report failed to load, not that their email has a problem. The agency's
 * name is not known here (the read that carries it is what failed), so the
 * page names no one rather than guess, and the reference goes to "the company
 * that manages your email security", the portal's own name for them.
 */
import { RouteError } from "@/components/harbor/route-error";

export default function PortalError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Your report could not be shown."
      links={[]}
      reportTo="the company that manages your email security"
      header={
        <header className="page-wrap">
          <div className="flex min-h-16 items-center py-3 sm:min-h-[72px]">
            <p className="text-[16px] text-fg-4 sm:text-[17px]">Client reports</p>
          </div>
          <div aria-hidden className="border-t border-rule" />
        </header>
      }
    >
      <p>This is a problem loading the report, not a problem with your email. Trying again is safe.</p>
    </RouteError>
  );
}
