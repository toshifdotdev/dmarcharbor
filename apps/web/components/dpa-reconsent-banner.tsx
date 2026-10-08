"use client";

import { useState } from "react";
import Link from "next/link";
import { acceptRevisedDpa } from "@/app/actions/dpa";
import { ActionButton } from "@/components/action-button";

/**
 * The re-consent banner.
 *
 * When the Data Processing Agreement is revised, every workspace that accepted
 * the previous version is out of date. The API now refuses their workspace
 * requests rather than only reporting the gap, because a flag with no consumer
 * is not enforcement - and a refusal with no explanation is worse than the gap
 * it was standing in for.
 *
 * So this does three things: it says the agreement changed, it links to the
 * document so the reader can read the thing before agreeing, and it records the
 * acceptance from the same place. Anything less leaves a workspace blocked by a
 * contract nobody has shown them.
 */
export function DpaReconsentBanner({
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

    if (!result.ok) {
      setFailed(result.error);
    }
    // On success there is nothing to do here: the server action revalidates the
    // layouts, the shell's read of the acceptance runs again, and this banner
    // unmounts itself because the condition no longer holds.
  }

  return (
    <div
      role="alert"
      data-testid="dpa-reconsent"
      className="border-b px-6 py-3"
      style={{
        borderColor: "var(--color-unverified)",
        background: "var(--color-unverified-soft)",
      }}
    >
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-[13.5px]" style={{ color: "var(--color-ink)" }}>
          The Data Processing Agreement has been revised, and this workspace agreed
          to an earlier version
          {acceptedVersion ? ` (${acceptedVersion})` : ""}. Requests are blocked
          until the current version ({currentVersion}) is accepted.
        </p>
        <div className="flex items-center gap-2">
          <Link
            href="/dpa"
            className="text-[13px] underline"
            style={{ color: "var(--color-ink-2)" }}
          >
            Read the agreement
          </Link>
          <ActionButton
            label="I accept the revised agreement"
            loadingLabel="Recording"
            busy={busy}
            onClick={accept}
          />
        </div>
      </div>
      {failed ? (
        <p
          className="mx-auto mt-1 max-w-[1400px] text-[12.5px]"
          style={{ color: "var(--color-danger, #b4232a)" }}
        >
          {failed}
        </p>
      ) : null}
    </div>
  );
}
