"use client";
/**
 * The welcome boundary: creating a first or another workspace. A failed read
 * here creates nothing, so trying again cannot make a second workspace.
 */
import { RouteError } from "@/components/harbor/route-error";

export default function WelcomeError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Workspace setup could not be shown."
      links={[
        { href: "/", label: "Back to the start" },
        { href: "/sign-in", label: "Sign in" },
      ]}
    >
      <p>No workspace was created and no invitation was accepted: reading your account failed. Trying again is safe.</p>
    </RouteError>
  );
}
