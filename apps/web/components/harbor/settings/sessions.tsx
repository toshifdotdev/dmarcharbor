"use client";

/**
 * sessions.tsx — every device signed in as you, and signing them out.
 *
 * The decision here is revocation, and the cost of a wrong one is lopsided:
 * signing out a device you still use costs one sign-in, while leaving a lost
 * laptop signed in costs everything it can reach. So the controls lean towards
 * revoking, and the page says the cost of each in those terms.
 *
 * Three actions, ordered by how often they are the right one:
 *   one device          when you recognise exactly which one
 *   every other device  the lost-laptop action: this one stays signed in
 *   everywhere          including this device, for a password you think is
 *                       known; confirmed, because it ends this page too
 *
 * The API reports when a session started and when it ends, and nothing about
 * when it was last used, so the page does not imply it knows.
 *
 * Test hooks: session-current, session-row, session-revoke (+ -confirm),
 * revoke-others, revoke-all-toggle, revoke-all-confirm(-button).
 */

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { revokeAllSessions, revokeOtherSessions, revokeSession } from "@/lib/ops-client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { useToast } from "@/components/ui/toast";
import { Panel } from "./parts";

export interface SessionView {
  id: string;
  current: boolean;
  device: string;
  userAgent: string | null;
  ip: string | null;
  startedLabel: string;
  endsLabel: string;
}

/** The columns, shared by the header row and every session row from md up. */
const COLS = "md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_8.5rem]";

function Row({ s, onRevoke }: { s: SessionView; onRevoke?: () => void }) {
  return (
    <li
      data-testid={s.current ? "session-current" : "session-row"}
      className={`relative grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1.5 border-b border-rule py-3.5 pl-7 ${COLS}`}
    >
      <span
        aria-hidden
        className={
          s.current
            ? "absolute -left-[3px] top-[18px] block h-[15px] w-[21px] rounded-full border-[3px] border-fg bg-paper"
            : "absolute left-[2px] top-[19px] block size-[11px] rounded-full border-2 border-fg-4 bg-paper"
        }
      />
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-2.5 text-body font-semibold text-fg">
          {s.device}
          {s.current ? <span className="text-meta font-semibold text-fg-2">This device</span> : null}
        </p>
        {s.userAgent ? (
          <details className="mt-1 text-meta text-fg-3">
            <summary className="cursor-pointer select-none hover:text-fg">What the browser reported</summary>
            <code className="data mt-1 block break-all text-fg-2">{s.userAgent}</code>
          </details>
        ) : null}
        <dl className="mt-1.5 flex flex-col gap-0.5 text-meta text-fg-3 md:hidden">
          <div>
            <dt className="inline">From </dt>
            <dd className="data inline text-fg-2">{s.ip ?? "an address not reported"}</dd>
          </div>
          <div>
            <dt className="inline">Signed in </dt>
            <dd className="inline text-fg-2">{s.startedLabel}</dd>
          </div>
          <div>
            <dt className="inline">Ends on its own </dt>
            <dd className="inline text-fg-2">{s.endsLabel}</dd>
          </div>
        </dl>
      </div>
      <p className="hidden pt-[2px] text-ui md:block">
        <span className="sr-only">From </span>
        {s.ip ? <span className="data break-all text-fg">{s.ip}</span> : <span className="text-fg-3">Not reported</span>}
      </p>
      <p className="hidden pt-[2px] text-ui text-fg md:block">
        <span className="sr-only">Signed in </span>
        {s.startedLabel}
      </p>
      <p className="hidden pt-[2px] text-ui text-fg md:block">
        <span className="sr-only">Ends on its own </span>
        {s.endsLabel}
      </p>
      <div className="flex justify-end">
        {onRevoke ? (
          <Button size="sm" variant="secondary" onClick={onRevoke} data-testid="session-revoke">
            Sign out
          </Button>
        ) : (
          <span className="max-w-[16ch] pt-[2px] text-right text-meta text-fg-3">Sign out from the account menu</span>
        )}
      </div>
    </li>
  );
}

export function SessionsBoard({ sessions }: { sessions: SessionView[] }) {
  const router = useRouter();
  const toast = useToast();
  const current = sessions.find((s) => s.current) ?? null;
  const others = sessions.filter((s) => !s.current);

  const [target, setTarget] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState<"one" | "others" | "all" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function revokeOne() {
    if (!target) return;
    setBusy("one");
    setError(null);
    const res = await revokeSession(target.id);
    setBusy(null);
    if (!res.ok) {
      setError(res.status === 404 ? "That session had already ended." : (res.error.message ?? "The session could not be signed out."));
      if (res.status === 404) router.refresh();
      return;
    }
    toast({ title: `${target.device} is signed out`, tone: "ok" });
    setTarget(null);
    router.refresh();
  }

  async function revokeOthers() {
    setBusy("others");
    setError(null);
    setNotice(null);
    const res = await revokeOtherSessions();
    setBusy(null);
    if (!res.ok) {
      setError(
        res.status === 429
          ? "Too many sign-out requests in a short time. Wait a minute and try again."
          : (res.error.message ?? "The other devices could not be signed out."),
      );
      return;
    }
    setNotice(`Every other device is signed out. This one stays signed in.`);
    router.refresh();
  }

  async function revokeEverywhere() {
    setBusy("all");
    setError(null);
    const res = await revokeAllSessions();
    if (!res.ok) {
      setBusy(null);
      setError(
        res.status === 429
          ? "Too many sign-out requests in a short time. Wait a minute and try again."
          : (res.error.message ?? "The sessions could not be signed out."),
      );
      return;
    }
    // This device went with the rest; the sign-in page is the honest next step.
    window.location.assign("/sign-in");
  }

  return (
    <div className="flex flex-col gap-14">
      <Panel
        id="sessions-head"
        title="Where you are signed in"
        why="Each session ends on its own at the time shown, unless it is renewed by use. Signing one out ends it now."
        aside={
          <span className="tnum font-semibold text-fg-2">
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
            {others.length > 0 ? <span className="font-normal text-fg-3">, {others.length} on other devices</span> : null}
          </span>
        }
      >
        <div>
          <div
            aria-hidden
            className={`hidden gap-x-4 border-b border-rule-2 pb-2 pl-7 text-meta font-semibold text-fg-3 md:grid ${COLS}`}
          >
            <span>Device</span>
            <span>From</span>
            <span>Signed in</span>
            <span>Ends on its own</span>
            <span />
          </div>
          <ul className="flex flex-col">
            {current ? <Row s={current} /> : null}
            {others.map((s) => (
              <Row
                key={s.id}
                s={s}
                onRevoke={() => {
                  setError(null);
                  setTarget(s);
                }}
              />
            ))}
          </ul>
        </div>
        {others.length === 0 ? (
          <p className="text-ui text-fg-2">No other device is signed in as you. If one appears that you do not recognise, sign it out here.</p>
        ) : null}
        {notice ? <Notice tone="ok" title={notice} /> : null}
        {error && !target ? <Notice tone="fail" title={error} /> : null}
      </Panel>

      <Panel
        id="sessions-act"
        title="Lost a device?"
        why="Sign out everything except the device you are using now. Your work and settings are untouched; the other devices need the password again."
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button
            variant="primary"
            onClick={revokeOthers}
            busy={busy === "others"}
            busyLabel="Signing out the other devices"
            disabled={others.length === 0 || busy !== null}
            data-testid="revoke-others"
          >
            Sign out every other device
          </Button>
          <span className="tnum text-meta text-fg-3">
            {others.length === 0
              ? "Nothing to sign out: this is the only device."
              : `${others.length} device${others.length === 1 ? "" : "s"} will need the password again. This one stays signed in.`}
          </span>
        </div>
      </Panel>

      <section aria-labelledby="sessions-all" className="flex flex-col gap-4 border-t-2 border-fg pt-4">
        <div>
          <h2 id="sessions-all" className="display text-h2 text-fg">
            Think someone knows your password?
          </h2>
          <p className="mt-1.5 max-w-[72ch] text-ui text-fg-2">
            Sign out everywhere, this device included, then choose a new password from the sign-in page
            (&ldquo;Forgot your password?&rdquo;). Until the password changes, anyone who has it can sign straight back in.
          </p>
          <p className="mt-2 text-ui text-fg-2">
            Add a second step as well:{" "}
            <Link href="/account/security" className="link font-semibold">
              set up two-step verification
            </Link>
            , so a password alone is not enough.
          </p>
        </div>
        <div>
          <Button variant="danger" onClick={() => setAllOpen(true)} data-testid="revoke-all-toggle">
            Sign out everywhere, including this device
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={target !== null}
        onClose={() => {
          setTarget(null);
          setError(null);
        }}
        onConfirm={revokeOne}
        title={target ? `Sign out ${target.device}?` : "Sign out this device?"}
        body={
          target ? (
            <>
              The session from <span className="data text-fg">{target.ip ?? "an unreported address"}</span>, started{" "}
              {target.startedLabel}, is signed out at once. Whoever is using it has to sign in again with the password.
            </>
          ) : null
        }
        confirmLabel="Sign out that device"
        busy={busy === "one"}
        danger
        error={target ? error : null}
        testId="session-revoke"
      />

      <Dialog
        open={allOpen}
        onClose={() => (busy === "all" ? undefined : setAllOpen(false))}
        title="Sign out everywhere?"
        testId="revoke-all-confirm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAllOpen(false)} disabled={busy === "all"}>
              Keep this device signed in
            </Button>
            <Button
              variant="danger"
              onClick={revokeEverywhere}
              busy={busy === "all"}
              busyLabel="Signing out everywhere"
              data-testid="revoke-all-confirm-button"
            >
              Sign out everywhere
            </Button>
          </>
        }
      >
        <p className="text-body text-fg-2">
          Every session on this account ends now, including this device: you will be taken to the sign-in page. Nothing
          else changes.
        </p>
        {error && allOpen ? (
          <p role="alert" className="mt-3 text-ui font-medium text-fail">
            {error}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
