"use client";
/**
 * The digests boundary. The page renders its own failed state for a failed
 * list read (the clickthrough's "failed is not empty" proof reads it), so this
 * catches only what that cannot: a throw anywhere else in the render.
 */
import { RouteError } from "@/components/harbor/route-error";

export default function DigestsError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Digests could not be shown."
      links={[
        { href: "/", label: "Back to the portfolio" },
        { href: "/alerts", label: "Alerts" },
      ]}
    >
      <p>No digest was changed and none was sent or stopped: reading them failed. Trying again is safe.</p>
    </RouteError>
  );
}
