"use client";
/**
 * The alerts boundary. Without it a failure here fell through to the root
 * page, which could only offer "the start"; this one says that no alert or
 * rule changed and points at the screens an operator came from.
 */
import { RouteError } from "@/components/harbor/route-error";

export default function AlertsError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Alerts could not be shown."
      links={[
        { href: "/", label: "Back to the portfolio" },
        { href: "/notifications", label: "Notifications" },
      ]}
    >
      <p>
        No alert was acknowledged and no rule was changed: reading them failed. Alerts keep firing and emailing as
        before. Trying again is safe.
      </p>
    </RouteError>
  );
}
