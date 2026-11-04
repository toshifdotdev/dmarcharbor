"use client";

/**
 * change-password.tsx — the account's password, from Account security.
 *
 * For an account that has one: the current password, a new one counted
 * against the same 8-character rule as sign-up, and "Sign out my other
 * devices", ticked by default because the usual reason to change a password
 * is that someone else may know it. The API refuses a password found in a
 * known breach and emails a confirmation; the audit trail records the change.
 *
 * For an account that signs in only with Google, Microsoft or single sign-on,
 * there is nothing to change. It says how the account signs in, and sets a
 * first password through the same reset link as "Forgot password?", which
 * proves the person holds the mailbox.
 *
 * Test hooks: password-change-form, password-current, password-new,
 * password-signout-others, password-change-submit, password-changed,
 * password-set-link.
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { changePassword, requestPasswordReset } from "@/lib/auth-client";
import {
  MAX_PASSWORD,
  MIN_PASSWORD,
  changePasswordProblem,
  passwordLength,
  passwordLengthHint,
  signInProviderList,
  type SignInProvider,
} from "@/lib/password-rules";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { Field, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/harbor/settings/parts";

type Provider = SignInProvider;

export function ChangePasswordPanel({
  hasPassword,
  providers,
  email,
}: {
  hasPassword: boolean;
  providers: Provider[];
  email: string | null;
}) {
  return (
    <Panel
      id="password"
      title="Your password"
      why={
        hasPassword
          ? "Change it whenever you think someone else may know it. We email you each time it changes."
          : "This account has no password yet."
      }
    >
      {hasPassword ? <ChangePasswordForm /> : <SetPassword providers={providers} email={email} />}
    </Panel>
  );
}

function ChangePasswordForm() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [shown, setShown] = useState(false);
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ signedOutOthers: boolean } | null>(null);

  const length = passwordLength(next);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const problem = changePasswordProblem(current, next);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await changePassword(current, next, signOutOthers);
      setDone({ signedOutOthers: signOutOthers });
      setCurrent("");
      setNext("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The password could not be changed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex max-w-[420px] flex-col gap-4" data-testid="password-change-form" noValidate>
      {done ? (
        <Notice tone="ok" title="Password changed" testId="password-changed">
          {done.signedOutOthers
            ? "Every other device was signed out and has to sign in with the new password. We emailed you a confirmation."
            : "Your other devices stay signed in. We emailed you a confirmation."}
        </Notice>
      ) : null}
      {error ? <Notice tone="fail" title={error} /> : null}
      <Field label="Current password">
        <Input
          type={shown ? "text" : "password"}
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          autoComplete="current-password"
          maxLength={MAX_PASSWORD}
          required
          data-testid="password-current"
        />
      </Field>
      <Field
        label="New password"
        hint={
          <span aria-live="polite" className="flex flex-wrap items-center gap-x-3">
            <span
              data-testid="password-new-count"
              className={clsx("tnum", length === "short" ? "text-warn" : length === "ok" ? "text-ok" : "text-fg-3")}
            >
              {passwordLengthHint(next)}
            </span>
            <span>A password found in a known data breach is refused.</span>
          </span>
        }
      >
        <Input
          type={shown ? "text" : "password"}
          value={next}
          onChange={(event) => setNext(event.target.value)}
          autoComplete="new-password"
          minLength={MIN_PASSWORD}
          maxLength={MAX_PASSWORD}
          required
          aria-invalid={length === "short" || undefined}
          data-testid="password-new"
        />
      </Field>
      <Checkbox checked={shown} onChange={(event) => setShown(event.target.checked)} label="Show passwords" />
      <Checkbox
        checked={signOutOthers}
        onChange={(event) => setSignOutOthers(event.target.checked)}
        label="Sign out my other devices"
        hint="They have to sign in again with the new password. This device stays signed in."
        data-testid="password-signout-others"
      />
      <div>
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          busyLabel="Changing"
          disabled={!current || length !== "ok"}
          data-testid="password-change-submit"
        >
          Change password
        </Button>
      </div>
    </form>
  );
}

function SetPassword({ providers, email }: { providers: Provider[]; email: string | null }) {
  const [state, setState] = useState<"idle" | "busy" | "sent" | "failed">("idle");

  async function send() {
    if (!email) return;
    setState("busy");
    try {
      await requestPasswordReset(email);
      setState("sent");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="flex max-w-[72ch] flex-col gap-3">
      <p className="text-ui text-fg-2">
        You sign in with {signInProviderList(providers)}, so there is no password to change. Set one if you also want to sign
        in with your email address, or to use two-step verification.
      </p>
      {email ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={send} busy={state === "busy"} busyLabel="Sending" disabled={state === "sent"} data-testid="password-set-link">
            Set a password
          </Button>
          {state === "sent" ? (
            <span className="text-meta font-semibold text-ok">
              We emailed a link to {email}. It works for one hour.
            </span>
          ) : null}
          {state === "failed" ? <span className="text-meta font-semibold text-fail">The link could not be sent. Try again shortly.</span> : null}
        </div>
      ) : null}
    </div>
  );
}
