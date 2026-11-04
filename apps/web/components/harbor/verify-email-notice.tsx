"use client";

/**
 * verify-email-notice.tsx — a signed-in account whose address is not confirmed.
 *
 * Shown on /welcome in place of "Email verified", which used to be printed for
 * every account. Says what the confirmation unlocks (invitations sent to the
 * address cannot be opened until then), and sends a fresh link with the same
 * 45-second wait the sign-in form uses.
 */

import { useEffect, useState } from "react";
import { resendVerification } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

const RESEND_AFTER_S = 45;

export function VerifyEmailNotice({ email }: { email: string }) {
  const [left, setLeft] = useState(0);
  const [state, setState] = useState<"idle" | "busy" | "sent" | "failed">("idle");

  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);

  async function resend() {
    setState("busy");
    try {
      await resendVerification(email, "/welcome");
      setState("sent");
      setLeft(RESEND_AFTER_S);
    } catch {
      setState("failed");
    }
  }

  return (
    <Notice
      tone="warn"
      title="Confirm your email address"
      testId="email-unverified"
      action={
        <Button size="sm" onClick={resend} busy={state === "busy"} busyLabel="Sending" disabled={left > 0}>
          <span className="tnum">{left > 0 ? `Resend in ${left}s` : "Send a new link"}</span>
        </Button>
      }
    >
      You are signed in, but <span className="font-semibold text-fg">{email}</span> is not confirmed yet. Open the link
      we sent to it. Until then, invitations sent to this address cannot be opened.
      {state === "sent" ? <span className="mt-1 block font-semibold text-ok">A new link is on its way.</span> : null}
      {state === "failed" ? <span className="mt-1 block text-fail">The link could not be sent. Try again shortly.</span> : null}
    </Notice>
  );
}
