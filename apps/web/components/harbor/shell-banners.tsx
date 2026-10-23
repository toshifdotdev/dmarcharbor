"use client";

/**
 * shell-banners.tsx — the two conditions the Chart shell states above every
 * screen: an out-of-date Data Processing Agreement, and a custom domain whose
 * record is not verified yet.
 *
 * Same behaviour as the Monolith banners (dpa-reconsent-banner.tsx and the
 * shell's unverified notice), same server action, same test ids. The API now
 * refuses workspace requests under a superseded agreement, so the banner both
 * explains the refusal and resolves it from where it is shown.
 */

import Link from "next/link";
import { useState } from "react";
import { acceptRevisedDpa } from "@/app/actions/dpa";
import { Button } from "@/components/ui/button";

export function DpaBanner({
  organizationId,
  acceptedVersion,
  currentVersion,
}: {
  organizationId: string;
  acceptedVersion: string | null;
  currentVersion: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setFailed(null);
    const result = await acceptRevisedDpa(organizationId);
    setBusy(false);
    // On success the server action revalidates the layout and this unmounts.
    if (!result.ok) setFailed(result.error);
  }

  return (
    <div role="alert" data-testid="dpa-reconsent" className="border-b border-warn/30 bg-warn-wash px-5 py-2.5 lg:px-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 text-ui text-fg">
          <span className="font-semibold">The Data Processing Agreement has been revised.</span> This workspace agreed to
          an earlier version{acceptedVersion ? <span className="data"> ({acceptedVersion})</span> : null}, so requests are
          blocked until the current version (<span className="data">{currentVersion}</span>) is accepted.
        </p>
        <div className="flex items-center gap-3">
          <Link href="/dpa" className="link text-ui">
            Read the agreement
          </Link>
          <Button variant="primary" size="sm" busy={busy} busyLabel="Recording acceptance" onClick={accept}>
            I accept the revised agreement
          </Button>
        </div>
      </div>
      {failed ? <p className="mt-1 text-meta font-medium text-fail">{failed}</p> : null}
    </div>
  );
}

export function HostUnverifiedBanner() {
  return (
    <div role="status" data-testid="host-unverified" className="border-b border-warn/30 bg-warn-wash px-5 py-2 lg:px-8">
      <p className="text-meta text-fg-2">
        <span className="font-semibold text-warn">Custom domain not verified.</span> This address points here, but its
        TXT record is not verified yet, so the default brand is shown instead of yours. Verify the record to serve your
        branding from this address.
      </p>
    </div>
  );
}
