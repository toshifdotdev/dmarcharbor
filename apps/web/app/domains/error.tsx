"use client";
/**
 * error.tsx — the domain evidence boundary. A throw in the domain detail
 * replaces THIS page only: the portfolio and every other route stay
 * reachable. It names what failed, says nothing was deleted, and offers the
 * retry beside the way back. It never names a cause it has not seen.
 */
import { RouteError } from "@/components/harbor/route-error";

export default function DomainsError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="This domain could not be shown."
      links={[
        { href: "/", label: "Back to the portfolio" },
        { href: "/clients", label: "Clients" },
      ]}
    >
      <p>
        The domain, its records and its reports are unchanged: reading its evidence failed. Trying again is safe.
      </p>
    </RouteError>
  );
}
