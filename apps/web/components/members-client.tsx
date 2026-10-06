"use client";

/**
 * members-client.tsx — invitations, role changes and offboarding.
 *
 * The role set is the permissions matrix in apps/api/src/auth/permissions.ts:
 * owner, admin, analyst, viewer, portal. The UI offers exactly those five and
 * nothing else, so it can never offer a role whose permissions the matrix does
 * not grant. `portal` is offered here too: a client contact IS a member with
 * the portal role plus a portal grant, and hiding the role would make the
 * roster disagree with the matrix.
 *
 * The roster is never cached client-side: every mutation refreshes from the
 * server (router.refresh()), so a removal applies on the next load and a stale
 * list cannot keep a removed colleague looking present.
 *
 * All four operations go through better-auth's organization endpoints, the
 * same surface that created the membership: no invented routes.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ActionButton } from "@/components/action-button";
import { ConfirmAction } from "@/components/confirm-action";

/** The five roles, exactly as the permissions matrix names them. */
const ROLES = ["owner", "admin", "analyst", "viewer", "portal"] as const;
type Role = (typeof ROLES)[number];

interface Member {
  id: string;
  userId: string;
  role: string;
  user?: { id: string; name: string; email: string };
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  status?: string;
  expiresAt?: string | null;
}

async function authCall<T>(path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(`/api/auth/organization/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const message =
        (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string"
          ? parsed.message
          : null) ?? `Request failed (${res.status}).`;
      return { ok: false, message };
    }
    return { ok: true, data: (parsed ?? undefined) as T };
  } catch {
    return { ok: false, message: "The request could not be sent." };
  }
}

export function MembersManager({
  organizationId,
  members,
  invitations,
}: {
  organizationId: string;
  members: Member[];
  invitations: Invitation[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("analyst");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNote(label);
    // The roster is re-read from the server: a removal must apply on the next
    // load, never linger in a client-side cache.
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <section
        className="lift rounded-[2px] border"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      >
        <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
          <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
            Invite a teammate
          </h2>
          <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
            Five roles, straight from the permission model: owner, admin,
            analyst, viewer, portal. Nothing else can be granted here.
          </p>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!email.trim()) return;
            run("Invitation sent.", () =>
              authCall("invite-member", {
                organizationId,
                email: email.trim(),
                role,
              }).then((r) => (r.ok ? { ok: true } : r)),
            );
            setEmail("");
          }}
          className="flex flex-wrap items-end gap-3 px-5 py-4"
        >
          <label className="flex flex-col gap-1.5">
            <span className="label">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@youragency.example"
              data-testid="invite-email"
              className="rounded-[2px] border px-3 py-2 text-[13.5px]"
              style={{ background: "var(--color-elevate)", borderColor: "var(--color-line-strong)", color: "var(--color-ink)" }}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              data-testid="invite-role"
              className="rounded-[2px] border px-3 py-2 text-[13.5px]"
              style={{ background: "var(--color-elevate)", borderColor: "var(--color-line-strong)", color: "var(--color-ink)" }}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <ActionButton
            label="Send invitation"
            loadingLabel="Sending…"
            busy={busy}
            type="submit"
            testId="invite-send"
            style={{ padding: "8px 16px", fontSize: "13px" }}
          />
        </form>
        {error ? (
          <p role="alert" className="border-t px-5 py-3 text-[13px]" style={{ borderColor: "var(--color-line)", color: "var(--color-block)" }}>
            {error}
          </p>
        ) : null}
        {note ? (
          <p role="status" className="border-t px-5 py-3 text-[13px]" style={{ borderColor: "var(--color-line)", color: "var(--color-pass)" }}>
            {note}
          </p>
        ) : null}
      </section>

      {invitations.length > 0 ? (
        <section
          className="lift rounded-[2px] border"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
        >
          <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
            <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
              Pending invitations ({invitations.length})
            </h2>
          </header>
          <ul data-testid="pending-invitations">
            {invitations.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-5 py-3"
                style={{ borderColor: "rgba(255,255,255,0.055)" }}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px]" style={{ color: "var(--color-ink)" }}>
                    {inv.email}
                  </div>
                  <div className="num text-[11px] uppercase tracking-[0.12em]" style={{ color: "var(--color-ink-3)" }}>
                    {inv.role}
                    {inv.expiresAt
                      ? ` · expires ${new Date(inv.expiresAt).toLocaleDateString("en-GB")}`
                      : ""}
                  </div>
                </div>
                <ConfirmAction
                  label="Withdraw"
                  confirmLabel="Withdraw the invitation"
                  consequence={`Withdraw the invitation to ${inv.email}? They can no longer join with it.`}
                  onConfirm={() =>
                    run("Invitation withdrawn.", () =>
                      authCall("cancel-invitation", {
                        organizationId,
                        invitationId: inv.id,
                      }).then((r) => (r.ok ? { ok: true } : r)),
                    )
                  }
                  testId={`invite-withdraw-${inv.id}`}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        className="lift rounded-[2px] border"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      >
        <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
          <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
            Who is here ({members.length})
          </h2>
        </header>
        <ul data-testid="member-roster">
          {members.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-5 py-3"
              style={{ borderColor: "rgba(255,255,255,0.055)" }}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px]" style={{ color: "var(--color-ink)" }}>
                  {m.user?.name ?? m.user?.email ?? m.userId}
                </div>
                <div className="text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                  {m.user?.email}
                </div>
              </div>
              <select
                value={ROLES.includes(m.role as Role) ? m.role : "viewer"}
                disabled={busy || m.role === "owner"}
                onChange={(e) =>
                  run("Role updated.", () =>
                    authCall("update-member-role", {
                      organizationId,
                      memberId: m.id,
                      role: e.target.value,
                    }).then((r) => (r.ok ? { ok: true } : r)),
                  )
                }
                data-testid={`member-role-${m.id}`}
                aria-label={`Role for ${m.user?.email ?? m.userId}`}
                className="rounded-[2px] border px-2 py-1.5 text-[12px] disabled:cursor-not-allowed"
                style={{
                  background: "var(--color-elevate)",
                  borderColor: "var(--color-line-strong)",
                  color: "var(--color-ink)",
                  opacity: m.role === "owner" ? 0.5 : 1,
                }}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              {m.role === "owner" ? (
                <span className="num text-[10.5px] uppercase tracking-[0.12em]" style={{ color: "var(--color-ink-3)" }}>
                  the owner
                </span>
              ) : (
                <ConfirmAction
                  label="Remove"
                  confirmLabel="Remove from the workspace"
                  consequence={`Remove ${m.user?.email ?? m.userId} from this workspace? They lose access immediately.`}
                  onConfirm={() =>
                    run("Member removed.", () =>
                      authCall("remove-member", {
                        organizationId,
                        memberIdOrEmail: m.id,
                      }).then((r) => (r.ok ? { ok: true } : r)),
                    )
                  }
                  testId={`member-remove-${m.id}`}
                />
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
