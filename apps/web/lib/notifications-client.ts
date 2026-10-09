import { apiFetch, describeApiFailure } from "./api-fetch";
import type { OpsResult } from "./ops-client";

/**
 * The notification inbox, and the digest and inbox controls that go with it.
 *
 * Two things live here rather than in `api-ops.ts`, and both are because of who
 * the endpoints are scoped to.
 *
 * The inbox is `/api/me/notifications`, keyed to the signed-in user rather than
 * to a workspace. Every other settings screen is a server component that already
 * holds a workspace, so it reads through `api-ops.ts`. This one cannot: learning
 * the user id needs the session, and `lib/session.ts` deliberately hands back
 * workspaces rather than identity. Reading from the browser keeps one code path
 * for the whole inbox and leaves the polling decision in a single place.
 *
 * The digest and mailbox controls are here for the ordinary reason: they are
 * writes, and writes belong with their `OpsResult` union so a failure renders as
 * an error state rather than an unhandled rejection inside an effect.
 */

export interface NotificationRow {
  id: string;
  title: string;
  body: string | null;
  kind: string;
  readAt: Date | null;
  createdAt: Date;
  link: string | null;
  severity: string | null;
  alertEventId: string | null;
  /**
   * The domain that triggered the alert, when this notification came from one.
   *
   * Not a top-level `domainId`: the API returns it nested under `alertEvent`,
   * so reading it from the row directly produced `undefined` and the
   * jump-to-evidence link never rendered on any notification.
   */
  alertEvent: { id: string; domainId: string | null } | null;
}

export interface NotificationInbox {
  notifications: NotificationRow[];
  unread: number;
}

export interface NotificationPreference {
  emailAlerts: boolean;
  timezone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  onlyHighRiskAlerts: boolean;
}

export interface Me {
  id: string;
  email: string;
  name?: string | null;
}

/**
 * `GET /api/me` returns the whole session object, `{ session, user }`, rather than
 * a bare user. Typed as the shape actually on the wire, then flattened by `getMe`
 * below so callers get an `id` instead of having to remember which level of the
 * response it lives at.
 */
interface MeResponse {
  user?: { id?: string; email?: string; name?: string | null } | null;
}

/**
 * Reads and writes through the same transport `ops-client.ts` uses, including its
 * timeout and its handling of the API's two error envelope shapes.
 *
 * Imported rather than copied on purpose: a second fetch wrapper is how a screen
 * ends up without a deadline, and the next person to add an inbox feature has no
 * way to know there is already a convention.
 */
async function call<T>(path: string, init?: RequestInit): Promise<OpsResult<T>> {
  try {
    const res = await apiFetch(path, init);
    if (res.status === 204) return { ok: true, data: undefined as T };
    const text = await res.text();
    return { ok: true, data: (text ? JSON.parse(text) : null) as T };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: { message: describeApiFailure(error) },
    };
  }
}

/**
 * Reads the signed-in user, which is the only way to reach the preferences
 * endpoints: they spell out the user id in the path.
 *
 * Unwraps `{ session, user }` here rather than leaving the nesting for every
 * caller, and fails loudly when the user is absent rather than handing back an
 * object with an undefined id. A preferences form keyed on `undefined` would
 * produce a 403 from the API and read as "you cannot change your preferences",
 * which is not the same thing at all.
 */
export async function getMe(): Promise<OpsResult<Me>> {
  const result = await call<MeResponse>("/api/me");
  if (!result.ok) return result;

  const user = result.data.user;
  if (!user?.id) {
    // 200 with no user in it. Not a transport failure, so there is no status to
    // carry over; the message has to stand on its own.
    return {
      ok: false,
      status: 200,
      error: { message: "The signed-in user could not be read from the session." },
    };
  }

  return {
    ok: true,
    data: { id: user.id, email: user.email ?? "", name: user.name ?? null },
  };
}

export async function listNotifications(
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<OpsResult<NotificationInbox>> {
  const query = new URLSearchParams();
  if (options.unreadOnly) query.set("unreadOnly", "true");
  if (options.limit) query.set("limit", String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return call<NotificationInbox>(`/api/me/notifications${suffix}`);
}

export async function markNotificationRead(notificationId: string): Promise<OpsResult<null>> {
  return call<null>(`/api/me/notifications/${notificationId}/read`, { method: "POST" });
}

export async function markAllNotificationsRead(): Promise<OpsResult<null>> {
  return call<null>("/api/me/notifications/read-all", { method: "POST" });
}

export async function getNotificationPreference(
  userId: string,
): Promise<OpsResult<NotificationPreference>> {
  return call<NotificationPreference>(`/api/me/${userId}/notification-preferences`);
}

/**
 * Only ever called with the session user's own id.
 *
 * The route compares the path against the session and answers 403 otherwise,
 * which is the right place for that check to live, but it means a workspace
 * admin cannot set preferences on someone else's behalf. The UI says so rather
 * than offering a control that would fail.
 */
export async function updateNotificationPreference(
  userId: string,
  preferences: Partial<NotificationPreference>,
): Promise<OpsResult<NotificationPreference>> {
  return call<NotificationPreference>(`/api/me/${userId}/notification-preferences`, {
    method: "PATCH",
    body: JSON.stringify(preferences),
  });
}

/**
 * Builds and sends one digest straight away.
 *
 * Returns a `preview` of the rendered email. That is not decoration: it is the
 * only way to see what a recipient will read before it goes to every address on
 * the digest, and the scheduler sends the same content on its own schedule.
 */
export async function sendReportDigestNow(
  organizationId: string,
  digestId: string,
): Promise<OpsResult<DigestSendResult>> {
  return call<DigestSendResult>(
    `/api/workspaces/${organizationId}/report-digests/${digestId}/send`,
    { method: "POST" },
  );
}

export interface DigestSendResult {
  sent: boolean;
  recipients: number;
  subject: string;
  preview: string;
}

/**
 * Runs every enabled digest for the account, not one workspace's.
 *
 * Worth saying out loud in the UI: the endpoint takes no organization id and
 * reports across all of them, so the button is account-wide even though it is
 * rendered inside one workspace.
 */
export async function runAllReportDigests(
  organizationId: string,
): Promise<OpsResult<{ processed: number; sent: number }>> {
  return call<{ processed: number; sent: number }>(
    `/api/workspaces/${organizationId}/report-digests/run`,
    { method: "POST" },
  );
}

/**
 * Polls the mailbox immediately instead of waiting for the scheduler.
 *
 * For the case this exists for: a rua tag has just been pointed at us and
 * somebody wants to know now whether the mailbox is correct, rather than
 * discovering it is wrong after the next automatic run.
 *
 * The counts are the ones the API reports, not the ones this function used to
 * expect. It declared `checked` and `received`, so the success line printed
 * "Checked undefined mailboxes, received undefined new reports" on a poll that
 * had actually worked.
 */
export interface InboxPollOutcome {
  /** Messages the mailbox handed over on this pass. */
  messages: number;
  /** Reports accepted into the system. */
  accepted: number;
  /** Already seen. Not a failure, but it is why a re-run finds nothing new. */
  duplicates: number;
  /** Not addressed to a domain we monitor. Worth reporting: it is the usual
   *  reason a customer's own rua tag appears to work while nothing arrives. */
  unmatched: number;
}

export async function pollReportInboxNow(
  organizationId: string,
): Promise<OpsResult<InboxPollOutcome>> {
  return call<InboxPollOutcome>(
    `/api/workspaces/${organizationId}/report-inbox/poll`,
    { method: "POST" },
  );
}