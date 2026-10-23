import type { Metadata } from "next";
import { resolveActiveWorkspace } from "@/lib/session";
import { AppShell } from "@/components/harbor/app-shell";
import { Inbox } from "@/components/harbor/inbox";
import { PageHeader } from "@/components/harbor/page-header";

export const metadata: Metadata = { title: "Notifications" };

/**
 * /notifications — the signed-in person's inbox and email preferences.
 *
 * Both are the person's, not the workspace's (/api/me/...), so the page does
 * no workspace reads of its own; the shell still needs the workspace list, and
 * someone with no workspace is sent to /welcome by it. The inbox loads in the
 * browser (components/harbor/inbox.tsx), which also owns its loading, empty
 * and failed states and re-reads every minute.
 */
export default async function NotificationsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();

  return (
    <AppShell workspaces={workspaces} activeWorkspace={active} trail={[{ label: "Notifications" }]}>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Notifications"
          lede="Alerts you receive and their reminders, newest first. They are yours, not the workspace's: marking one read does not acknowledge the alert for anyone else."
        />
        <Inbox />
      </div>
    </AppShell>
  );
}
