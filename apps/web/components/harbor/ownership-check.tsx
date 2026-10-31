"use client";

/**
 * ownership-check.tsx — the live DNS lookup that proves a domain is yours.
 *
 * POST /domains/:id/verify reads the ownership TXT record from public DNS and
 * answers with the record to publish and what it found. It runs only when the
 * operator presses the button, never on render: a lookup changes the domain's
 * status and can notify people, so it is an action, not a page view.
 *
 * Three outcomes, worded as what they are:
 *   VERIFIED  the record is live and the domain is yours to monitor.
 *   PENDING   not visible yet. NORMAL: DNS takes minutes to hours. Never red.
 *   FAILED    it was verified before and the record has since gone.
 *
 * The time of the last check is shown, so "I pressed it, did it do anything"
 * has an answer. Test hooks (verify-domain, data-verify-status) are the
 * clickthrough suite's.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { clsx } from "clsx";
import { verifyDomain } from "@/lib/ops-client";
import type { VerifyDomainResult } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Refresh } from "@/components/ui/icons";

export type Verification = VerifyDomainResult["verification"];

export function OwnershipCheck({
  organizationId,
  domainId,
  verified,
  onResult,
  refreshOnResult = true,
  showStoredStatus = true,
}: {
  organizationId: string;
  domainId: string;
  /** The domain row's own status says it is verified already. */
  verified: boolean;
  onResult?: (v: Verification) => void;
  refreshOnResult?: boolean;
  /** Show the stored "verified" outcome before any check from this screen.
   *  Off where the caller already says the domain is verified beside it. */
  showStoredStatus?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Verification | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setError(null);
    const res = await verifyDomain(organizationId, domainId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message ?? "The lookup could not run.");
      return;
    }
    setResult(res.data.verification);
    setCheckedAt(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    onResult?.(res.data.verification);
    if (refreshOnResult) router.refresh();
  }

  const status = result?.status ?? (verified ? "VERIFIED" : null);
  const shown = result?.status ?? (verified && showStoredStatus ? "VERIFIED" : null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant={status === "VERIFIED" ? "secondary" : "primary"} onClick={check} busy={busy} busyLabel="Checking DNS" data-testid="verify-domain">
          <Refresh size={14} />
          {result ? "Check again" : status === "VERIFIED" ? "Re-check DNS" : "Check DNS now"}
        </Button>
        <span className="tnum text-meta text-fg-3" aria-live="polite">
          {busy ? "Asking public DNS…" : checkedAt ? `Last checked at ${checkedAt}` : "Not checked from this screen yet"}
        </span>
      </div>

      {shown ? <Outcome status={shown} /> : null}
      {error ? (
        <p role="alert" className="flex items-baseline gap-2 text-ui font-semibold text-fail">
          <span aria-hidden className="block size-2 shrink-0 translate-y-[-1px] rotate-45 bg-fail" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The lookup's answer as a state notice: a word and its shape, the same marks
 * the badges use. Filled square verified, ring waiting, diamond gone. Waiting
 * is never red: DNS taking a while is the normal case.
 */
function Outcome({ status }: { status: Verification["status"] }) {
  const copy = {
    VERIFIED: {
      tone: "border-ok/30 bg-ok-wash",
      head: "Ownership verified.",
      body: "The ownership record is live in DNS and this domain is yours to monitor.",
    },
    PENDING: {
      tone: "border-warn/30 bg-warn-wash",
      head: "Waiting for DNS.",
      body: "The record is not visible yet. That is normal: new records take minutes to a few hours to appear everywhere. Check again whenever you like; nothing here is an error.",
    },
    FAILED: {
      tone: "border-fail/30 bg-fail-wash",
      head: "The ownership record is no longer published.",
      body: "This domain was verified before, but its ownership record has gone from DNS. Publish it again to restore verification.",
    },
  }[status];
  return (
    <div
      role="status"
      data-verify-status={status.toLowerCase()}
      className={clsx("flex max-w-[72ch] items-start gap-3 rounded-[10px] border px-3.5 py-3 text-ui", copy.tone)}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="mt-[4px] shrink-0">
        {status === "VERIFIED" ? <rect x="0.5" y="0.5" width="9" height="9" fill="var(--color-ok)" /> : null}
        {status === "FAILED" ? <path d="M5 0 10 5 5 10 0 5Z" fill="var(--color-fail)" /> : null}
        {status === "PENDING" ? (
          <circle cx="5" cy="5" r="3.9" fill="none" stroke="var(--color-warn-mark)" strokeWidth="2" />
        ) : null}
      </svg>
      <p className="text-fg-2">
        <span className={clsx("font-bold", status === "VERIFIED" ? "text-ok" : status === "FAILED" ? "text-fail" : "text-warn")}>{copy.head}</span>{" "}
        {copy.body}
      </p>
    </div>
  );
}
