"use client";

/**
 * invitations.tsx — invitations waiting for the signed-in person.
 *
 * The invitation email links to /welcome, which is where an invited person
 * with no workspace lands; someone who already has one sees the same list above
 * the portfolio. Before this, no screen accepted an invitation, so one could
 * only ever be used through SSO. Read after paint from the
 * organization plugin; a failed read renders nothing rather than a false "no
 * invitations".
 */

import { useEffect, useState } from "react";
import { acceptInvitation, opsCall, rejectInvitation, type InvitationForMe } from "@/lib/ops-client";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { switchWorkspace } from "./workspace-menu";

export function InvitationsForYou() {
  const [list, setList] = useState<InvitationForMe[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    opsCall<InvitationForMe[]>("/api/auth/organization/list-user-invitations").then((res) => {
      if (!live || !res.ok || !Array.isArray(res.data)) return;
      const now = Date.now();
      setList(res.data.filter((i) => i.status === "pending" && (!i.expiresAt || new Date(i.expiresAt).getTime() > now)));
    });
    return () => {
      live = false;
    };
  }, []);

  if (!list || list.length === 0) return null;

  async function accept(inv: InvitationForMe) {
    setBusy(inv.id);
    setError(null);
    const res = await acceptInvitation(inv.id);
    if (!res.ok) {
      setBusy(null);
      setError(res.error.message ?? "The invitation could not be accepted.");
      return;
    }
    switchWorkspace(inv.organizationId);
    window.location.assign("/");
  }

  async function decline(inv: InvitationForMe) {
    setBusy(inv.id);
    setError(null);
    const res = await rejectInvitation(inv.id);
    setBusy(null);
    if (!res.ok) {
      setError(res.error.message ?? "The invitation could not be declined.");
      return;
    }
    setList((l) => (l ?? []).filter((x) => x.id !== inv.id));
  }

  return (
    <section
      data-testid="invitations-for-you"
      className="flex flex-col gap-3 rounded-ctl border border-act/40 bg-paper-2 px-4 py-3.5 shadow-[0_0_0_3px_var(--color-act-line)] [animation:hb-rise_240ms_ease-out]"
    >
      <div>
        <p className="legend text-act!">Waiting for you</p>
        <p className="mt-0.5 text-body font-semibold text-fg">
          {list.length === 1 ? "You have been invited to a workspace" : `You have been invited to ${list.length} workspaces`}
        </p>
        <p className="mt-0.5 text-ui text-fg-2">Joining one may be all you need: you do not have to create your own.</p>
      </div>
      <ul className="flex flex-col border-t border-rule">
        {list.map((inv) => (
          <li key={inv.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block text-ui font-semibold text-fg">{inv.organizationName ?? "A workspace"}</span>
              <span className="block text-meta text-fg-3">
                As <span className="capitalize">{inv.role}</span>
                {inv.expiresAt ? `, until ${new Date(inv.expiresAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}` : ""}
              </span>
            </span>
            <Button size="sm" variant="primary" onClick={() => accept(inv)} busy={busy === inv.id} busyLabel="Joining">
              Join
            </Button>
            <Button size="sm" variant="ghost" onClick={() => decline(inv)} disabled={busy === inv.id}>
              Decline
            </Button>
          </li>
        ))}
      </ul>
      {error ? <Notice tone="fail" title={error} /> : null}
    </section>
  );
}
