"use client";

/**
 * dunning-client.tsx — payment recovery, in states the customer can read.
 *
 * A failed payment is not an outage. During the grace period the workspace
 * keeps working, and the panel says exactly that: what failed, what still
 * works, how long the grace runs, and what resolves it. A red banner with no
 * grace state is why people email support instead of fixing a card.
 *
 * The resolution path is the billing portal — the card has to change. There is
 * no payment-retry endpoint in the API, and a "retry" button that re-attempts a
 * charge the same card would fail again is theatre, so the spot is reserved and
 * labelled honestly rather than faked.
 *
 * dunningStage (NONE | WARNED | WITHDRAWN — the API's final enum) and graceEnds
 * land on GET
 * /billing; while the field is absent the panel degrades to the honest
 * statement derived from status alone and never asserts a countdown it cannot
 * source.
 */

import { ActionButton } from "@/components/action-button";
import { useState } from "react";
import { openBillingPortal } from "@/lib/ops-client";
import type { DunningStage } from "@/lib/types";

export function DunningPanel({
  organizationId,
  stage,
  graceEnds,
  status,
}: {
  organizationId: string;
  stage: DunningStage | undefined;
  graceEnds: string | null | undefined;
  status: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // NONE | WARNED | WITHDRAWN — the API's final enum. Any value other than
  // NONE means payment recovery is running, and that is what decides whether
  // this panel shows.
  const inRecovery = status === "PAST_DUE" || stage === "WARNED" || stage === "WITHDRAWN";
  if (!inRecovery) return null;

  const grace = graceEnds ? new Date(graceEnds) : null;
  const daysLeft = grace
    ? Math.max(0, Math.ceil((grace.getTime() - Date.now()) / 86_400_000))
    : null;

  return (
    <section
      data-testid="dunning-panel"
      className="mt-5 rounded-[2px] border px-5 py-4"
      style={{
        borderColor: "var(--color-unverified)",
        background: "var(--color-unverified-soft)",
      }}
    >
      <p
        className="num text-[11px] font-semibold tracking-[0.12em] uppercase"
        style={{ color: "var(--color-unverified)" }}
      >
        Payment needs attention
        {stage === "WARNED" || stage === "WITHDRAWN" ? ` · ${stage.toLowerCase()}` : ""}
      </p>

      <div className="mt-2.5 grid grid-cols-1 gap-x-10 gap-y-3 sm:grid-cols-3">
        <div>
          <div className="label">What failed</div>
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
            The last payment for this subscription did not go through.
          </p>
        </div>
        <div>
          <div className="label">What still works</div>
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
            Everything. Your workspace keeps running during the grace period —
            monitoring, alerts and reports are all still on.
          </p>
        </div>
        <div>
          <div className="label">How long the grace runs</div>
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-ink)" }}>
            {grace ? (
              <>
                until{" "}
                <span className="num">
                  {grace.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}
                </span>
                {daysLeft !== null ? ` — ${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : ""}
              </>
            ) : (
              <span style={{ color: "var(--color-ink-3)" }}>
                countdown not reported yet
              </span>
            )}
          </p>
          <p className="mt-1 text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
            After it ends the workspace moves to the free plan.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <ActionButton
          label={"Fix payment in the billing portal"}
          loadingLabel={"Opening…"}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            // The honest fix: the card has to change, so the portal is the
            // resolution path. No fake retry exists and none is invented.
            const res = await openBillingPortal(organizationId);
            setBusy(false);
            if (res.ok && res.data?.url) window.location.href = res.data.url;
            else if (!res.ok) setError(res.error?.message ?? "The billing portal could not be opened.");
          }}
          testId="dunning-portal"
        />

        <span
          className="num text-[11px]"
          style={{ color: "var(--color-ink-3)" }}
          data-testid="retry-coming"
          title="A one-click charge retry is not available yet — the card itself has to be updated for a retry to succeed."
        >
          one-click payment retry: coming soon
        </span>
      </div>

      {error ? (
        <p role="alert" className="mt-2.5 text-[12.5px]" style={{ color: "var(--color-block)" }}>
          {error}
        </p>
      ) : null}

      <p className="mt-3 text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
        If you believe this is a mistake, the payment record is visible in the
        billing portal alongside your invoices.
      </p>
    </section>
  );
}
