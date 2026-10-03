"use client";

/**
 * api-keys-client.tsx — keys for the public API.
 *
 * A key is shown ONCE at creation and never again: the create response carries
 * `key` exactly once and only its prefix survives. The UI makes that
 * irreversible — the value is presented in a one-time panel with no way to
 * recover it after dismissal, and the list only ever shows prefixes.
 */

import { ActionButton } from "@/components/action-button";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createApiKeyClient, revokeApiKeyClient } from "@/lib/ops-client";
import type { ApiErrorBody, ApiKeyRow, IssuedApiKey } from "@/lib/types";

const SCOPE_OPTIONS: Array<"read" | "write"> = ["read", "write"];

export function ApiKeysPanel({
  organizationId,
  keys,
}: {
  organizationId: string;
  keys: ApiKeyRow[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Array<"read" | "write">>(["read"]);
  const [expiresInDays, setExpiresInDays] = useState(365);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [busy, setBusy] = useState(false);

  const active = keys.filter((k) => !k.revokedAt);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setIssued(null);
    const res = await createApiKeyClient(organizationId, {
      name,
      scopes,
      expiresInDays,
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setName("");
      // The only moment this key exists in the browser. After dismissal the
      // API cannot return it again.
      setIssued(res.data);
      router.refresh();
    }
  }

  function toggleScope(s: "read" | "write") {
    setScopes((prev) => {
      if (prev.includes(s)) {
        // A key with no scope is meaningless: the last one cannot come off.
        return prev.length === 1 ? prev : prev.filter((x) => x !== s);
      }
      return [...prev, s];
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {/* The one-time panel. Dismissing it destroys the copy; the API cannot
          retrieve the key again, and neither can this page. */}
      {issued ? (
        <div
          role="alert"
          data-testid="key-issued"
          className="rounded-[2px] border px-5 py-4"
          style={{
            borderColor: "var(--color-accent)",
            background: "var(--color-accent-soft)",
          }}
        >
          <p
            className="num text-[11px] font-semibold tracking-[0.12em] uppercase"
            style={{ color: "var(--color-ink)" }}
          >
            Copy this key now: it is shown once
          </p>
          <p
            className="num mt-2.5 break-all rounded-[2px] border px-3 py-2.5 text-[12.5px]"
            style={{
              background: "var(--color-elevate)",
              borderColor: "var(--color-line-strong)",
              color: "var(--color-ink)",
            }}
          >
            {issued.key}
          </p>
          <p className="mt-2.5 text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
            This key cannot be retrieved again: the platform stores only a hash
            of it. If you lose it, revoke the key and issue a new one. Scope:{" "}
            <span className="num">{issued.scopes.join(", ")}</span>, expires{" "}
            {new Date(issued.expiresAt).toLocaleDateString("en-GB")}.
          </p>
          <ActionButton
            label="Dismiss"
            busy={false}
            onClick={() => setIssued(null)}
            variant="ghost"
            testId="key-dismiss"
            style={{ marginTop: 12 }}
          />
        </div>
      ) : null}

      <section
        className="lift rounded-[2px] border p-5"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      >
        <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">Issue a key</h2>
        <p className="mt-2 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          The key is shown once, at creation. Everything else: the name, the
          scopes, the expiry: can be read here at any time.
        </p>

        {error ? (
          <p role="alert" className="mt-3 text-[14px]" style={{ color: "var(--color-block)" }}>
            {error.message}
          </p>
        ) : null}

        <form onSubmit={create} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="label">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Reporting integration"
              required
              minLength={3}
              data-testid="key-name"
              style={{
                background: "var(--color-elevate)",
                border: "1px solid var(--color-line-strong)",
                borderRadius: 2,
                color: "var(--color-ink)",
                padding: "7px 10px",
                fontSize: 14,
                outline: "none",
              }}
            />
          </label>

          <div className="flex flex-wrap items-center gap-4">
            <span className="label">Scopes</span>
            {SCOPE_OPTIONS.map((s) => (
              <label key={s} className="flex items-center gap-2 text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  disabled={scopes.includes(s) && scopes.length === 1}
                  onChange={() => toggleScope(s)}
                />
                {s}
              </label>
            ))}
            <label className="ml-auto flex items-center gap-2 text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
              expires in
              <select
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(Number(e.target.value))}
                style={{
                  background: "var(--color-elevate)",
                  border: "1px solid var(--color-line-strong)",
                  borderRadius: 2,
                  color: "var(--color-ink)",
                  padding: "7px 10px",
                  fontSize: 14,
                }}
              >
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={365}>1 year</option>
              </select>
            </label>
          </div>

          <ActionButton
            label="Issue key"
            loadingLabel="Issuing…"
            busy={busy}
            disabled={!name.trim()}
            type="submit"
            testId="key-create"
            style={{ alignSelf: "flex-start" }}
          />
        </form>

        {active.length === 0 ? (
          <p className="mt-5 text-[13px]" style={{ color: "var(--color-ink-3)" }}>
            No active keys.
          </p>
        ) : (
          <ul className="mt-5 border-t pt-3" style={{ borderColor: "var(--color-line)" }}>
            {keys.map((k) => (
              <li
                key={k.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b py-3"
                style={{
                  borderColor: "rgba(255,255,255,0.055)",
                  opacity: k.revokedAt ? 0.55 : 1,
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px]" style={{ color: "var(--color-ink)" }}>
                    {k.name}
                  </div>
                  <div className="num text-[11px]" style={{ color: "var(--color-ink-3)" }}>
                    {k.prefix}… · {k.scopes.join(", ")}
                    {k.lastUsedAt
                      ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString("en-GB")}`
                      : " · never used"}
                  </div>
                </div>
                <span
                  className="num text-[10px] tracking-[0.12em] uppercase"
                  style={{ color: k.revokedAt ? "var(--color-ink-3)" : "var(--color-pass)" }}
                >
                  {k.revokedAt ? "revoked" : "active"}
                </span>
                {!k.revokedAt ? (
                  <button
                    type="button"
                    onClick={async () => {
                      await revokeApiKeyClient(organizationId, k.id);
                      router.refresh();
                    }}
                    className="text-[11.5px] underline"
                    style={{ color: "var(--color-block)" }}
                    data-testid="key-revoke"
                  >
                    revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
