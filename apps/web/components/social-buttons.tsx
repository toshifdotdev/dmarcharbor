"use client";

/**
 * social-buttons.tsx — federated sign-in, rendered only for providers that are
 * actually live.
 *
 * The button set is driven by GET /api/auth/providers (returning e.g.
 * { google: false, microsoft: false }), never hardcoded: a build that shows
 * dead buttons is a build that lies. Until that endpoint lands it returns 404,
 * which is treated as "no live providers" — the buttons stay hidden.
 */

import { useEffect, useState } from "react";

type ProviderName = "google" | "microsoft";

const PROVIDER_META: Record<ProviderName, string> = {
  google: "Continue with Google",
  microsoft: "Continue with Microsoft",
};

export function SocialButtons() {
  const [live, setLive] = useState<ProviderName[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/providers", { credentials: "include" });
        if (!res.ok) return; // endpoint not live yet (404) — no buttons
        const body = (await res.json()) as Record<string, boolean>;
        if (cancelled) return;
        setLive(
          (Object.keys(PROVIDER_META) as ProviderName[]).filter((p) => body[p] === true),
        );
      } catch {
        // Discovery failing must never surface as a broken form.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (live.length === 0) return null;

  return (
    <div className="flex w-full max-w-sm flex-col gap-2.5">
      {live.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => {
            window.location.href = `/api/auth/sign-in/social?provider=${p}`;
          }}
          className="rounded-[2px] border px-5 py-2.5 text-[14.5px] font-medium transition-colors"
          style={{
            borderColor: "var(--color-line-strong)",
            background: "var(--color-surface)",
            color: "var(--color-ink-2)",
          }}
        >
          {PROVIDER_META[p]}
        </button>
      ))}
    </div>
  );
}
