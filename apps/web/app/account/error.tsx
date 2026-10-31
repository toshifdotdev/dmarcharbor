"use client";
/**
 * The account boundary (/account/security). Outside any workspace, so the way
 * back is the portfolio, and the reassurance is about the account itself.
 */
import { RouteError } from "@/components/harbor/route-error";

export default function AccountError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Your account security could not be shown."
      links={[
        { href: "/", label: "Back to the portfolio" },
        { href: "/settings/sessions", label: "Sessions" },
      ]}
    >
      <p>
        Your password, two-step verification and sessions are unchanged: reading them failed. Trying again is safe.
      </p>
    </RouteError>
  );
}
