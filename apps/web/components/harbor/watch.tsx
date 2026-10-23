"use client";

/**
 * watch.tsx — what needs the operator, readable from any screen.
 *
 * Two readings, taken after the page has painted so they never slow it down,
 * then once a minute and whenever the window regains focus:
 *
 *   open alerts     alert events neither acknowledged nor resolved, from the
 *                   workspace's alert list. The list is read 50 at a time, so
 *                   a full page says "50+" rather than pretending to a count.
 *   unread          notifications in the signed-in user's inbox.
 *
 * Each reading has three honest faces: a number, a calm "none", and "not
 * checked" when the read failed. A failed read is never shown as zero: "no
 * open alerts" is a claim, and we only make it when the API said so.
 *
 * Plan trouble (past due, cancelling, ended) is read the same way and shown as
 * a notice under the bar, because it changes what the workspace can do. A
 * failed read shows nothing: failure to ask is not evidence of trouble.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { clsx } from "clsx";
import { opsCall } from "@/lib/ops-client";
import { listNotifications } from "@/lib/notifications-client";
import type { AlertEventRow, PageEnvelope, ResolvedEntitlements } from "@/lib/types";
import { Notice } from "@/components/ui/notice";

type Reading = { state: "pending" } | { state: "failed" } | { state: "ok"; n: number; more?: boolean };

function useReadings(organizationId: string) {
  const [alerts, setAlerts] = useState<Reading>({ state: "pending" });
  const [unread, setUnread] = useState<Reading>({ state: "pending" });

  const read = useCallback(async () => {
    const [a, n] = await Promise.all([
      opsCall<PageEnvelope<AlertEventRow>>(`/api/workspaces/${organizationId}/alerts?limit=50`),
      listNotifications({ unreadOnly: true, limit: 1 }),
    ]);
    setAlerts(
      a.ok
        ? { state: "ok", n: a.data.items.filter((e) => !e.acknowledgedAt && !e.resolvedAt).length, more: a.data.hasMore }
        : { state: "failed" },
    );
    setUnread(n.ok ? { state: "ok", n: n.data.unread } : { state: "failed" });
  }, [organizationId]);

  useEffect(() => {
    void read();
    const timer = setInterval(() => void read(), 60_000);
    const onFocus = () => void read();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [read]);

  return { alerts, unread };
}

export function Watch({ organizationId }: { organizationId: string }) {
  const { alerts, unread } = useReadings(organizationId);
  return (
    <div className="flex shrink-0 items-center" role="group" aria-label="Watch">
      <WatchItem
        href="/alerts"
        reading={alerts}
        noun={(n) => `open alert${n === 1 ? "" : "s"}`}
        none="No open alerts"
        mark="alert"
        testId="watch-alerts"
      />
      <span aria-hidden className="mx-1 h-4 w-px bg-rule" />
      <WatchItem
        href="/notifications"
        reading={unread}
        noun={() => "unread"}
        none="Inbox clear"
        mark="unread"
        testId="watch-unread"
      />
    </div>
  );
}

function WatchItem({
  href,
  reading,
  noun,
  none,
  mark,
  testId,
}: {
  href: string;
  reading: Reading;
  noun: (n: number) => string;
  none: string;
  mark: "alert" | "unread";
  testId: string;
}) {
  const short = mark === "alert" ? "alerts" : "unread";
  const live = reading.state === "ok" && reading.n > 0;
  const label =
    reading.state === "pending"
      ? "Checking…"
      : reading.state === "failed"
        ? "Not checked"
        : reading.n === 0
          ? none
          : `${reading.n}${reading.more ? "+" : ""} ${noun(reading.n)}`;
  return (
    <Link
      href={href}
      data-testid={testId}
      data-state={reading.state}
      title={reading.state === "failed" ? "This could not be read just now. It is unknown, not zero." : undefined}
      className={clsx(
        "flex h-8 items-center gap-1.5 whitespace-nowrap rounded-ctl px-2 text-meta font-semibold hover:bg-paper-3",
        live ? "text-fg" : "text-fg-3",
      )}
    >
      <span aria-hidden className="grid size-2.5 place-items-center">
        {reading.state === "failed" ? (
          <span className="block size-2 border border-void" />
        ) : live && mark === "alert" ? (
          <span className="block size-2 rotate-45 bg-fail" />
        ) : live ? (
          <span className="block size-2 rounded-full bg-act" />
        ) : mark === "alert" ? (
          // At rest each reading keeps its own shape, so "0" beside a diamond
          // and "0" beside a ring cannot be confused on a phone.
          <span className="block size-[7px] rotate-45 border border-fg-4" />
        ) : (
          <span className="block size-2 rounded-full border border-fg-4" />
        )}
      </span>
      {/* Narrow screens keep the number and drop the words; the accessible
          name keeps the whole sentence. */}
      <span className="tnum hidden lg:inline">{label}</span>
      <span className="tnum lg:hidden" aria-hidden>
        {reading.state === "ok" ? `${reading.n}${reading.more ? "+" : ""}` : reading.state === "failed" ? "?" : "…"}
        <span className="hidden font-medium text-fg-3 sm:inline"> {short}</span>
      </span>
      <span className="sr-only lg:hidden">{label}</span>
    </Link>
  );
}

const TROUBLE: Partial<Record<ResolvedEntitlements["status"], string>> = {
  PAST_DUE: "Payment for this workspace is past due.",
  CANCELLED: "This workspace's subscription is cancelled.",
  EXPIRED: "This workspace's subscription has ended.",
};

/** A plan condition that changes what the workspace can do, or nothing. */
export function PlanWatch({ organizationId }: { organizationId: string }) {
  const [ent, setEnt] = useState<ResolvedEntitlements | null>(null);
  useEffect(() => {
    let live = true;
    void opsCall<ResolvedEntitlements>(`/api/workspaces/${organizationId}/entitlements`).then((r) => {
      if (live && r.ok) setEnt(r.data);
    });
    return () => {
      live = false;
    };
  }, [organizationId]);

  if (!ent) return null;
  const trouble = TROUBLE[ent.status];
  const ending = !trouble && ent.cancelAtPeriodEnd && ent.currentPeriodEnd;
  if (!trouble && !ending) return null;

  return (
    <div className="border-b border-rule bg-paper px-4 py-2 sm:px-6 lg:px-8">
      <Notice
        tone={trouble ? "fail" : "warn"}
        testId="plan-watch"
        title={
          trouble ??
          `The ${ent.label} plan ends on ${new Date(ent.currentPeriodEnd as string).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.`
        }
        action={
          <Link href="/billing" className="link text-ui font-semibold">
            Review billing
          </Link>
        }
      >
        {trouble
          ? "Billing shows the detail and what resolves it."
          : "It is set to cancel at the end of the current period."}
      </Notice>
    </div>
  );
}
