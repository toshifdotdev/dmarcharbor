"use client";

/**
 * invitations.tsx — invitations waiting for the signed-in person.
 *
 * The invitation email links to /welcome, which is where an invited person
 * with no workspace lands; someone who already has one sees the same list above
 * the portfolio. Before this, no screen accepted an invitation, so one could
 * only ever be used through SSO. Read after paint from the
 * organization plugin.
 *
 * The invitation email has no token of its own: it opens /welcome, so that is
 * where a dead invitation has to be explained (`explainLapsed`). A pending
 * invitation past its date says it expired, and one the workspace withdrew
 * says so, each with the next step: ask for a new one. A failed read says it
 * could not check, with a retry; it is never shown as "no invitations".
 */

import { useCallback, useEffect, useState } from "react";
import { acceptInvitation, opsCall, rejectInvitation, type InvitationForMe } from "@/lib/ops-client";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { switchWorkspace } from "./workspace-menu";

/** How far back a lapsed invitation is still worth explaining. */
const LAPSED_WINDOW_MS = 30 * 86_400_000;

export function InvitationsForYou({ explainLapsed = false }: { explainLapsed?: boolean }) {
  const [list, setList] = useState<InvitationForMe[] | null>(null);
  const [lapsed, setLapsed] = useState<InvitationForMe[]>([]);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback((isLive: () => boolean) => {
    opsCall<InvitationForMe[]>("/api/auth/organization/list-user-invitations").then((res) => {
      if (!isLive()) return;
      if (!res.ok || !Array.isArray(res.data)) {
        // A 401 is a session that ended; the page's own sign-in redirect
        // handles that, and "could not check" would be the wrong cause. So is
        // Better Auth's refusal for an address that is not confirmed yet: the
        // invitations are fine, and /welcome says to confirm the address.
        const unconfirmed = !res.ok && res.error?.code === "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION";
        setReadFailed(res.ok || (res.status !== 401 && !unconfirmed));
        return;
      }
      setReadFailed(false);
      const now = Date.now();
      const until = (i: InvitationForMe) => (i.expiresAt ? new Date(i.expiresAt).getTime() : Number.POSITIVE_INFINITY);
      setList(res.data.filter((i) => i.status === "pending" && until(i) > now));
      setLapsed(
        res.data.filter(
          (i) =>
            ((i.status === "pending" && until(i) <= now) || i.status === "canceled") &&
            (!i.expiresAt || now - until(i) < LAPSED_WINDOW_MS),
        ),
      );
    });
  }, []);

  useEffect(() => {
    let live = true;
    read(() => live);
    return () => {
      live = false;
    };
  }, [read]);

  if (readFailed) {
    return (
      <Notice
        tone="warn"
        title="Your invitations could not be checked just now"
        testId="invitations-unread"
        action={
          <Button size="sm" onClick={() => read(() => true)}>
            Check again
          </Button>
        }
      >
        If someone invited you to their workspace, nothing has been accepted or declined. Check again in a moment.
      </Notice>
    );
  }

  if (explainLapsed && (!list || list.length === 0) && lapsed.length > 0) {
    return (
      <Notice tone="info" title="An invitation sent to you has ended" testId="invitations-lapsed">
        <ul className="flex flex-col gap-1">
          {lapsed.map((inv) => (
            <li key={inv.id}>
              {inv.organizationName ? <strong className="font-semibold text-fg">{inv.organizationName}</strong> : "A workspace"}
              {inv.status === "canceled" ? ": the invitation was withdrawn." : ": the invitation has expired."}
            </li>
          ))}
        </ul>
        <p className="mt-1">Ask whoever invited you to send a new one, or create your own workspace below.</p>
      </Notice>
    );
  }

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
