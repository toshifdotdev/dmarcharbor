import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { NotificationCenter } from "@/components/notification-center";

/**
 * The notification inbox.
 *
 * The inbox itself is not workspace scoped: its reads and writes are
 * `/api/me/notifications` and `/api/me/:id/notification-preferences`, keyed to
 * the signed-in user rather than to a workspace.
 *
 * The screen still requires a workspace, and that is not an oversight. The
 * controls below the inbox send digests and poll the report mailbox, and both
 * are `/api/workspaces/:id/...`, so they need a scope. Someone signed in with no
 * workspace cannot use those, and sending them to /welcome is right. The comment
 * here used to claim the page rendered without a workspace; it does not, because
 * `Shell` requires one for the switcher, and the claim was never true.
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