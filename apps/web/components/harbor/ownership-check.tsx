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
}: {
  organizationId: string;
  domainId: string;
  /** The domain row's own status says it is verified already. */
  verified: boolean;
  onResult?: (v: Verification) => void;
  refreshOnResult?: boolean;
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant={status === "VERIFIED" ? "secondary" : "primary"} onClick={check} busy={busy} busyLabel="Checking DNS" data-testid="verify-domain">
          <Refresh size={14} />
          {result ? "Check again" : status === "VERIFIED" ? "Re-check DNS" : "Check DNS now"}
        </Button>
        <span className="text-meta text-fg-3" aria-live="polite">
          {busy ? "Asking public DNS…" : checkedAt ? `Last checked at ${checkedAt}` : "Not checked from this screen yet"}
        </span>
      </div>
      {busy ? <div className="hb-scan w-full max-w-[420px]" aria-hidden /> : null}

      {status ? <Outcome status={status} key={`${status}-${checkedAt}`} /> : null}
      {error ? (
        <p role="alert" className="text-ui font-semibold text-fail">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Outcome({ status }: { status: Verification["status"] }) {
  const copy = {
    VERIFIED: {
      tone: "border-ok/35 bg-ok-wash/70",
      head: "Ownership verified.",
      body: "The ownership record is live in DNS and this domain is yours to monitor.",
    },
    PENDING: {
      tone: "border-warn/35 bg-warn-wash/70",
      head: "Waiting for DNS.",
      body: "The record is not visible yet. That is normal: new records take minutes to a few hours to appear everywhere. Check again whenever you like; nothing here is an error.",
    },
    FAILED: {
      tone: "border-fail/35 bg-fail-wash/70",
      head: "The ownership record is no longer published.",
      body: "This domain was verified before, but its ownership record has gone from DNS. Publish it again to restore verification.",
    },
  }[status];
  return (
    <div
      role="status"
      data-verify-status={status.toLowerCase()}
      className={clsx("flex items-start gap-3 rounded-ctl border px-3 py-2.5 text-ui [animation:hb-rise_200ms_ease-out]", copy.tone)}
    >
      <span aria-hidden className="mt-[3px] grid size-3 shrink-0 place-items-center">
        {status === "VERIFIED" ? (
          <svg viewBox="0 0 16 16" className="hb-draw-check size-3.5 text-ok">
            <path d="M2.5 8.5 6.5 12.5 13.5 3.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
          </svg>
        ) : status === "FAILED" ? (
          <span className="block size-2 rotate-45 bg-fail" />
        ) : (
          <span className="block size-2.5 rounded-full border-2 border-warn-mark [animation:hb-fade_1s_ease-in-out_infinite_alternate]" />
        )}
      </span>
      <p className="text-fg-2">
        <span className={clsx("font-bold", status === "VERIFIED" ? "text-ok" : status === "FAILED" ? "text-fail" : "text-warn")}>{copy.head}</span>{" "}
        {copy.body}
      </p>
    </div>
  );
}
