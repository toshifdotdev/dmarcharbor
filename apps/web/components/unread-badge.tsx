"use client";

import { useEffect, useState } from "react";
import { listNotifications } from "@/lib/notifications-client";

/**
 * The unread badge on the notification link.
 *
 * Separate from the inbox page on purpose: a badge that only appears once
 * somebody has already visited the page is not a badge, it is a surprise. This
 * polls the same endpoint the inbox does, so the count is right on any screen.
 *
 * Renders nothing at zero rather than a zero. A "0" next to Notifications says
 * the system checked and found nothing, which is a claim this component cannot
 * honestly make while the read may have failed.
 *
 * Swallows its own failures. The inbox page shows a real error state; a header
 * badge cannot, and turning a failed poll into an error boundary over the whole
 * app would be a far worse outcome than a missing number.
 */
export function UnreadBadge() {
  const [unread, setUnread] = useState<number | null>(null);

  useEffect(() => {
    let live = true;

    async function poll() {
      const result = await listNotifications({ unreadOnly: true, limit: 1 });
      if (!live || !result.ok) return;
      setUnread(result.data.unread);
    }

    void poll();
    const timer = setInterval(() => void poll(), 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (!unread) return null;

  return (
    <span
      aria-label={`${unread} unread notifications`}
      className="num rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
    >
      {unread > 99 ? "99+" : unread}
    </span>
  );
}