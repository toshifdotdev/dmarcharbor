import { listSessions } from "@/lib/api-phase7";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { SessionsPanel } from "@/components/sessions-client";

/**
 * Sessions — account security, the surface an MSP reaches for when a laptop
 * is lost. "Sign out everywhere else" is the primary action and spares this
 * session; the confirm-gated "everywhere, including this device" is the
 * deliberate compromise-response control.
 */
export default async function SessionsSettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) return null;

  const { sessions } = await listSessions().catch(() => ({ sessions: [] }));

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Sessions</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            Every device signed in to your account. Revoke anything you do not
            recognise: and if a laptop is lost, sign out everywhere else in one
            step.
          </p>
        </header>
        <SettingsNav current="sessions" />
        <SessionsPanel sessions={sessions} />
      </div>
    </Shell>
  );
}
