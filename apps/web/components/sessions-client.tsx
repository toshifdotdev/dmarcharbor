"use client";

/**
 * sessions-client.tsx — account sessions, for customers who are security
 * buyers.
 *
 * "Sign out everywhere else" is the lost-laptop action and the one an MSP
 * actually uses, so it is the primary control and it spares this session
 * (POST /me/sessions/revoke-others). Revoke-all is the deliberate nuke: it
 * revokes the session making the request too — the correct semantic for a
 * control named "including this device", because a compromised account must be
 * able to sign itself out. It confirms before firing.
 *
 * The API exposes id, current, createdAt, expiresAt, ipAddress and userAgent.
 * There is no last-seen field: the UI renders what exists (created / expires)
 * and never invents a last-seen timestamp.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  revokeAllSessions,
  revokeOtherSessions,
  revokeSession,
} from "@/lib/ops-client";
import { ConfirmAction } from "@/components/confirm-action";
import type { SessionRow } from "@/lib/types";

export function SessionsPanel({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const others = sessions.filter((s) => !s.current);

  function deviceLabel(s: SessionRow): string {
    const ua = s.userAgent ?? "";
    if (!ua) return "unknown device";
    const os = /windows/i.test(ua)
      ? "Windows"
      : /mac os|macintosh/i.test(ua)
        ? "macOS"
        : /android/i.test(ua)
          ? "Android"
          : /iphone|ipad|ios/i.test(ua)
            ? "iOS"
            : /linux/i.test(ua)
              ? "Linux"
              : "";
    const browser = /edg\//i.test(ua)
      ? "Edge"
      : /chrome\//i.test(ua)
        ? "Chrome"
        : /firefox\//i.test(ua)
          ? "Firefox"
          : /safari\//i.test(ua)
            ? "Safari"
            : /curl/i.test(ua)
              ? "curl"
              : "";
    return [browser, os].filter(Boolean).join(" · ") || "unknown device";
  }

  return (
    <section
      className="lift rounded-[2px] border p-5"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
    >
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
          {sessions.length} signed-in session{sessions.length === 1 ? "" : "s"}
        </h2>
        <p className="text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
          device and network for each: revoke anything you do not recognise
        </p>
        <div className="ml-auto flex items-center gap-3">
          {others.length > 0 ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("others");
                setError(null);
                await revokeOtherSessions().catch(() => setError("Sessions could not be revoked."));
                setBusy(null);
                router.refresh();
              }}
              data-testid="revoke-others"
              className="rounded-[2px] border px-3.5 py-2 text-[12px] font-semibold"
              style={{ borderColor: "var(--color-line-strong)", color: "var(--color-ink-2)" }}
            >
              Sign out everywhere else
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setConfirmAll((v) => !v)}
            data-testid="revoke-all-toggle"
            className="rounded-[2px] border px-3.5 py-2 text-[12px] font-semibold"
            style={{ borderColor: "var(--color-block)", color: "var(--color-block)" }}
          >
            Sign out everywhere (including this device)
          </button>
        </div>
      </header>

      {/* The nuke confirms — it revokes the session making this request too. */}
      {confirmAll ? (
        <div
          role="alert"
          data-testid="revoke-all-confirm"
          className="mt-3 rounded-[2px] border px-4 py-3"
          style={{ borderColor: "var(--color-block)", background: "var(--color-block-soft)" }}
        >
          <p className="text-[13px]" style={{ color: "var(--color-ink-2)" }}>
            This signs out <strong style={{ color: "var(--color-ink)" }}>every session,
            including this one</strong>: you will be returned to the sign-in
            screen. Use it when you believe the account itself is compromised:
            a compromised account must be able to sign itself out. To keep this
            device signed in, use "Sign out everywhere else".
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("all");
                await revokeAllSessions().catch(() => {
                  /* the caller is signed out regardless */
                });
                window.location.href = "/sign-in";
              }}
              data-testid="revoke-all-confirm-button"
              className="rounded-[2px] px-4 py-2 text-[12.5px] font-semibold"
              style={{ background: "var(--color-block)", color: "#fff" }}
            >
              Yes: sign out everywhere, including this device
            </button>
            <button
              type="button"
              onClick={() => setConfirmAll(false)}
              className="text-[12px]"
              style={{ color: "var(--color-ink-3)" }}
            >
              keep this device signed in
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-[12.5px]" style={{ color: "var(--color-block)" }}>
          {error}
        </p>
      ) : null}

      <ul className="mt-4">
        {sessions.map((s) => (
          <li
            key={s.id}
            data-testid={s.current ? "session-current" : "session-row"}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-3"
            style={{
              borderColor: "rgba(255,255,255,0.055)",
              boxShadow: s.current ? "inset 2px 0 0 var(--color-accent)" : undefined,
              paddingLeft: s.current ? 12 : 0,
            }}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px]" style={{ color: "var(--color-ink)" }}>
                {deviceLabel(s)}
                {s.current ? (
                  <span
                    className="num ml-2 text-[10px] tracking-[0.12em] uppercase"
                    style={{ color: "var(--color-accent)" }}
                  >
                    this device
                  </span>
                ) : null}
              </div>
              <div className="num text-[11px]" style={{ color: "var(--color-ink-3)" }}>
                {/* The API exposes created and expires — no last-seen field
                    exists, so none is invented. Location is approximate:
                    only the IP is recorded. */}
                started {new Date(s.createdAt).toLocaleString("en-GB")} · expires{" "}
                {new Date(s.expiresAt).toLocaleDateString("en-GB")} ·{" "}
                {s.ipAddress ? `≈ ${s.ipAddress}` : "network not recorded"}
              </div>
            </div>
            {!s.current ? (
              // Revoking a session signs a device out: destructive, so it
              // arms first and names what it does rather than firing on one
              // keystroke beside harmless chrome.
              <ConfirmAction
                label="revoke"
                confirmLabel="yes, revoke"
                consequence="that device is signed out immediately"
                testId="session-revoke"
                busy={busy !== null}
                onConfirm={async () => {
                  setBusy(s.id);
                  await revokeSession(s.id).catch(() => setError("That session could not be revoked."));
                  setBusy(null);
                  router.refresh();
                }}
              />
            ) : (
              <span className="num text-[10.5px]" style={{ color: "var(--color-ink-3)" }}>
                cannot revoke the session you are on
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
