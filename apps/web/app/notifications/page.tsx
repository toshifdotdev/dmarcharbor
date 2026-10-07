import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { NotificationCenter } from "@/components/notification-center";

/**
 * The notification inbox.
 *
 * The one screen here that is not workspace scoped. Every endpoint it needs is
 * `/api/me/...`, so it renders without an active workspace: somebody signed in
 * with no workspace yet still has alert preferences and read state, and
 * redirecting them to /welcome would hide both.
 *
 * Deliberately does no reading of its own, not even server side. The inbox and
 * the preferences both need the session user id, and `lib/session.ts` hands back
 * workspaces rather than identity, so learning it here would mean teaching the
 * session helper about users for one screen. The client component owns the whole
 * load instead, which keeps one code path and one place where the loading and
 * failure states are decided.
 *
 * The workspace list is still fetched here because `Shell` needs it for the
 * switcher, and that call is server side on every other screen.
 */
export default async function NotificationsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <NotificationCenter />
    </Shell>
  );
}