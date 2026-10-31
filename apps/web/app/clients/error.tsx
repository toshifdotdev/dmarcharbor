"use client";
/**
 * The clients boundary: the client list, monthly reports and the switch
 * planner. A failed read here changes no client, domain or report.
 */
import { RouteError } from "@/components/harbor/route-error";

export default function ClientsError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="This client page could not be shown."
      links={[
        { href: "/", label: "Back to the portfolio" },
        { href: "/clients", label: "All clients" },
      ]}
    >
      <p>No client, domain or report was changed: reading them failed. Trying again is safe.</p>
    </RouteError>
  );
}
