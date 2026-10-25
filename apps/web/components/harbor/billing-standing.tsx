"use client";

/**
 * billing-standing.tsx — where the workspace stands right now.
 *
 * The plan and its price for the interval actually billed, what happens at the
 * end of the period (renews, a scheduled change, or the move to the free plan
 * after a cancellation), and, when a payment has failed, what failed, what
 * still works, how long the grace runs and the one way to fix it: the card is
 * changed in the provider's billing portal. There is no charge-retry endpoint,
 * so no retry button is offered.
 *
 * Test hooks: pending-plan (always rendered), dunning-panel, dunning-portal,
 * retry-by-provider (says who retries the charge; no retry is promised).
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cancelSubscription, openBillingPortal, resumeSubscription } from "@/lib/ops-client";
import type { BillingStatus } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";

const PROVIDER: Record<string, string> = { RAZORPAY: "Razorpay", PADDLE: "Paddle", NONE: "None" };

function PortalButton({
  organizationId,
  label,
  testId,
  variant = "secondary",
}: {
  organizationId: string;
  label: string;
  testId: string;
  variant?: "primary" | "secondary";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant={variant}
        busy={busy}
        busyLabel="Opening"
        data-testid={testId}
        className="self-start"
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await openBillingPortal(organizationId);
          setBusy(false);
          if (res.ok && res.data.url?.startsWith("https://")) {
            window.location.href = res.data.url;
            return;
          }
          setError(res.ok ? "The provider did not return a portal address." : (res.error.message ?? "The billing portal could not be opened."));
        }}
      >
        {label}
      </Button>
      {error ? (
        <p role="alert" className="max-w-[60ch] text-meta font-semibold text-fail">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function BillingStanding({
  organizationId,
  status: s,
  currentLabel,
  freeLabel,
  pendingLabel,
  periodEnd,
  pendingAt,
  graceUntil,
  canChange,
}: {
  organizationId: string;
  status: BillingStatus;
  currentLabel: string;
  freeLabel: string;
  pendingLabel: string | null;
  periodEnd: string | null;
  pendingAt: string | null;
  graceUntil: string | null;
  canChange: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"cancel" | "resume" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasSubscription = s.provider !== "NONE";
  const free = s.priceLabel === "Free";
  const interval = s.interval === "ANNUAL" ? "a year" : "a month";
  const perDomain = s.pricing === "per_domain";
  const failing = s.dunningStage === "WARNED" || s.status === "PAST_DUE";
  const withdrawn = s.dunningStage === "WITHDRAWN";

  async function confirm() {
    setBusy(true);
    setError(null);
    const res = pending === "cancel" ? await cancelSubscription(organizationId) : await resumeSubscription(organizationId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message ?? "That did not go through.");
      return;
    }
    setPending(null);
    router.refresh();
  }

  const renewal = s.cancelAtPeriodEnd
    ? `Cancelled. ${currentLabel} stays until ${periodEnd ?? "the end of the paid period"}, then the workspace moves to ${freeLabel}. Nothing is deleted.`
    : !hasSubscription
      ? free
        ? "Free, with no payment and nothing to renew."
        : "This plan has no online subscription attached, so nothing renews or charges through this page."
      : s.status === "EXPIRED" || s.status === "CANCELLED"
        ? `The subscription has ended${periodEnd ? ` (${periodEnd})` : ""}.`
        : periodEnd
          ? `Renews on ${periodEnd}${s.interval === "ANNUAL" ? ", for another year" : ""}.`
          : "Renews automatically.";

  return (
    <section aria-labelledby="standing-head" className="flex flex-col gap-4">
      {failing && !withdrawn ? (
        <div data-testid="dunning-panel" role="alert" className="flex flex-col gap-3 rounded-ctl border border-fail/40 bg-fail-wash/70 px-4 py-4">
          <p className="text-h3 font-bold text-fail">The last payment did not go through</p>
          <p className="max-w-[72ch] text-ui text-fg-2">
            The workspace still works: every client, domain, alert and report keeps running
            {graceUntil ? ` until ${graceUntil}` : " for a short grace period after the paid period ends"}. If it is still
            unpaid then, the workspace moves to {freeLabel}, with all its data kept. To fix it, update the card in the
            provider&rsquo;s billing portal; the provider then retries the charge on its own.
          </p>
          {canChange ? (
            <PortalButton organizationId={organizationId} label="Update the card in the billing portal" testId="dunning-portal" variant="primary" />
          ) : (
            <p className="text-ui font-semibold text-fg">Only the workspace owner can update the card. Let them know.</p>
          )}
          <p data-testid="retry-by-provider" className="text-meta text-fg-3">
            This page cannot retry the charge. The provider retries it on its own once the card is updated.
          </p>
        </div>
      ) : null}

      {withdrawn ? (
        <Notice tone="warn" title={`The payment was not recovered, so the workspace moved to ${freeLabel}`} testId="dunning-withdrawn">
          Every client, domain and report is still here. Choosing a plan below restores what the old plan carried.
        </Notice>
      ) : null}

      <div className="grid gap-x-10 gap-y-5 border-y border-fg py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5">
          <p className="legend">Your plan</p>
          <h2 id="standing-head" className="display flex flex-wrap items-baseline gap-x-3 text-[30px] leading-none text-fg">
            {currentLabel}
            <span className="tnum text-[20px] font-semibold text-fg-2">
              {s.priceLabel}
              {free ? null : <span className="text-body font-medium text-fg-3"> {interval}</span>}
            </span>
          </h2>
          {perDomain ? (
            <p className="text-ui text-fg-2" data-testid="fleet-quantity">
              {/* Billed, not active: below the minimum the minimum is what is charged. */}
              <span className="tnum font-semibold text-fg">{s.quantity ?? 1}</span> domains billed ×{" "}
              <span className="tnum">{s.unitPriceLabel ?? s.priceLabel}</span> ={" "}
              <span className="tnum font-semibold text-fg">{s.priceLabel}</span> a month.
              {s.nextPeriodQuantity != null && s.nextPeriodQuantity !== s.quantity ? (
                <span className="mt-0.5 block text-meta text-fg-3" data-testid="fleet-next-quantity">
                  From the next renewal: <span className="tnum font-semibold text-fg-2">{s.nextPeriodQuantity}</span> active
                  domains.
                </span>
              ) : null}
            </p>
          ) : null}
          <p className="text-ui text-fg-2">{renewal}</p>
          <p className="flex flex-wrap gap-x-4 gap-y-0.5 text-meta text-fg-3">
            {hasSubscription ? <span>Paid through {PROVIDER[s.provider] ?? s.provider}</span> : null}
            <span>Charged in {s.currency}</span>
            {s.status !== "ACTIVE" && !failing ? <Badge tone="neutral">{s.status.toLowerCase().replace(/_/g, " ")}</Badge> : null}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <div data-testid="pending-plan" className="text-ui">
            <p className="legend pb-1">At the end of this period</p>
            {pendingLabel ? (
              <p className="text-fg-2">
                <span className="font-semibold text-fg">{pendingLabel}</span> applies from {pendingAt ?? "the end of the paid period"}:
                {" "}{currentLabel} until then, then {pendingLabel}.
              </p>
            ) : s.cancelAtPeriodEnd ? (
              <p className="text-fg-2">
                The workspace moves to <span className="font-semibold text-fg">{freeLabel}</span>.
              </p>
            ) : (
              <p className="text-fg-2">No plan change is scheduled.</p>
            )}
          </div>
          {pendingLabel ? (
            <p className="text-meta text-fg-3">
              Everything you have now stays until the change applies, and nothing is deleted when it does.
            </p>
          ) : null}
          {canChange && hasSubscription ? (
            <div className="flex flex-wrap items-start gap-2">
              <PortalButton organizationId={organizationId} label="Invoices and payment method" testId="billing-portal" />
              {s.cancelAtPeriodEnd ? (
                <Button onClick={() => setPending("resume")} data-testid="resume-subscription">
                  Keep {currentLabel}
                </Button>
              ) : s.status !== "EXPIRED" && s.status !== "CANCELLED" ? (
                <Button variant="ghost" onClick={() => setPending("cancel")} data-testid="cancel-subscription">
                  Cancel the subscription
                </Button>
              ) : null}
            </div>
          ) : null}
          {!canChange ? (
            <p className="text-meta text-fg-3">Only the workspace owner can change the plan or the payment method.</p>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirm}
        busy={busy}
        error={error}
        danger={pending === "cancel"}
        testId={pending === "cancel" ? "cancel-subscription" : "resume-subscription"}
        title={pending === "cancel" ? `Cancel ${currentLabel}?` : `Keep ${currentLabel}?`}
        confirmLabel={pending === "cancel" ? "Cancel at period end" : `Keep ${currentLabel}`}
        body={
          pending === "cancel"
            ? `Nothing changes until ${periodEnd ?? "the paid period ends"}: ${currentLabel} keeps working and is not charged again. Then the workspace moves to ${freeLabel}, keeping every client, domain and report. You can keep the plan any time before then.`
            : `The cancellation is withdrawn and ${currentLabel} renews${periodEnd ? ` on ${periodEnd}` : ""} as before.`
        }
      />
    </section>
  );
}
