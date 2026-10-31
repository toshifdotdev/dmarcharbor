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
      aria-labelledby="invitations-head"
      className="flex flex-col gap-3 rounded-sheet border border-rule-2 bg-paper px-5 py-4"
    >
      <div>
        <p id="invitations-head" className="text-h3 font-bold tracking-[-0.01em] text-fg">
          {list.length === 1 ? "You have been invited to a workspace" : `You have been invited to ${list.length} workspaces`}
        </p>
        <p className="mt-1 text-ui text-fg-2">Joining one may be all you need: you do not have to create your own.</p>
      </div>
      <ul className="flex flex-col border-t border-rule">
        {list.map((inv) => (
          <li key={inv.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule py-2.5 last:border-b-0 last:pb-0.5">
            <span className="min-w-0 flex-1">
              <span className="block text-ui font-bold text-fg">{inv.organizationName ?? "A workspace"}</span>
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
