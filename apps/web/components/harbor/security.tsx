"use client";

/**
 * security.tsx — the account's own two-step verification.
 *
 * The screen sits outside every workspace, because the workspace gate can
 * refuse a member who has not enrolled. It reads nothing workspace scoped.
 *
 * The setup key and backup codes exist only in this component's state and are
 * shown once. They are never sent to a QR service, never logged and never put
 * in a URL; the QR image is drawn locally by the qrcode package.
 */

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import {
  confirmTwoFactor,
  disableTwoFactor,
  enableTwoFactor,
  regenerateBackupCodes,
  requestPasswordReset,
} from "@/lib/auth-client";
import { groupSecret, totpSecretFromUri } from "@/lib/mfa";
import type { MySecurity } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/harbor/settings/parts";

type Phase =
  | "idle"
  | "setup-password"
  | "setup-scan"
  | "setup-confirm"
  | "regen-password"
  | "codes";

function workspaceNames(security: MySecurity): string {
  return security.requiredBy.map((workspace) => workspace.name).join(", ");
}

export function AccountSecurityBoard({
  initial,
  email,
  requiredArrival,
}: {
  initial: MySecurity;
  email: string | null;
  /** True when the workspace gate sent the person here. */
  requiredArrival: boolean;
}) {
  const router = useRouter();
  const [security, setSecurity] = useState(initial);
  const [phase, setPhase] = useState<Phase>("idle");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [setupUri, setSetupUri] = useState<string | null>(null);
  const [setupKey, setSetupKey] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [codesContext, setCodesContext] = useState<"setup" | "regenerate">("setup");
  const [showDisable, setShowDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableError, setDisableError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);

  useEffect(() => {
    if (!setupUri) {
      setQrDataUrl(null);
      return;
    }
    let alive = true;
    QRCode.toDataURL(setupUri, { width: 240, margin: 1 })
      .then((url) => {
        if (alive) setQrDataUrl(url);
      })
      .catch(() => {
        if (alive) setError("The QR code could not be drawn. Use the setup key below instead.");
      });
    return () => {
      alive = false;
    };
  }, [setupUri]);

  async function beginSetup(event: FormEvent) {    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await enableTwoFactor(password);
      const secret = totpSecretFromUri(result.totpURI);
      if (!secret || !result.totpURI) {
        setError("The authenticator setup could not be read. Try again.");
        return;
      }
      setSetupUri(result.totpURI);
      setSetupKey(groupSecret(secret));
      setCodes(result.backupCodes);
      setCodesContext("setup");
      setSaved(false);
      setPassword("");
      setPhase("setup-scan");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(event: FormEvent) {
    event.preventDefault();
    if (busy || !confirmCode.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await confirmTwoFactor(confirmCode.trim());
      setSecurity((current) => ({
        ...current,
        twoFactorEnabled: true,
        backupCodesRemaining: codes.length,
      }));
      setConfirmCode("");
      setSaved(false);
      setPhase("codes");
      setNotice("Two-step verification is on. Save the backup codes below before you continue.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code did not work. Try the current one.");
    } finally {
      setBusy(false);
    }
  }

  async function regenerate(event: FormEvent) {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const fresh = await regenerateBackupCodes(password);
      setCodes(fresh);
      setCodesContext("regenerate");
      setSaved(false);
      setPassword("");
      setPhase("codes");
      setSecurity((current) => ({ ...current, backupCodesRemaining: fresh.length }));
      setNotice("New backup codes replace every old code. Save them now; this is the only time they are shown.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The codes could not be generated. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    if (!disablePassword) {
      setDisableError("Enter your password to turn two-step verification off.");
      return;
    }
    setBusy(true);
    setDisableError(null);
    try {
      await disableTwoFactor(disablePassword);
      setShowDisable(false);
      setDisablePassword("");
      setSecurity((current) => ({
        ...current,
        twoFactorEnabled: false,
        backupCodesRemaining: null,
      }));
      setPhase("idle");
      setNotice("Two-step verification is off. Password sign-in no longer asks for a code.");
      router.refresh();
    } catch (err) {
      setDisableError(err instanceof Error ? err.message : "That password is not right.");
    } finally {
      setBusy(false);
    }
  }

  async function sendReset() {
    if (!email) return;
    setError(null);
    try {
      await requestPasswordReset(email);
      setResetSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The link could not be sent. Try again shortly.");
    }
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setNotice("Backup codes copied.");
    } catch {
      setError("The codes could not be copied. Select them and copy by hand.");
    }
  }

  function downloadCodes() {
    const blob = new Blob([`${codes.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "dmarc-harbor-backup-codes.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const names = workspaceNames(security);

  return (
    <div className="flex max-w-[820px] flex-col gap-8">
      {security.requiredBy.length > 0 ? (
        <Notice
          tone={requiredArrival ? "warn" : "info"}
          title={requiredArrival ? "This workspace requires two-step verification" : "A workspace requires two-step verification"}
        >
          <span className="font-semibold text-fg">{names}</span>{" "}
          {security.requiredBy.length === 1 ? "requires" : "require"} two-step verification.{" "}
          {security.sessionAuthMethod === "sso"
            ? "Your company's single sign-on satisfies it."
            : "Until this account has an authenticator app, its workspace API answers 403 and sends you here."}
        </Notice>
      ) : null}
      {requiredArrival && security.requiredBy.length === 0 ? (
        <Notice tone="info" title="No workspace requires two-step verification now">
          The requirement may have been turned off since the redirect. You can still set it up here.
        </Notice>
      ) : null}

      <Panel
        title="Two-step verification"
        why="A second step after your password. An authenticator app generates a six-digit code every 30 seconds; ten backup codes cover a lost phone."
        aside={
          <span data-testid="mfa-status" className={security.twoFactorEnabled ? "font-semibold text-ok" : "font-semibold text-fg-2"}>
            {security.twoFactorEnabled ? "On" : "Off"}
          </span>
        }
      >
        {notice ? <Notice tone="ok" title={notice} /> : null}
        {error ? <Notice tone="fail" title={error} /> : null}

        {security.twoFactorEnabled ? (
          <div className="flex flex-col gap-4">
            <p className="text-ui text-fg-2">
              {security.backupCodesRemaining === null
                ? "How many backup codes remain could not be read. This does not change whether two-step verification is on."
                : `${security.backupCodesRemaining} backup code${security.backupCodesRemaining === 1 ? "" : "s"} left.`}
            </p>
            {security.sessionAuthMethod === "sso" ? (
              <p className="text-meta text-fg-3">This session signed in through single sign-on; your company's sign-in handles the second step.</p>
            ) : null}
            {!security.hasPassword ? (
              <p className="text-meta text-fg-3">
                This account has no password, so changing or turning off two-step verification is not possible here. Set a
                password with a reset link first.
              </p>
            ) : phase === "regen-password" ? (
              <form onSubmit={regenerate} className="flex max-w-[360px] flex-col gap-3">
                <Field label="Your password">
                  <Input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                    autoFocus
                  />
                </Field>
                <div className="flex gap-2">
                  <Button type="submit" variant="primary" busy={busy} busyLabel="Generating">
                    Generate new codes
                  </Button>
                  <Button type="button" onClick={() => { setPhase("idle"); setPassword(""); setError(null); }}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  data-testid="mfa-regenerate"
                  onClick={() => { setPhase("regen-password"); setError(null); setNotice(null); }}
                >
                  Generate new backup codes
                </Button>
                <Button
                  data-testid="mfa-disable"
                  variant="ghost"
                  className="text-fail hover:text-fail"
                  onClick={() => { setShowDisable(true); setDisablePassword(""); setDisableError(null); }}
                >
                  Turn off
                </Button>
              </div>
            )}
          </div>
        ) : security.hasPassword ? (
          phase === "setup-password" ? (
            <form onSubmit={beginSetup} className="flex max-w-[360px] flex-col gap-3">
              <Field label="Your password">
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                  autoFocus
                />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" variant="primary" busy={busy} busyLabel="Preparing">
                  Continue
                </Button>
                <Button type="button" onClick={() => { setPhase("idle"); setPassword(""); setError(null); }}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : phase === "setup-scan" ? (
            <div className="flex flex-col gap-4">
              <p className="text-ui text-fg-2">
                Scan this with your authenticator app, or add the setup key by hand. Then enter the six-digit code it shows.
              </p>
              {qrDataUrl ? (
                <img data-testid="mfa-qr" src={qrDataUrl} alt="QR code that adds DMARC Harbor to an authenticator app" width={220} height={220} className="border border-rule bg-white p-2" />
              ) : (
                <p className="text-meta text-fg-3">Preparing the QR code…</p>
              )}
              <div>
                <p className="legend">Setup key</p>
                <code data-testid="mfa-setup-key" className="data mt-1 block break-all border border-rule bg-paper-3 px-2.5 py-2 text-meta text-fg">
                  {setupKey}
                </code>
              </div>
              <div>
                <Button variant="primary" onClick={() => { setPhase("setup-confirm"); setError(null); }}>
                  I have added it
                </Button>
              </div>
            </div>
          ) : phase === "setup-confirm" ? (
            <form onSubmit={confirmSetup} className="flex max-w-[360px] flex-col gap-3">
              <Field label="Six-digit code from the app">
                <Input
                  data-testid="mfa-confirm-code"
                  value={confirmCode}
                  onChange={(event) => setConfirmCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  autoFocus
                />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" variant="primary" busy={busy} busyLabel="Checking">
                  Turn on two-step verification
                </Button>
                <Button type="button" onClick={() => { setPhase("setup-scan"); setConfirmCode(""); setError(null); }}>
                  Back
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-ui text-fg-2">
                Turn this on to require a code from your authenticator app after your password. You get ten one-time
                backup codes at the end.
              </p>
              <p className="max-w-[72ch] text-meta text-fg-3">
                Once it is on, Google and Microsoft sign-in is turned off for this account, because DMARC Harbor cannot
                see whether they asked for a second step. Sign in with your email, password and authenticator instead.
              </p>
              <div>
                <Button data-testid="mfa-start" variant="primary" onClick={() => { setPhase("setup-password"); setError(null); setNotice(null); }}>
                  Set up two-step verification
                </Button>
              </div>
            </div>
          )
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-ui text-fg-2">
              You sign in with Google, Microsoft or single sign-on, so there is no password to protect here.
            </p>
            {security.sessionAuthMethod === "sso" ? (
              <p className="text-ui text-fg-2">Your company&apos;s sign-in handles the second step.</p>
            ) : null}
            {security.requiredBy.length > 0 ? (
              <p className="max-w-[72ch] text-ui text-fg-2">
                <span className="font-semibold text-fg">{names}</span> requires an authenticator app. Set a password
                first (we will email a link), then come back here.
              </p>
            ) : null}
            <p className="max-w-[72ch] text-meta text-fg-3">
              Once two-step verification is on, Google and Microsoft sign-in is turned off for this account, because
              DMARC Harbor cannot see whether they asked for a second step.
            </p>
            {email ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={sendReset} busy={busy} busyLabel="Sending">
                  Email me a password link
                </Button>
                {resetSent ? <span className="text-meta font-semibold text-ok">A reset link is on its way to {email}.</span> : null}
              </div>
            ) : null}
          </div>
        )}
      </Panel>

      {phase === "codes" ? (
        <Panel
          title={codesContext === "regenerate" ? "Your new backup codes" : "Save your backup codes"}
          why="Each code signs you in once. They are shown only now. Store them somewhere separate from your password."
        >
          <ol data-testid="mfa-backup-list" className="data grid max-w-[460px] grid-cols-2 gap-x-8 gap-y-1 border border-rule bg-paper-3 px-4 py-3 text-ui text-fg">
            {codes.map((backup) => (
              <li key={backup}>{backup}</li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={copyCodes}>Copy</Button>
            <Button size="sm" onClick={downloadCodes}>Download .txt</Button>
          </div>
          <label className="flex items-start gap-2 text-ui text-fg-2">
            <input
              type="checkbox"
              data-testid="mfa-saved-check"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
              className="mt-1"
            />
            I have saved these codes somewhere safe
          </label>
          <div>
            <Button
              data-testid="mfa-done"
              variant="primary"
              disabled={!saved}
              onClick={() => {
                setPhase("idle");
                setCodes([]);
                setSetupUri(null);
                setSetupKey(null);
                setQrDataUrl(null);
                setSaved(false);
                setNotice(
                  codesContext === "regenerate"
                    ? "New backup codes are active; the old ones no longer work."
                    : "Two-step verification is on.",
                );
                router.refresh();
              }}
            >
              Done
            </Button>
          </div>
        </Panel>
      ) : null}

      <ConfirmDialog
        open={showDisable}
        onClose={() => { setShowDisable(false); setDisablePassword(""); setDisableError(null); }}
        onConfirm={turnOff}
        title="Turn off two-step verification?"
        body={
          <div className="flex flex-col gap-3">
            <p>
              Your password will be the only step at sign-in. The authenticator secret and the remaining backup codes
              stop working, and every other signed-in device is unaffected.
            </p>
            {security.requiredBy.length > 0 ? (
              <p className="text-warn">
                {names} requires two-step verification. Turning it off will refuse this account access to{" "}
                {security.requiredBy.length === 1 ? "that workspace" : "those workspaces"} until you turn it back on.
              </p>
            ) : null}
            <Field label="Your password">
              <Input
                type="password"
                value={disablePassword}
                onChange={(event) => setDisablePassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
          </div>
        }
        confirmLabel="Turn off"
        busy={busy}
        danger
        error={disableError}
      />
    </div>
  );
}
