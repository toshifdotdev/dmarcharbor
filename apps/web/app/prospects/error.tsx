"use client";
/**
 * The prospect reports boundary (the agency side). A failed read here changes
 * no report, and a link already sent to a prospect keeps working.
 */
import { RouteError } from "@/components/harbor/route-error";

export default function ProspectsError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Prospect reports could not be shown."
      links={[
        { href: "/", label: "Back to the portfolio" },
        { href: "/clients", label: "Clients" },
      ]}
    >
      <p>
        No report was changed, and links you have already sent keep working: reading the list failed. Trying again is
        safe.
      </p>
    </RouteError>
  );
}
