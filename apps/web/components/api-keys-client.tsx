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
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createApiKeyClient, deleteAllRevokedApiKeys, deleteApiKeyRecord, revokeApiKeyClient } from "@/lib/ops-client";
import { ConfirmAction } from "@/components/confirm-action";
import type { ApiErrorBody, ApiKeyRow, IssuedApiKey } from "@/lib/types";

const SCOPE_OPTIONS: Array<"read" | "write"> = ["read", "write"];

/**
 * A copy affordance for a secret that is shown once.
 *
 * It was a paragraph of text you had to drag-select, which is the wrong default
 * for the one field a user cannot come back for. A mis-drag at this point means
 * losing the key and issuing another, which is a support ticket about a UI
 * decision rather than about the product.
 *
 * The clipboard is the only mechanism. `document.execCommand('copy')` was the
 * fallback and is deprecated, and a hidden input holding a live secret to read
 * back is worse than the problem. `navigator.clipboard` needs a secure context,
 * and localhost is one, so it covers local, preview and production alike.
 *
 * The copied flag resets on a timer rather than on the next click, because the
 * confirmation is for the user to glance at and not a state to dismiss.
 */
function CopyKeyButton({ value }: { value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      // A refusal is a permission or a context, and the key is still on screen.
      setState("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }

  return (
    <button
      type="button"
      onClick={copy}
      data-testid="key-copy"
      className="shrink-0 rounded-[2px] px-2.5 py-1 text-[11.5px] font-semibold"
      style={{
        border: "1px solid var(--color-line-strong)",
        background: "var(--color-surface)",
        color: state === "failed" ? "var(--color-block)" : "var(--color-ink-2)",
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Select manually" : "Copy"}
    </button>
  );
}

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
  const revokedKeys = keys.filter((k) => k.revokedAt);

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
          <div className="mt-2.5 flex items-center gap-2">
            <p
              className="num min-w-0 flex-1 break-all rounded-[2px] border px-3 py-2.5 text-[12.5px]"
              style={{
                background: "var(--color-elevate)",
                borderColor: "var(--color-line-strong)",
                color: "var(--color-ink)",
              }}
            >
              {issued.key}
            </p>
            <CopyKeyButton value={issued.key} />
          </div>

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
          {/* No `minLength` on the name, deliberately.
              
              It was there, and it meant the browser's own constraint validation
              blocked the form BEFORE the request was sent, so the operator saw an
              OS-styled tooltip reading "Please lengthen this text to 3 characters
              or more (you are currently using 1 character)." instead of the
              server's message. That tooltip is styled by the operating system, is
              spelled in the browser's own words, and lags behind the field.
              
              `required` stays because an empty name is a different case: the
              server answers it with a real message too, and the form would
              otherwise submit an empty string for no reason. Everything else is
              the server's to say, which is the whole point of the error work. */}
          <label className="flex flex-col gap-1.5">
            <span className="label">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Reporting integration"
              required
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
                      const res = await revokeApiKeyClient(organizationId, k.id);
                      if (!res.ok) setError(res.error);
                      else router.refresh();
                    }}
                    className="text-[11.5px] underline"
                    style={{ color: "var(--color-block)" }}
                    data-testid="key-revoke"
                  >
                    revoke
                  </button>
                ) : (
                  // A revoked key cannot authenticate anything and its name is
                  // already reusable, so the row left on screen is pure residue.
                  // Removing it is tidiness rather than a safety step, which is why
                  // this is a quiet control and the revocation itself was not.
                  <ConfirmAction
                    label="remove"
                    confirmLabel="remove this key"
                    tone="ink"
                    consequence={`Deletes ${k.name} and its ${k.prefix}… record from this list. It already cannot authenticate anything.`}
                    testId={`key-remove-${k.id}`}
                    onConfirm={async () => {
                      const res = await deleteApiKeyRecord(organizationId, k.id);
                      if (!res.ok) return { ok: false, message: res.error?.message };
                      router.refresh();
                      return { ok: true };
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Only when there is residue: a destructive control shown on a screen with
            nothing to clean up is a control nobody should have to read past. */}
        {revokedKeys.length > 0 ? (
          <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--color-line)" }}>
            <ConfirmAction
              label={`Remove all revoked keys (${revokedKeys.length})`}
              confirmLabel={`remove ${revokedKeys.length} revoked key${revokedKeys.length === 1 ? "" : "s"}`}
              consequence={`Deletes ${revokedKeys.length} revoked key${revokedKeys.length === 1 ? "" : "s"} from this list. None of them can authenticate anything.`}
              testId="key-remove-all-revoked"
              onConfirm={async () => {
                const res = await deleteAllRevokedApiKeys(organizationId);
                if (!res.ok) return { ok: false, message: res.error?.message };
                router.refresh();
                return { ok: true };
              }}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}
