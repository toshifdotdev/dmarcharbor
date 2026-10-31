"use client";
/**
 * error.tsx — the setup page's boundary. A throw here (a slow verify call, a
 * dropped lookup) replaces THIS page only: the client list and the rest of the
 * app stay reachable, and the operator's domain has not gone anywhere.
 */
import { RouteError } from "@/components/harbor/route-error";

export default function OnboardingError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="This domain's setup could not be shown."
      links={[
        { href: "/clients", label: "Back to clients" },
        { href: "/", label: "Portfolio" },
      ]}
    >
      <p>The domain and its records are unchanged: reading its setup failed. Trying again is safe.</p>
    </RouteError>
  );
}
