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

/** The provider marks, exactly as the brands publish them. One size for both
  * so the row reads as one system beside the button text. */
function ProviderLogo({ provider }: { provider: "google" | "microsoft" }) {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden focusable="false">
      {provider === "google" ? (
        <g>
          <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>
          <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
          <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>
          <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>
        </g>
      ) : (
        // Microsoft: four squares, two by two, brand gap — the standard mark.
        <g transform="scale(2)">
          <rect width="10" height="10" x="1" y="1" fill="#F25022"/>
          <rect width="10" height="10" x="13" y="1" fill="#7FBA00"/>
          <rect width="10" height="10" x="1" y="13" fill="#00A4EF"/>
          <rect width="10" height="10" x="13" y="13" fill="#FFB900"/>
        </g>
      )}
    </svg>
  );
}

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
          onClick={async () => {
            // better-auth's /sign-in/social is POST-only and answers with the
            // provider's redirect URL — a GET navigation would 405. The button
            // POSTs and follows the URL the endpoint returns.
            try {
              const res = await fetch("/api/auth/sign-in/social", {
                method: "POST",
                headers: { "content-type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ provider: p }),
              });
              if (!res.ok) return;
              const body = (await res.json()) as { url?: string; redirect?: boolean };
              if (typeof body.url === "string" && body.url.startsWith("https://")) {
                window.location.href = body.url;
              }
            } catch {
              // A failed discovery must never surface as a broken form.
            }
          }}
          data-provider={p}
          className="rounded-[2px] border px-5 py-2.5 text-[13px] font-medium transition-colors"
          style={{
            borderColor: "var(--color-line-strong)",
            background: "var(--color-surface)",
            color: "var(--color-ink-2)",
          }}
        >
          <span className="flex items-center justify-center gap-2.5">
            <ProviderLogo provider={p} />
            {PROVIDER_META[p]}
          </span>
        </button>
      ))}
    </div>
  );
}
