"use client";

/**
 * portal-client.tsx — the portal's two interactive pieces.
 *
 *   PortalSignOut  signs the contact out and returns them to sign-in.
 *   ForwardReport  the three ways a client hands this report on: copy a
 *                  plain-text summary (for an email or a chat to whoever
 *                  handles their IT), open an email already written, or print
 *                  / save as PDF. The text is built on the server from the same
 *                  figures the page shows, so the two cannot disagree.
 *
 * The three are equal choices, so they are three secondary pills of one size;
 * none is the page's primary action. A failed clipboard write selects the
 * summary instead, so it can still be copied by hand, and says so.
 */

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { signOut } from "@/lib/auth-client";
import { Button, buttonClass } from "@/components/ui/button";

export function PortalSignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      busy={busy}
      busyLabel="Signing out"
      onClick={async () => {
        setBusy(true);
        await signOut().catch(() => {});
        router.push("/sign-in");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}

export function ForwardReport({ subject, text }: { subject: string; text: string }) {
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const summary = useRef<HTMLPreElement | null>(null);

  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      const target = summary.current;
      if (target) {
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setState("manual");
    }
    timer.current = setTimeout(() => setState("idle"), 2400);
  }

  return (
    <div data-copy-scope className="flex flex-wrap items-center gap-2 print:hidden">
      <Button variant="secondary" onClick={copy} aria-label="Copy a summary of this report" className={state === "copied" ? "border-ok/40! text-ok!" : undefined}>
        <span aria-live="polite">
          {state === "copied" ? "Summary copied" : state === "manual" ? "Selected: press Ctrl C" : "Copy a summary"}
        </span>
      </Button>
      <a href={mailto} className={buttonClass("secondary", "md")}>
        Email it
      </a>
      <Button variant="secondary" onClick={() => window.print()}>
        Print or save as PDF
      </Button>
      <pre ref={summary} data-copy-value className="sr-only">
        {text}
      </pre>
    </div>
  );
}
