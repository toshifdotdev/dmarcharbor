"use client";
/** The notifications boundary: the person's inbox and email preferences. */
import { RouteError } from "@/components/harbor/route-error";

export default function NotificationsError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Notifications could not be shown."
      links={[
        { href: "/", label: "Back to the portfolio" },
        { href: "/alerts", label: "Alerts" },
      ]}
    >
      <p>Nothing was marked read and no preference changed: reading them failed. Trying again is safe.</p>
    </RouteError>
  );
}
