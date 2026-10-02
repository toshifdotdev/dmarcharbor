"use client";

/**
 * social-buttons.tsx — federated sign-in, rendered only for providers that are
 * actually live.
 *
 * GET /api/auth/providers is the contract (added in commit 0209345): it
 * returns { password, google, microsoft } as booleans, and a provider is true
 * only when BOTH its client id and secret exist — so half-finished OAuth
 * config correctly renders no button. The earlier "404 means no providers"
 * fallback is gone: the endpoint exists now. A request that fails outright
 * still renders nothing, because a broken lookup must never surface as a
 * broken form.
 */

import { useEffect, useState } from "react";
import type { AuthProviders } from "@/lib/types";

const PROVIDER_META: Record<"google" | "microsoft", string> = {
  google: "Continue with Google",
  microsoft: "Continue with Microsoft",
};

export function SocialButtons() {
  const [live, setLive] = useState<Array<"google" | "microsoft">>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/providers", { credentials: "include" });
        if (!res.ok) return;
        const body = (await res.json()) as Partial<AuthProviders>;
        if (cancelled) return;
        setLive(
          (Object.keys(PROVIDER_META) as Array<"google" | "microsoft">).filter(
            (p) => body[p] === true,
          ),
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
          data-provider={p}
          className="rounded-[2px] border px-5 py-2.5 text-[13px] font-medium transition-colors"
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
