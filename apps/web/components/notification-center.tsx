"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  type Me,
  type NotificationRow,
  getMe,
  getNotificationPreference,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  updateNotificationPreference,
  type NotificationPreference,
} from "@/lib/notifications-client";
import type { OpsResult } from "@/lib/ops-client";
import { domainHref } from "@/lib/route-hrefs";
import { ErrorState } from "@/components/data-states";
import { ActionButton } from "@/components/action-button";


/**
 * The notification inbox.
 *
 * Read from the browser rather than the server, because every endpoint here is
 * keyed to the signed-in user and not to a workspace. That is unusual for this
 * app and worth knowing before changing it: `lib/session.ts` hands back
 * workspaces, not identity, so a server component cannot reach these routes
 * without also teaching the session helper about users.
 *
 * Polls rather than streaming. The unread count has to stay correct while a tab
 * sits open in the background, and a long-poll endpoint is more machinery than a
 * notification list earns. The cost is a request every interval; the
 * alternative is a badge that is quietly wrong.
 */

const POLL_INTERVAL_MS = 60_000;

/**
 * Accepts either a Date or a string because the notification model declares
 * `createdAt` as a Date while a JSON response carries it as a string. Callers
 * should not have to know which shape survived serialization.
 */
function relativeTime(value: Date | string): string {
  const iso = value instanceof Date ? value.toISOString() : value;
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * The inbox body only. The `Shell` is rendered by the page, not here.
 *
 * That is not a stylistic choice: `Shell` reads the request headers for
 * custom-domain branding, and a client component cannot import it. Every other
 * screen gets this for free because its page is a server component; this one
 * has to be written out.
 */
export function NotificationCenter() {
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const next = await listNotifications({ unreadOnly, limit: 50 });
    if (!mounted.current) return;
    if (next.ok) {
      setRows(next.data.notifications);
      setUnread(next.data.unread);
      setFailed(null);
      setLoading(false);
    } else {
      // A failed poll must not blank the list. The rows already on screen are
      // still true; what is unknown is whether anything is newer, so the banner
      // says the count may be out of date rather than implying an empty inbox.
      setFailed(next.error.message ?? "The notification list could not be refreshed.");
    }
  }, [unreadOnly]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  /**
   * The user, read once. The preferences form is keyed on it and is not rendered
   * until it arrives, because the preference endpoints spell the id out in the
   * path and guessing it would produce a 403 rather than a form.
   */
  useEffect(() => {
    void getMe().then((result) => {
      if (!mounted.current) return;
      if (result.ok) setMe(result.data);
      else setFailed(result.error.message ?? "The signed-in user could not be read.");
    });
  }, []);

  /**
   * Every mutation goes through here so a failure has exactly one presentation:
   * the banner above the list. Anything that failed must leave the list alone
   * and say so, because "mark read" that silently did nothing is worse than an
   * error.
   */
  async function run(action: () => Promise<OpsResult<unknown>>) {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (!result.ok) setFailed(result.error.message ?? "That did not work.");
    await refresh();
  }

  return (
    <div className="flex flex-col gap-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="label">Notifications</h1>
            <p className="mt-1.5 max-w-2xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
              Alerts, report arrivals and digest reminders
              {me ? ` for ${me.email}` : ""}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(event) => setUnreadOnly(event.target.checked)}
              />
              Unread only
            </label>
            <ActionButton label="Mark all read" onClick={() => run(markAllNotificationsRead)} busy={busy} disabled={unread === 0} />
          </div>
        </header>

        {failed ? (
          <ErrorState
            what="the notification list"
            detail={`${failed} Anything already shown is still accurate, but the unread count may be out of date.`}
          />
        ) : null}

        {unread > 0 ? (
          <p className="text-[13px]" style={{ color: "var(--color-ink-2)" }}>
            {unread} unread.
          </p>
        ) : null}

        {loading ? (
          <p className="text-[14px]" style={{ color: "var(--color-ink-3)" }}>
            Loading notifications.
          </p>
        ) : rows.length === 0 ? (
          <div className="panel p-6">
            <p className="text-[14px]" style={{ color: "var(--color-ink-2)" }}>
              {unreadOnly
                ? "Nothing unread. Anything still waiting is shown with Unread only switched off."
                : "No notifications yet. Alert deliveries and arriving DMARC reports appear here."}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li key={row.id} className="panel p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold">
                      {row.readAt ? row.title : `${row.title} (new)`}
                    </p>
                    {row.body ? (
                      <p className="mt-1 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                        {row.body}
                      </p>
                    ) : null}
                    <p className="mt-1 text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                      {row.kind} · {relativeTime(row.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/*
                      From alertEvent.domainId, where the API puts it. Reading
                      row.domainId found nothing because it is not a column on
                      the row, so this link never rendered on any notification
                      and every alert was a dead end.
                    */}
                    {row.alertEvent?.domainId ? (
                      <Link
                        href={domainHref(row.alertEvent.domainId)}
                        className="text-[13px] underline"
                        style={{ color: "var(--color-accent)" }}
                        data-testid="notification-domain-link"
                      >
                        Open domain
                      </Link>
                    ) : null}
                    {!row.readAt ? (
                      <ActionButton label="Mark read" variant="ghost" onClick={() => run(() => markNotificationRead(row.id))} busy={busy} />
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {me ? <NotificationPreferences userId={me.id} /> : null}
    </div>
  );
}

/**
 * Delivery preferences.
 *
 * Per person rather than per workspace, which is why it needs the session user
 * id rather than the active workspace: a shared inbox with one person's quiet
 * hours on it would send to people who never asked to be emailed at 3am.
 *
 * The route rejects any attempt to change someone else's preferences, so this
 * is offered only for the signed-in user and the copy does not imply an
 * administrator can set it for the team.
 */
function NotificationPreferences({ userId }: { userId: string }) {
  const [preference, setPreference] = useState<NotificationPreference | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let live = true;
    void getNotificationPreference(userId).then((result) => {
      if (!live) return;
      if (result.ok) {
        setPreference(result.data);
        setFailed(null);
      } else {
        setFailed(result.error.message ?? "The preferences could not be read.");
      }
    });
    return () => {
      live = false;
    };
  }, [userId]);

  async function save() {
    if (!preference) return;
    setSaving(true);
    const result = await updateNotificationPreference(userId, preference);
    setSaving(false);
    setDirty(false);
    if (result.ok) {
      setPreference(result.data);
      setFailed(null);
    } else {
      setFailed(result.error.message ?? "The preferences could not be saved.");
    }
  }

  return (
    <section className="panel p-5">
      <h2 className="text-[15px] font-semibold">How you are notified</h2>
      <p className="mt-1 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
        These apply to you across every workspace you belong to.
      </p>

      {failed ? (
        <p className="mt-3 text-[13px]" style={{ color: "var(--color-danger, #b4232a)" }}>
          {failed}
        </p>
      ) : null}

      {preference ? (
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex items-center gap-2 text-[14px]">
            <input
              type="checkbox"
              checked={preference.emailAlerts}
              onChange={(event) => {
                setPreference({ ...preference, emailAlerts: event.target.checked });
                setDirty(true);
              }}
            />
            Email me alerts
          </label>
          <label className="flex items-center gap-2 text-[14px]">
            <input
              type="checkbox"
              checked={preference.onlyHighRiskAlerts}
              onChange={(event) => {
                setPreference({ ...preference, onlyHighRiskAlerts: event.target.checked });
                setDirty(true);
              }}
            />
            Only high risk alerts
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[13px]">
              Quiet hours start
              <input
                type="time"
                value={preference.quietHoursStart ?? ""}
                onChange={(event) => {
                  setPreference({ ...preference, quietHoursStart: event.target.value || null });
                  setDirty(true);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              Quiet hours end
              <input
                type="time"
                value={preference.quietHoursEnd ?? ""}
                onChange={(event) => {
                  setPreference({ ...preference, quietHoursEnd: event.target.value || null });
                  setDirty(true);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              Timezone
              <input
                type="text"
                value={preference.timezone}
                onChange={(event) => {
                  setPreference({ ...preference, timezone: event.target.value });
                  setDirty(true);
                }}
              />
            </label>
          </div>
          <div>
            <ActionButton label="Save preferences" loadingLabel="Saving preferences" onClick={save} busy={saving} disabled={!dirty} />
          </div>
        </div>
      ) : failed ? null : (
        <p className="mt-3 text-[13px]" style={{ color: "var(--color-ink-3)" }}>
          Loading preferences.
        </p>
      )}
    </section>
  );
}