"use client";

/**
 * portal-access-client.tsx — the agency-side portal access surface.
 *
 * A grant lets ONE client contact open the read-only portal for ONE client.
 * The copy states the boundary where the grant is made: the contact sees
 * report volume, sending sources and spoofing warnings, and never forensic
 * data or named recipients. Saying it at the grant is the only place the
 * agency decides, so it is the only place the boundary is news.
 *
 * Revoking is confirm-gated: it takes a portal away from a person who may be
 * using it right now, which is not one keystroke from something harmless.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ActionButton } from "@/components/action-button";
import { ConfirmAction } from "@/components/confirm-action";
import { grantPortalAccess, revokePortalAccess } from "@/lib/ops-client";
import type { ApiErrorBody, PortalGrant } from "@/lib/types";

export function PortalAccessPanel({
  organizationId,
  clients,
  grants,
  origin,
}: {
  organizationId: string;
  clients: Array<{ id: string; name: string }>;
  grants: PortalGrant[];
  /** The public origin this request was served on: the portal URL sent to a
   *  contact must be their agency's address on a branded custom domain. */
  origin: string;
}) {
  const router = useRouter();
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiErrorBody["error"] | string | null>(null);
  const [created, setCreated] = useState<PortalGrant | null>(null);

  async function grant(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId || !email.trim()) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    const res = await grantPortalAccess(organizationId, clientId, {
      email: email.trim(),
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setCreated(res.data);
    setEmail("");
    setDisplayName("");
    router.refresh();
  }

  const active = grants.filter((g) => g.active);
  const revoked = grants.filter((g) => !g.active);
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? id;

  return (
    <section
      className="lift rounded-[2px] border"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
    >
      <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
        <h2 className="text-[16px] font-semibold tracking-[-0.012em]">Portal access grants</h2>
        <p className="mt-1.5 max-w-3xl text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          A grant lets one client contact open the read-only portal for one
          client. They see report volume, sending sources and spoofing
          warnings. They never see forensic data or named recipients. Send the
          portal address below once the grant is active.
        </p>
      </header>

      <form onSubmit={grant} className="flex flex-wrap items-end gap-3 border-b px-5 py-4" style={{ borderColor: "var(--color-line)" }}>
        <label className="flex flex-col gap-1.5">
          <span className="label">Client</span>
          <select
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            data-testid="portal-client"
            className="rounded-[2px] border px-3 py-2 text-[13.5px]"
            style={{ background: "var(--color-elevate)", borderColor: "var(--color-line-strong)", color: "var(--color-ink)" }}
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label">Contact email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ops@client.example"
            data-testid="portal-email"
            className="rounded-[2px] border px-3 py-2 text-[13.5px]"
            style={{ background: "var(--color-elevate)", borderColor: "var(--color-line-strong)", color: "var(--color-ink)" }}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label">Name (optional)</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Sam Morgan"
            className="rounded-[2px] border px-3 py-2 text-[13.5px]"
            style={{ background: "var(--color-elevate)", borderColor: "var(--color-line-strong)", color: "var(--color-ink)" }}
          />
        </label>
        <ActionButton
          label="Grant portal access"
          loadingLabel="Granting…"
          busy={busy}
          type="submit"
          testId="portal-grant"
          style={{ padding: "8px 16px", fontSize: "13px" }}
        />
      </form>

      {error ? (
        <p role="alert" className="border-b px-5 py-3 text-[13px]" style={{ borderColor: "var(--color-line)", color: "var(--color-block)" }}>
          {typeof error === "string" ? error : error.message}
        </p>
      ) : null}

      {created ? (
        <div className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }} data-testid="portal-granted">
          <p role="status" className="text-[13px]" style={{ color: "var(--color-pass)" }}>
            Granted. The grant activates the first time {created.email} signs in
            with that address, and covers {created.clientName} only.
          </p>
          <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
            Send them the portal address:{" "}
            <span className="num" style={{ color: "var(--color-ink)" }}>
              {origin}/portal
            </span>
            . They will see only the clients granted to them.
          </p>
        </div>
      ) : null}

      {active.length > 0 ? (
        <ul data-testid="portal-grants">
          {active.map((g) => (
            <li
              key={g.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-5 py-3.5"
              style={{ borderColor: "rgba(255,255,255,0.055)" }}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px]" style={{ color: "var(--color-ink)" }}>
                  {g.displayName ?? g.email}{" "}
                  <span className="num text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
                    {g.email}
                  </span>
                </div>
                <div className="mt-0.5 text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                  {clientName(g.clientId)} · granted{" "}
                  {new Date(g.createdAt).toLocaleDateString("en-GB")} ·{" "}
                  {g.bound
                    ? `signed in ${g.firstSeenAt ? new Date(g.firstSeenAt).toLocaleDateString("en-GB") : ""}`
                    : "not yet activated"}
                </div>
              </div>
              <ConfirmAction
                label="Revoke"
                confirmLabel="Revoke this access"
                consequence={`Revoke ${g.email}'s access to ${clientName(g.clientId)}? They lose the portal the next time they load it.`}
                onConfirm={async () => {
                  const res = await revokePortalAccess(organizationId, g.id);
                  if (res.ok) router.refresh();
                  else setError(res.error);
                }}
                testId={`portal-revoke-${g.id}`}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 py-4 text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
          No grants yet. The portal exists but nobody can reach it until one is
          made here.
        </p>
      )}

      {revoked.length > 0 ? (
        <div className="border-t px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
          <div className="label">Revoked</div>
          <ul className="mt-1.5 flex flex-col gap-1">
            {revoked.map((g) => (
              <li key={g.id} className="text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                {g.email} · {clientName(g.clientId)} · revoked
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
