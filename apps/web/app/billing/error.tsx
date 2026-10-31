"use client";
/**
 * The billing boundary. A throw here replaces this page only; nothing about
 * the plan or any payment was changed by a failed read.
 */
import { RouteError } from "@/components/harbor/route-error";

export default function BillingError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Billing could not be shown."
      links={[
        { href: "/", label: "Back to the portfolio" },
        { href: "/settings", label: "Settings" },
      ]}
    >
      <p>The plan and any payment are unchanged: reading them failed. Trying again is safe.</p>
    </RouteError>
  );
}
