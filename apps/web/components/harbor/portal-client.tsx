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
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signOut } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy";

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
  return (
    <div data-copy-scope className="flex flex-wrap items-center gap-2 print:hidden">
      <CopyButton value={text} label="Copy a summary of this report" className="h-8 px-3 text-ui" />
      <a href={mailto} className="inline-flex h-8 items-center rounded-ctl border border-rule-2 bg-paper-2 px-3 text-ui font-semibold text-fg hover:border-fg-3">
        Email it
      </a>
      <Button size="md" variant="secondary" onClick={() => window.print()}>
        Print or save as PDF
      </Button>
      <pre data-copy-value className="sr-only">
        {text}
      </pre>
    </div>
  );
}
