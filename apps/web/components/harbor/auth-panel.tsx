"use client";

/**
 * auth-panel.tsx — sign in, create an account, and recover a password.
 *
 * Built around what goes wrong at a login form, because that is what the
 * person remembers:
 *
 * - Forgot password is one click, in place, keeping the email already typed.
 *   The reset link lands back here with a token and the same panel sets the
 *   new password. Every other session is signed out by the API when it does.
 * - An unverified address is said plainly, with a fresh link already sent
 *   (the API sends one on sign-in) and a resend after a short wait.
 * - After sign-up the panel becomes "check your inbox": the address it was
 *   sent to, resend with a cooldown, a way to fix a typo, and what to do if it
 *   is not there. It never claims an account was created: the API deliberately
 *   answers the same for an address that already has one.
 * - Caps Lock is noticed. The password can be shown. The minimum length is
 *   counted as you type rather than refused after you submit.
 *
 * Social sign-in renders only the providers GET /api/auth/providers reports,
 * and returns to the page the person came from.
 *
 * With `route`, the sign-up form sits beside the setup route, and the route
 * moves on to "Verify email" when the link has been sent, so the drawing
 * never says a step is current after it is done.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { clsx } from "clsx";
import {
  AuthError,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  signIn,
  signUp,
  verifyBackupCode,
  verifyTotp,
} from "@/lib/auth-client";
import type { AuthProviders } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { SetupLayout } from "./setup-rail";

type Mode = "sign-in" | "sign-up" | "forgot" | "reset" | "two-factor";
const MIN_PASSWORD = 8;
const RESEND_AFTER_S = 45;

export function AuthPanel({
  initialMode,
  next,
  resetToken,
  initialError,
  route = false,
}: {
  initialMode: "sign-in" | "sign-up";
  /** A same-site path to return to after signing in (already validated). */
  next?: string | null;
  /** Present when the person arrived from a password reset link. */
  resetToken?: string | null;
  /** An error carried back in the URL (a failed social sign-in, a dead link). */
  initialError?: string | null;
  /** Sign-up only: lay the form beside the setup route. */
  route?: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(resetToken ? "reset" : initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [unverified, setUnverified] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resetSentTo, setResetSentTo] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);
  const [code, setCode] = useState("");
  const [backupCode, setBackupCode] = useState(false);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);

  const destination = next ?? "/";

  function go(m: Mode) {
    setMode(m);
    setError(null);
    setUnverified(false);
    setResetSentTo(null);
    setCode("");
    setBackupCode(false);
    requestAnimationFrame(() => emailRef.current?.focus());
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setUnverified(false);
    try {
      if (mode === "sign-in") {
        const result = await signIn(email.trim(), password, destination);
        if (result.twoFactor) {
          setPassword("");
          setMode("two-factor");
          setCode("");
          setBackupCode(false);
          setError(null);
          requestAnimationFrame(() => codeRef.current?.focus());
          return;
        }
        router.replace(destination);
        router.refresh();
        return;
      }
      if (mode === "two-factor") {
        if (backupCode) {
          await verifyBackupCode(code.trim());
        } else {
          await verifyTotp(code.trim());
        }
        router.replace(destination);
        router.refresh();
        return;
      }
      if (mode === "sign-up") {
        await signUp(name.trim(), email.trim(), password);
        setSentTo(email.trim());
        return;
      }
      if (mode === "forgot") {
        await requestPasswordReset(email.trim());
        setResetSentTo(email.trim());
        return;
      }
      if (mode === "reset") {
        if (password !== confirm) {
          setError("The two passwords do not match.");
          return;
        }
        await resetPassword(resetToken ?? "", password);
        setResetDone(true);
        setPassword("");
        setConfirm("");
        setMode("sign-in");
        // Drop the spent token from the address bar.
        router.replace(next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in");
      }
    } catch (err) {
      if (err instanceof AuthError && err.code === "EMAIL_NOT_VERIFIED") {
        setUnverified(true);
      } else {
        const timedOut =
          err instanceof AuthError &&
          (err.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" || err.code === "INVALID_TWO_FACTOR_COOKIE");
        if (timedOut) {
          // The challenge cookie is spent. Keep the email so the next attempt
          // is one password field away, and say what happened.
          setMode("sign-in");
          setCode("");
          setBackupCode(false);
          setPassword("");
        }
        setError(err instanceof Error ? err.message : "That did not work. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  const withRoute = (content: ReactNode) =>
    route && mode === "sign-up" ? <SetupLayout current={sentTo ? "email" : "account"}>{content}</SetupLayout> : content;

  if (mode === "sign-up" && sentTo) {
    return withRoute(<CheckInbox email={sentTo} onChangeEmail={() => setSentTo(null)} />);
  }

  const heading: Record<Mode, string> = {
    "sign-in": "Sign in",
    "sign-up": "Create your account",
    forgot: "Reset your password",
    reset: "Choose a new password",
    "two-factor": "Enter your code",
  };
  const lede: Record<Mode, string> = {
    "sign-in": "Welcome back. Your portfolio is where you left it.",
    "sign-up": "Free to start, no card. Next you name a workspace and add a first client domain.",
    forgot: "Enter the address you sign in with and we will email a reset link. It works for one hour.",
    reset: "Every other session on this account is signed out once the new password is set.",
    "two-factor": backupCode
      ? "Enter one of the backup codes you saved when you set up two-step verification."
      : "Open your authenticator app and enter the six-digit code it shows for this account.",
  };

  return withRoute(
    <div className="flex flex-col gap-7">
      <div>
        <h1 className="text-balance text-[34px] font-[760] leading-[1.02] tracking-[-0.035em] text-fg sm:text-[40px]">
          {heading[mode]}
        </h1>
        <p className="mt-3 text-lead text-fg-2">{lede[mode]}</p>
      </div>

      {next && mode === "sign-in" ? (
        <Notice tone="info" title="Sign in to carry on">
          You will go straight back to <span className="data text-fg">{next}</span>.
        </Notice>
      ) : null}
      {resetDone ? (
        <Notice tone="ok" title="Password changed">
          Sign in with the new password. Every other session on this account was signed out.
        </Notice>
      ) : null}

      {mode === "sign-in" || mode === "sign-up" ? <Providers destination={mode === "sign-up" ? "/welcome" : destination} /> : null}

      <form onSubmit={submit} className="flex flex-col gap-4" noValidate={false}>
        {mode === "sign-up" ? (
          <TextField label="Your name" value={name} onChange={setName} autoComplete="name" type="text" required />
        ) : null}
        {mode !== "reset" && mode !== "two-factor" ? (
          <TextField
            label={mode === "sign-up" ? "Work email" : "Email"}
            value={email}
            onChange={setEmail}
            autoComplete={mode === "sign-up" ? "email" : "username"}
            type="email"
            inputRef={emailRef}
            required
            autoFocus
          />
        ) : null}
        {mode === "sign-in" || mode === "sign-up" || mode === "reset" ? (
          <PasswordField
            label={mode === "reset" ? "New password" : "Password"}
            value={password}
            onChange={setPassword}
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            counted={mode !== "sign-in"}
            corner={
              mode === "sign-in" ? (
                <button type="button" onClick={() => go("forgot")} className="link text-meta font-semibold">
                  Forgot password?
                </button>
              ) : null
            }
          />
        ) : null}
        {mode === "reset" ? (
          <PasswordField label="New password again" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        ) : null}
        {mode === "two-factor" ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="mfa-code" className="text-meta font-semibold text-fg-2">
              {backupCode ? "Backup code" : "Six-digit code"}
            </label>
            <Input
              id="mfa-code"
              ref={codeRef}
              type="text"
              size="lg"
              mono
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode={backupCode ? "text" : "numeric"}
              autoComplete={backupCode ? "off" : "one-time-code"}
              autoCapitalize="none"
              spellCheck={false}
              maxLength={backupCode ? 11 : 6}
              required
              autoFocus
              data-testid={backupCode ? "mfa-backup-code" : "mfa-code"}
              className="h-12! text-[20px]! tracking-[0.18em]"
              placeholder={backupCode ? "xxxxx-xxxxx" : "000000"}
            />
            <p className="text-meta text-fg-3">
              {backupCode
                ? "Each backup code works once."
                : "The code changes every 30 seconds. Enter the one showing now."}
            </p>
          </div>
        ) : null}

        {unverified ? (
          <UnverifiedNotice email={email.trim()} />
        ) : error ? (
          <Notice tone="fail" title={error} />
        ) : null}
        {resetSentTo ? (
          <Notice tone="ok" title="Check your inbox">
            If <span className="font-semibold text-fg">{resetSentTo}</span> has an account, a reset link is on its way. It
            works for one hour. Nothing arrived? Check spam, or ask again in a minute.
          </Notice>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          busy={busy}
          busyLabel={mode === "sign-in" ? "Signing in" : mode === "two-factor" ? "Checking" : "Working"}
          data-testid={mode === "two-factor" ? "mfa-submit" : "auth-submit"}
          className="mt-2 w-full"
          disabled={(mode !== "sign-in" && mode !== "forgot" && password.length > 0 && password.length < MIN_PASSWORD) || (mode === "two-factor" && code.trim().length === 0)}
        >
          {mode === "sign-in"
            ? "Sign in"
            : mode === "sign-up"
              ? "Create account"
              : mode === "forgot"
                ? "Email me a reset link"
                : mode === "two-factor"
                  ? "Verify"
                  : "Set the new password"}
        </Button>
      </form>

      {mode === "sign-in" ? null : mode === "sign-up" ? (
        // The Terms are accepted, and recorded, when the first workspace is
        // created: the server refuses a workspace without them. This is the
        // notice; the gate is on the next screen.
        <p className="border-t border-rule pt-4 text-meta text-fg-3">
          You accept the{" "}
          <Link href="/terms" className="link">
            Terms of Service
          </Link>{" "}
          and the{" "}
          <Link href="/dpa" className="link">
            Data Processing Agreement
          </Link>{" "}
          when you create your first workspace, on the next screen. Read the{" "}
          <Link href="/privacy" className="link">
            Privacy Policy
          </Link>{" "}
          any time.
        </p>
      ) : mode === "two-factor" ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule pt-4 text-ui">
          <button
            type="button"
            data-testid="mfa-use-backup"
            onClick={() => {
              setBackupCode((value) => !value);
              setCode("");
              setError(null);
              requestAnimationFrame(() => codeRef.current?.focus());
            }}
            className="link font-semibold"
          >
            {backupCode ? "Use your authenticator app instead" : "Use a backup code instead"}
          </button>
          <button type="button" onClick={() => go("sign-in")} className="link text-fg-3">
            Back to sign in
          </button>
        </div>
      ) : (
        <p className="border-t border-rule pt-4 text-ui">
          <button type="button" onClick={() => go("sign-in")} className="link font-semibold">
            Back to sign in
          </button>
        </p>
      )}
    </div>,
  );
}

/** The resend control, with a visible countdown so a second press is not a guess. */
function useCooldown(seconds: number) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return { left, start: () => setLeft(seconds) };
}

function UnverifiedNotice({ email }: { email: string }) {
  const cool = useCooldown(RESEND_AFTER_S);
  const [state, setState] = useState<"idle" | "busy" | "sent" | "failed">("idle");
  useEffect(() => cool.start(), []); // the API already sent one with this attempt
  async function resend() {
    setState("busy");
    try {
      await resendVerification(email);
      setState("sent");
      cool.start();
    } catch {
      setState("failed");
    }
  }
  return (
    <Notice
      tone="warn"
      title="Verify your email to sign in"
      action={
        <Button size="sm" onClick={resend} busy={state === "busy"} busyLabel="Sending" disabled={cool.left > 0}>
          <span className="tnum">{cool.left > 0 ? `Resend in ${cool.left}s` : "Resend link"}</span>
        </Button>
      }
    >
      We have just sent a fresh verification link to <span className="font-semibold text-fg">{email}</span>. Open it on
      this device and you are signed in.
      {state === "failed" ? <span className="mt-1 block text-fail">The link could not be sent. Try again shortly.</span> : null}
    </Notice>
  );
}

function CheckInbox({ email, onChangeEmail }: { email: string; onChangeEmail: () => void }) {
  const cool = useCooldown(RESEND_AFTER_S);
  const [state, setState] = useState<"idle" | "busy" | "sent" | "failed">("idle");
  useEffect(() => cool.start(), []);
  async function resend() {
    setState("busy");
    try {
      await resendVerification(email);
      setState("sent");
      cool.start();
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="flex flex-col gap-7" role="status">
      <div>
        <h1 className="text-balance text-[34px] font-[760] leading-[1.02] tracking-[-0.035em] text-fg sm:text-[40px]">
          Check your inbox
        </h1>
        <p className="mt-3 text-lead text-fg-2">
          To verify your email, open the link we sent to <span className="font-semibold text-fg">{email}</span>. It signs
          you in and takes you to the next step. The link works for 24 hours.
        </p>
      </div>
      <SentRoute email={email} />
      <dl className="flex flex-col border-t border-rule text-ui">
        {[
          ["Not there?", "Give it a minute, then check spam or promotions. Some company mail filters hold first messages."],
          ["Wrong address?", "Use a different email below and sign up again with the right one."],
          ["Already have an account?", "Then no new account was made. Sign in instead, or reset your password."],
        ].map(([k, v]) => (
          <div key={k} className="grid gap-x-4 gap-y-0.5 border-b border-rule py-3 sm:grid-cols-[156px_minmax(0,1fr)]">
            <dt className="font-semibold text-fg">{k}</dt>
            <dd className="text-fg-2">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Button onClick={resend} busy={state === "busy"} busyLabel="Sending" disabled={cool.left > 0}>
          <span className="tnum">{cool.left > 0 ? `Resend in ${cool.left}s` : "Resend the link"}</span>
        </Button>
        <button type="button" onClick={onChangeEmail} className="link text-ui font-semibold">
          Use a different email
        </button>
        <Link href="/sign-in" className="link ml-auto text-ui">
          Sign in
        </Link>
      </div>
      {state === "sent" ? <p className="text-meta font-semibold text-ok">Another link is on its way.</p> : null}
      {state === "failed" ? <p className="text-meta font-semibold text-fail">That did not send. Try again in a moment.</p> : null}
    </div>
  );
}

/**
 * The link on its way, drawn as a short line: sent at one end, the inbox at
 * the other, the message riding between. It only ever renders after the
 * sign-up call returns, so it is never part of the server HTML; under reduced
 * motion the message rests halfway.
 */
function SentRoute({ email }: { email: string }) {
  return (
    <figure aria-hidden className="m-0">
      <svg viewBox="0 0 400 30" className="block h-auto w-full" fill="none">
        <path d="M14 15 H384" stroke="var(--color-accent)" strokeWidth="5" strokeLinecap="round" />
        <g className="hb-ride" style={{ "--ride": "336px" } as React.CSSProperties}>
          <circle cx="30" cy="15" r="5" fill="#fff" stroke="var(--color-accent)" strokeWidth="2.5" />
        </g>
        <circle cx="14" cy="15" r="7.5" fill="#fff" stroke="var(--color-fg)" strokeWidth="3" />
        <rect x="378" y="2.5" width="18" height="25" rx="9" fill="#fff" stroke="var(--color-fg)" strokeWidth="3" />
      </svg>
      <figcaption className="mt-2 flex justify-between gap-6 text-ui">
        <span>
          <span className="block font-bold text-fg">Link sent</span>
          <span className="block text-fg-4">works for 24 hours</span>
        </span>
        <span className="min-w-0 text-right">
          <span className="block font-bold text-fg">Your inbox</span>
          <span className="block break-all text-fg-4">{email}</span>
        </span>
      </figcaption>
    </figure>
  );
}

function TextField({
  label,
  value,
  onChange,
  type,
  autoComplete,
  required,
  autoFocus,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type: "text" | "email";
  autoComplete: string;
  required?: boolean;
  autoFocus?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-meta font-semibold text-fg-2">
        {label}
      </label>
      <Input
        id={id}
        ref={inputRef}
        type={type}
        size="lg"
        value={value}
        required={required}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        spellCheck={false}
        autoCapitalize={type === "email" ? "none" : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  counted,
  corner,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  counted?: boolean;
  corner?: ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.("CapsLock") ?? false);
  const short = counted && value.length > 0 && value.length < MIN_PASSWORD;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-meta font-semibold text-fg-2">
          {label}
        </label>
        {corner}
      </div>
      <div className="relative">
        <Input
          id={id}
          type={shown ? "text" : "password"}
          size="lg"
          value={value}
          required
          minLength={counted ? MIN_PASSWORD : undefined}
          maxLength={128}
          autoComplete={autoComplete}
          aria-describedby={hintId}
          aria-invalid={short || undefined}
          onKeyUp={onKey}
          onKeyDown={onKey}
          onBlur={() => setCaps(false)}
          onChange={(e) => onChange(e.target.value)}
          className="pr-[68px]!"
        />
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          aria-pressed={shown}
          aria-label={shown ? "Hide password" : "Show password"}
          className="absolute right-1.5 top-1/2 h-8 -translate-y-1/2 rounded-full px-3 text-meta font-semibold text-fg-3 transition-colors duration-100 hover:bg-paper-3 hover:text-fg"
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      <p id={hintId} className="flex min-h-4 items-center gap-3 text-meta" aria-live="polite">
        {caps ? <span className="font-semibold text-warn">Caps Lock is on.</span> : null}
        {counted ? (
          <span className={clsx("tnum", short ? "text-warn" : value.length >= MIN_PASSWORD ? "text-ok" : "text-fg-3")}>
            {value.length >= MIN_PASSWORD ? "Long enough." : `At least ${MIN_PASSWORD} characters${value.length ? ` · ${value.length} so far` : ""}.`}
          </span>
        ) : null}
      </p>
    </div>
  );
}

const PROVIDER_LABEL: Record<"google" | "microsoft", string> = {
  google: "Continue with Google",
  microsoft: "Continue with Microsoft",
};

/** The provider marks as the brands publish them, the only colour they carry. */
function ProviderLogo({ provider }: { provider: "google" | "microsoft" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden focusable="false">
      {provider === "google" ? (
        <g>
          <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
          <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
          <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z" />
          <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
        </g>
      ) : (
        <g transform="scale(2)">
          <rect width="10" height="10" x="1" y="1" fill="#F25022" />
          <rect width="10" height="10" x="13" y="1" fill="#7FBA00" />
          <rect width="10" height="10" x="1" y="13" fill="#00A4EF" />
          <rect width="10" height="10" x="13" y="13" fill="#FFB900" />
        </g>
      )}
    </svg>
  );
}

/**
 * Federated sign-in, for exactly the providers the API reports as live (a
 * provider is true only when both its id and secret are configured). A failed
 * discovery renders nothing: a broken lookup must never look like a broken form.
 */
function Providers({ destination }: { destination: string }) {
  const [live, setLive] = useState<Array<"google" | "microsoft">>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/providers", { credentials: "include" });
        if (!res.ok) return;
        const body = (await res.json()) as Partial<AuthProviders>;
        if (!cancelled) setLive((["google", "microsoft"] as const).filter((p) => body[p] === true));
      } catch {
        /* nothing to show */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (live.length === 0) return null;

  async function start(p: "google" | "microsoft") {
    setBusy(p);
    setFailed(false);
    try {
      // POST-only: Better Auth answers with the provider's URL to follow.
      const res = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          provider: p,
          callbackURL: `${window.location.origin}${destination}`,
          // Better Auth appends the actual error code. A pre-set code here
          // would be a second `error` parameter, and the MFA refusal needs its
          // own sentence, not the generic social one.
          errorCallbackURL: `${window.location.origin}/sign-in`,
        }),
      });
      const body = res.ok ? ((await res.json()) as { url?: string }) : null;
      if (body?.url && body.url.startsWith("https://")) {
        window.location.href = body.url;
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    }
    setBusy(null);
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid gap-2.5">
        {live.map((p) => (
          <Button key={p} data-provider={p} size="lg" onClick={() => start(p)} busy={busy === p} busyLabel="Opening" className="w-full">
            <ProviderLogo provider={p} />
            {PROVIDER_LABEL[p]}
          </Button>
        ))}
      </div>
      {failed ? <p className="text-meta font-semibold text-fail">That provider could not be reached. Try again, or use email.</p> : null}
      <p className="mt-1.5 flex items-center gap-3 text-meta text-fg-4" aria-hidden>
        <span className="h-px flex-1 bg-rule" />
        or with email
        <span className="h-px flex-1 bg-rule" />
      </p>
    </div>
  );
}
