"use client";

/**
 * inbox.tsx — your notifications, and how you are told.
 *
 * The inbox is the person's, not the workspace's: /api/me/notifications. It
 * holds alert notifications (the in-app copy of each alert and each reminder,
 * created for every recipient) and digest notices. Unread is the default
 * view, newest first, grouped by day; each row links to the evidence (the
 * domain's page) and to the alert list, and can be marked read. It re-reads
 * every minute and when the tab regains focus. A failed read keeps what is
 * already shown and says the count may be stale; it never empties the list.
 *
 * The preferences beside it govern EMAIL only, per the API: alert email on or
 * off, only high-risk alerts (every metric except report silence), and quiet
 * hours in a chosen timezone, during which alert emails are skipped rather
 * than held. The in-app copy always arrives. A person can change only their
 * own preferences; the API enforces it and the panel says so.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import {
  getMe,
  getNotificationPreference,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  updateNotificationPreference,
  type Me,
  type NotificationPreference,
  type NotificationRow,
} from "@/lib/notifications-client";
import { domainHref } from "@/lib/route-hrefs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { Field, Input, Segmented, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { LoadingState } from "@/components/ui/states";

const POLL_MS = 60_000;

function dayKey(d: Date): string {
  return d.toLocaleDateString("en-GB", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function dayHeading(d: Date, now: Date): string {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(now)) return "Today";
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

function timeOf(d: Date): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

const KIND: Record<string, string> = { ALERT: "Alert", DIGEST: "Digest", DNS_CHANGE: "DNS change" };

export function Inbox() {
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [unread, setUnread] = useState<number | null>(null);
  const [view, setView] = useState<"unread" | "all">("unread");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const res = await listNotifications({ limit: 100 });
    if (!res.ok) {
      setError(res.error.message ?? "The inbox could not be read.");
      return;
    }
    setError(null);
    setRows(res.data.notifications);
    setUnread(res.data.unread);
    setCheckedAt(new Date());
  }, []);

  useEffect(() => {
    // The first read happens on mount; the API is the source of the list.
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  async function markRead(id: string) {
    setBusy(id);
    const res = await markNotificationRead(id);
    setBusy(null);
    if (!res.ok) setError(res.error.message ?? "It could not be marked read.");
    await load();
  }

  async function markAll() {
    setBusy("all");
    const res = await markAllNotificationsRead();
    setBusy(null);
    if (!res.ok) setError(res.error.message ?? "They could not be marked read.");
    await load();
  }

  const shown = useMemo(() => (rows ?? []).filter((r) => view === "all" || !r.readAt), [rows, view]);
  const groups = useMemo(() => {
    const now = new Date();
    const out: Array<{ heading: string; rows: NotificationRow[] }> = [];
    for (const r of shown) {
      const h = dayHeading(new Date(r.createdAt), now);
      const last = out[out.length - 1];
      if (last && last.heading === h) last.rows.push(r);
      else out.push({ heading: h, rows: [r] });
    }
    return out;
  }, [shown]);

  return (
    <div className="grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section aria-labelledby="inbox-head" className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="inbox-head" className="sr-only">
            Inbox
          </h2>
          <Segmented
            label="Which notifications"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "unread", label: `Unread ${unread ?? "…"}` },
              { value: "all", label: `All ${rows?.length ?? "…"}` },
            ]}
          />
          <Button size="sm" variant="secondary" onClick={markAll} busy={busy === "all"} busyLabel="Marking" disabled={!unread} data-testid="mark-all-read">
            Mark all read
          </Button>
          <span className="text-meta text-fg-3" aria-live="polite">
            {checkedAt ? `Checked at ${timeOf(checkedAt)}; re-reads every minute.` : null}
          </span>
        </div>

        {error ? (
          <Notice tone="warn" title="The inbox could not be read just now" role="alert" testId="state-error">
            {error} {rows ? "What is shown is still accurate, but the unread count may be out of date." : null}
            <Button size="sm" variant="ghost" onClick={() => void load()} data-testid="state-retry" className="ml-1">
              Try again
            </Button>
          </Notice>
        ) : null}

        {rows === null ? (
          error ? null : <LoadingState label="Reading the inbox" rows={5} />
        ) : shown.length === 0 ? (
          <div role="status" data-testid="state-empty" className="border-y border-rule py-6">
            <p className="text-body font-semibold text-fg">{view === "unread" && rows.length > 0 ? "Nothing unread." : "No notifications yet."}</p>
            <p className="mt-1 max-w-[64ch] text-ui text-fg-2">
              {view === "unread" && rows.length > 0
                ? "Everything here has been read. Switch to All to see it again."
                : "Alerts you are a recipient of, and their reminders, arrive here as they fire."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((g) => (
              <div key={g.heading}>
                <p className="legend pb-1.5">{g.heading}</p>
                <ol className="flex flex-col border-y border-rule">
                  {g.rows.map((r) => {
                    const isUnread = !r.readAt;
                    const sev = r.severity ?? "";
                    const slug = r.alertEvent?.domain?.slug ?? null;
                    return (
                      <li
                        key={r.id}
                        data-notification-id={r.id}
                        data-unread={isUnread || undefined}
                        className={clsx(
                          "grid grid-cols-[14px_minmax(0,1fr)_auto] gap-x-3 border-b border-rule py-3 last:border-b-0 [animation:hb-rise_200ms_ease-out]",
                          isUnread && "bg-paper-2/70",
                        )}
                      >
                        <span aria-hidden className="mt-[7px] grid size-2.5 place-items-center">
                          {isUnread ? (
                            <span className={clsx("block size-2", sev === "CRITICAL" ? "rotate-45 bg-fail" : "rounded-full bg-act")} />
                          ) : (
                            <span className="block size-1.5 rounded-full bg-fg-4" />
                          )}
                        </span>
                        <div className="min-w-0">
                          <p className={clsx("text-ui", isUnread ? "font-semibold text-fg" : "text-fg-2")}>
                            {r.title}
                            {isUnread ? <span className="sr-only"> (unread)</span> : null}
                          </p>
                          {r.body ? <p className="mt-0.5 max-w-[90ch] text-ui text-fg-2">{r.body}</p> : null}
                          <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-meta text-fg-3">
                            <span>
                              {KIND[r.kind] ?? r.kind}
                              {sev === "CRITICAL" ? <span className="font-semibold text-fail"> · unacknowledged reminder</span> : null}
                            </span>
                            <span className="tnum">{timeOf(new Date(r.createdAt))}</span>
                            {slug ? (
                              <Link href={domainHref(slug)} className="link font-semibold" data-testid="notification-domain-link">
                                Open the domain
                              </Link>
                            ) : null}
                            {r.link && r.link.startsWith("/") ? (
                              <Link href={r.link} className="link font-semibold">
                                {r.link === "/alerts" ? "Open alerts" : "Open"}
                              </Link>
                            ) : null}
                          </p>
                        </div>
                        <div className="self-start">
                          {isUnread ? (
                            <Button size="sm" variant="ghost" onClick={() => markRead(r.id)} busy={busy === r.id} busyLabel="Marking">
                              Mark read
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
            {rows.length >= 100 ? <p className="text-meta text-fg-3">Showing the latest 100.</p> : null}
          </div>
        )}
      </section>

      <aside className="self-start lg:sticky lg:top-[104px]">
        <Preferences />
      </aside>
    </div>
  );
}

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

function Preferences() {
  const [me, setMe] = useState<Me | null>(null);
  const [saved, setSaved] = useState<NotificationPreference | null>(null);
  const [draft, setDraft] = useState<NotificationPreference | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const allZones = useMemo(zones, []);

  useEffect(() => {
    let live = true;
    (async () => {
      const who = await getMe();
      if (!live) return;
      if (!who.ok) {
        setError(who.error.message ?? "Your account could not be read.");
        return;
      }
      setMe(who.data);
      const pref = await getNotificationPreference(who.data.id);
      if (!live) return;
      if (!pref.ok) {
        setError(pref.error.message ?? "Your preferences could not be read.");
        return;
      }
      setSaved(pref.data);
      setDraft(pref.data);
    })();
    return () => {
      live = false;
    };
  }, []);

  const dirty = Boolean(saved && draft && JSON.stringify(saved) !== JSON.stringify(draft));
  const quietHalf = Boolean(draft && Boolean(draft.quietHoursStart) !== Boolean(draft.quietHoursEnd));

  async function save() {
    if (!me || !draft || busy) return;
    setBusy(true);
    setError(null);
    setDone(false);
    const res = await updateNotificationPreference(me.id, draft);
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message ?? "Your preferences could not be saved.");
      return;
    }
    setSaved(res.data);
    setDraft(res.data);
    setDone(true);
  }

  const browserZone = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;

  return (
    <section aria-labelledby="prefs-head" className="flex flex-col gap-3">
      <div>
        <h2 id="prefs-head" className="text-h3 font-bold tracking-[-0.01em] text-fg">
          How you are emailed
        </h2>
        <p className="mt-1 text-meta text-fg-3">
          {me ? (
            <>
              For <span className="data text-fg-2">{me.email}</span>, across every workspace you belong to. These apply to
              email; the copy in this inbox always arrives.
            </>
          ) : (
            "Applies to you across every workspace you belong to."
          )}
        </p>
      </div>

      {error ? <Notice tone="fail" title={error} /> : null}
      {!draft ? (
        error ? null : <LoadingState label="Reading your preferences" />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex flex-col gap-3.5"
        >
          <Checkbox
            checked={draft.emailAlerts}
            onChange={(e) => setDraft({ ...draft, emailAlerts: e.target.checked })}
            label="Email me alerts"
            hint="Off means alert emails are not sent to you at all."
          />
          <Checkbox
            checked={draft.onlyHighRiskAlerts}
            disabled={!draft.emailAlerts}
            onChange={(e) => setDraft({ ...draft, onlyHighRiskAlerts: e.target.checked })}
            label="Only high-risk alerts"
            hint="Every metric counts as high risk except report silence, which then stays in the inbox only."
          />
          <fieldset className="flex flex-col gap-2" disabled={!draft.emailAlerts}>
            <legend className="mb-2 text-ui font-semibold text-fg">Quiet hours</legend>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From">
                <Input
                  type="time"
                  value={draft.quietHoursStart ?? ""}
                  onChange={(e) => setDraft({ ...draft, quietHoursStart: e.target.value || null })}
                  className="tnum"
                />
              </Field>
              <Field label="Until">
                <Input
                  type="time"
                  value={draft.quietHoursEnd ?? ""}
                  onChange={(e) => setDraft({ ...draft, quietHoursEnd: e.target.value || null })}
                  className="tnum"
                />
              </Field>
            </div>
            <p className={clsx("text-meta", quietHalf ? "text-warn" : "text-fg-3")}>
              {quietHalf
                ? "Set both times, or clear both: one on its own does nothing."
                : "Alert emails due in this span are skipped, not held for later. A later reminder still arrives if the alert is open."}
            </p>
          </fieldset>
          <Field label="Timezone" hint="Quiet hours are read in this timezone.">
            {allZones.length > 0 ? (
              <Select value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} className="w-full">
                {!allZones.includes(draft.timezone) ? <option value={draft.timezone}>{draft.timezone}</option> : null}
                {allZones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            ) : (
              <Input value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} maxLength={64} />
            )}
          </Field>
          {browserZone && browserZone !== draft.timezone ? (
            <button type="button" className="link -mt-2 self-start text-meta font-semibold" onClick={() => setDraft({ ...draft, timezone: browserZone })}>
              Use this device&rsquo;s timezone ({browserZone.replace(/_/g, " ")})
            </button>
          ) : null}
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" busy={busy} busyLabel="Saving" disabled={!dirty || quietHalf}>
              Save preferences
            </Button>
            {done && !dirty ? <span role="status" className="text-meta font-semibold text-ok">Saved.</span> : null}
          </div>
        </form>
      )}
    </section>
  );
}
