"use client";

/**
 * The settings boundary. A throw in one section replaces that page only, and
 * says the one thing a person changing settings needs to hear: a failed read
 * changed nothing.
 */
import { RouteError } from "@/components/harbor/route-error";

export default function SettingsError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="This settings section could not be shown."
      links={[
        { href: "/settings", label: "All settings" },
        { href: "/", label: "Back to the portfolio" },
      ]}
    >
      <p>
        Showing the section failed. A failed read changes no setting, and anything you saved before this is kept.
        Trying again is safe.
      </p>
    </RouteError>
  );
}
