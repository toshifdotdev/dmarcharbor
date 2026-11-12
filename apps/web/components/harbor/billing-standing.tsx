"use client";

/**
 * billing-standing.tsx — where the workspace stands right now.
 *
 * Set like the head of a statement: the plan and its price for the interval
 * actually billed, then three figures an owner checks every month (the next
 * invoice, who takes the payment, in what currency), then what happens at the
 * end of the period (renews, a scheduled change, or the move to the free plan
 * after a cancellation). When a payment has failed, a state notice above it
 * says what failed, what still works, how long the grace runs and the one way
 * to fix it: the card is changed in the provider's billing portal. There is no
 * charge-retry endpoint, so no retry button is offered.
 *
 * On Razorpay (paid in rupees) we charge a saved mandate ourselves: there is
 * no provider portal, and a renewal that cannot go on the mandate, or failed
 * on it, is paid through a payment link. The page names the saved method, the
 * next charge once it is announced, and offers the link when one is open.
 *
 * Test hooks: pending-plan (always rendered), dunning-panel, dunning-portal,
 * retry-by-provider (says who retries the charge; no retry is promised),
 * dunning-withdrawn, fleet-quantity, fleet-next-quantity, billing-portal,
 * resume-subscription, cancel-subscription.
 */

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cancelSubscription, openBillingPortal, resumeSubscription } from "@/lib/ops-client";
import type { BillingStatus } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClass } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";

const PROVIDER: Record<string, string> = { RAZORPAY: "Razorpay", PADDLE: "Paddle", NONE: "None" };

function shortDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** A renewal waiting on the customer: Razorpay's hosted page, opened directly. */
function PayLink({ due, testId }: { due: NonNullable<BillingStatus["paymentDue"]>; testId: string }) {
  if (!due.payUrl.startsWith("https://")) return null;
  return (
    <a
      href={due.payUrl}
      data-testid={testId}
      className={buttonClass("primary", "md", "self-start")}
    >
      Pay {due.amountLabel}
    </a>
  );
}

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

function Figure({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-meta font-semibold text-fg-3">{label}</dt>
      <dd className="tnum mt-1 text-h3 font-semibold tracking-[-0.01em] text-fg">{value}</dd>
      {note ? <dd className="mt-0.5 text-meta text-fg-3">{note}</dd> : null}
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
  const free = s.priceLabel === "Free";
  const interval = s.interval === "ANNUAL" ? "a year" : "a month";
  const perDomain = s.pricing === "per_domain";
  const failing = s.dunningStage === "WARNED" || s.status === "PAST_DUE";
  const withdrawn = s.dunningStage === "WITHDRAWN";
  const ended = s.status === "EXPIRED" || s.status === "CANCELLED";
  // An ended subscription is history, not something to manage or cancel.
  const hasSubscription = s.provider !== "NONE" && !ended;
  // Razorpay Recurring: we charge a saved mandate ourselves, so there is no
  // provider portal and no provider retry. A renewal that cannot go on the
  // mandate arrives as a payment link instead.
  const mandate = hasSubscription ? (s.mandate ?? null) : null;
  const due = mandate ? (s.paymentDue ?? null) : null;
  const scheduled = mandate ? (s.nextCharge ?? null) : null;
  const mandateUsable = mandate?.status === "confirmed";

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

  const renewal = ended && s.provider !== "NONE"
    ? `The ${PROVIDER[s.provider] ?? ""} subscription has ended. Choose a plan below to start a new one; every client, domain and report is still here.`
    : failing && mandate
    ? `The renewal${periodEnd ? ` on ${periodEnd}` : ""} did not go through. ${due ? "Pay it with the link below." : "A payment link is on its way by email."}`
    : failing && hasSubscription
    ? `The renewal${periodEnd ? ` on ${periodEnd}` : ""} did not go through. ${PROVIDER[s.provider] ?? "The provider"} retries the card on its own.`
    : s.cancelAtPeriodEnd
    ? `Cancelled. ${currentLabel} stays until ${periodEnd ?? "the end of the paid period"}, then the workspace moves to ${freeLabel}. Nothing is deleted.`
    : !hasSubscription
      ? free
        ? "Free, with no payment and nothing to renew."
        : "This plan has no online subscription attached, so nothing renews or charges through this page."
      : mandate
        ? due
          ? `The renewal${periodEnd ? ` on ${periodEnd}` : ""} needs a payment from you: use the link below.`
          : mandateUsable
            ? `Renews${periodEnd ? ` on ${periodEnd}` : ""}${s.interval === "ANNUAL" ? " for another year" : ""}, charged to the saved ${mandate.methodLabel}. We email you 3 days before each charge.`
            : `Renews${periodEnd ? ` on ${periodEnd}` : ""}. The saved ${mandate.methodLabel} cannot be charged, so we email a payment link a week before.`
      : periodEnd
          ? `Renews on ${periodEnd}${s.interval === "ANNUAL" ? ", for another year" : ""}.`
          : "Renews automatically.";

  // The next charge, as far as this page knows it: the API's period end and the
  // price for the interval billed. A scheduled change is named, never priced here.
  const nextInvoice: { value: ReactNode; note: ReactNode } =
    !hasSubscription || free
      ? { value: "None", note: free ? "Nothing is charged on this plan." : "Nothing charges through this page." }
      : s.cancelAtPeriodEnd || ended
        ? { value: "None", note: periodEnd ? `The plan ends ${periodEnd}.` : "The plan is not charged again." }
        : due
        ? { value: due.amountLabel, note: due.payBy ? `Due by payment link, before ${shortDate(due.payBy) ?? "the grace ends"}.` : "Due by payment link." }
        : failing && mandate
        ? { value: "Unpaid", note: "A payment link is on its way by email." }
        : failing
        ? { value: "Unpaid", note: `${s.priceLabel} ${interval}, being retried by ${PROVIDER[s.provider] ?? "the provider"}.` }
        : scheduled
        ? {
            value: scheduled.amountLabel,
            note: `Charged to the ${mandate?.methodLabel ?? "saved method"} on ${shortDate(scheduled.chargeOn) ?? periodEnd ?? "the renewal date"} or shortly after.${
              scheduled.needsApproval ? " It is above ₹15,000, so your bank will ask you to approve it." : ""
            }`,
          }
        : mandate?.carryOverLabel && !pendingLabel
        ? {
            value: periodEnd ?? "Not dated",
            note: `${s.priceLabel} ${interval}, plus ${mandate.carryOverLabel} for the upgrade.`,
          }
        : {
            value: periodEnd ?? "Not dated",
            note: pendingLabel
              ? `For ${pendingLabel}, which applies from then${mandate?.carryOverLabel ? `, plus ${mandate.carryOverLabel} for the upgrade` : ""}.`
              : `${s.priceLabel} ${interval}.`,
          };

  return (
    <section aria-labelledby="standing-head" className="flex flex-col gap-5">
      {failing && !withdrawn ? (
        <div data-testid="dunning-panel" role="alert" className="flex flex-col gap-3 rounded-sheet border border-fail/40 bg-fail-wash px-5 py-4">
          <p className="flex items-center gap-2 text-h3 font-bold text-fail">
            <span aria-hidden className="size-2.5 rotate-45 bg-fail" />
            The last payment did not go through
          </p>
          <p className="max-w-[72ch] text-ui text-fg-2">
            The workspace still works: every client, domain, alert and report keeps running
            {graceUntil ? ` until ${graceUntil}` : " for a short grace period after the paid period ends"}. If it is still
            unpaid then, the workspace moves to {freeLabel}, with all its data kept.{" "}
            {mandate
              ? "To fix it, pay the renewal through the payment link. Paying it also sets up the payment method again, so the next renewal goes through on its own."
              : "To fix it, update the card in the provider\u2019s billing portal; the provider then retries the charge on its own."}
          </p>
          {mandate ? (
            canChange ? (
              due ? (
                <PayLink due={due} testId="dunning-portal" />
              ) : (
                <p className="text-ui font-semibold text-fg">The payment link is on its way to the owner&rsquo;s email.</p>
              )
            ) : (
              <p className="text-ui font-semibold text-fg">Only the workspace owner can pay the renewal. Let them know.</p>
            )
          ) : canChange ? (
            <PortalButton organizationId={organizationId} label="Update the card in the billing portal" testId="dunning-portal" variant="primary" />
          ) : (
            <p className="text-ui font-semibold text-fg">Only the workspace owner can update the card. Let them know.</p>
          )}
          <p data-testid="retry-by-provider" className="text-meta text-fg-3">
            {mandate
              ? "A failed charge is not retried on the saved method. The payment link is the way to pay it."
              : "This page cannot retry the charge. The provider retries it on its own once the card is updated."}
          </p>
        </div>
      ) : null}

      {withdrawn ? (
        <Notice tone="warn" title={`The payment was not recovered, so the workspace moved to ${freeLabel}`} testId="dunning-withdrawn">
          Every client, domain and report is still here. Choosing a plan below restores what the old plan carried.
        </Notice>
      ) : null}

      <div className="grid gap-x-12 gap-y-6 border-y border-fg py-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <p className="text-meta font-semibold text-fg-3">Your plan</p>
            <h2 id="standing-head" className="display mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-h1 text-fg">
              {currentLabel}
              <span className="tnum text-h2 font-semibold tracking-[-0.01em] text-fg-2">
                {s.priceLabel}
                {free ? null : <span className="text-body font-medium text-fg-3"> {interval}</span>}
              </span>
              {s.status !== "ACTIVE" && !failing ? (
                <Badge tone="neutral" className="self-center">
                  {s.status.toLowerCase().replace(/_/g, " ")}
                </Badge>
              ) : null}
            </h2>
            <p className="mt-1.5 text-ui text-fg-2">{renewal}</p>
            {perDomain ? (
              <p className="mt-1 text-ui text-fg-2" data-testid="fleet-quantity">
                {/* Billed, not active: below the minimum the minimum is what is charged. */}
                <span className="tnum font-semibold text-fg">{s.quantity ?? 1}</span> domains billed ×{" "}
                <span className="tnum">{s.unitPriceLabel ?? s.priceLabel}</span> ={" "}
                <span className="tnum font-semibold text-fg">{s.priceLabel}</span> a month.
                {s.nextPeriodQuantity != null && s.nextPeriodQuantity !== s.quantity ? (
                  <span className="mt-0.5 block text-meta text-fg-3" data-testid="fleet-next-quantity">
                    From the next renewal: <span className="tnum font-semibold text-fg-2">{s.nextPeriodQuantity}</span> domains
                    billed
                    {s.perDomainQuote && s.perDomainQuote.activeDomains !== s.nextPeriodQuantity ? (
                      <>
                        {" "}
                        (<span className="tnum">{s.perDomainQuote.activeDomains}</span> active, below this band&rsquo;s minimum)
                      </>
                    ) : null}
                    .
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
          <dl className="grid gap-x-8 gap-y-4 border-t border-rule pt-4 sm:grid-cols-3">
            <Figure label="Next invoice" value={nextInvoice.value} note={nextInvoice.note} />
            <Figure
              label="Paid through"
              value={hasSubscription ? (PROVIDER[s.provider] ?? s.provider) : "None"}
              note={
                mandate
                  ? `Saved ${mandate.methodLabel}${mandate.maxLabel ? `, up to ${mandate.maxLabel} a charge` : ""}${mandateUsable ? "." : ` (${(mandate.status ?? "not confirmed").replace(/_/g, " ")}).`}`
                  : hasSubscription
                    ? "Invoices and the card are kept there."
                    : "No payment provider is attached."
              }
            />
            <Figure
              label="Charged in"
              value={s.currency}
              note={!hasSubscription || free ? "The currency prices are shown in." : s.interval === "ANNUAL" ? "Billed yearly." : "Billed monthly."}
            />
          </dl>
        </div>

        <div className="flex min-w-0 flex-col gap-3 lg:border-l lg:border-rule lg:pl-8">
          <div data-testid="pending-plan" className="text-ui">
            <p className="pb-1 text-meta font-semibold text-fg-3">At the end of this period</p>
            {pendingLabel ? (
              <p className="text-fg-2">
                <span className="font-semibold text-fg">{pendingLabel}</span> applies from {pendingAt ?? "the end of the paid period"}:
                {" "}{currentLabel} until then, then {pendingLabel}.
              </p>
            ) : s.cancelAtPeriodEnd && !ended ? (
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
            <div className="mt-1 flex flex-wrap items-start gap-2">
              {mandate ? (
                due && !failing ? <PayLink due={due} testId="billing-portal" /> : null
              ) : (
                <PortalButton organizationId={organizationId} label="Invoices and payment method" testId="billing-portal" />
              )}
              {s.cancelAtPeriodEnd ? (
                <Button onClick={() => setPending("resume")} data-testid="resume-subscription">
                  Keep {currentLabel}
                </Button>
              ) : !ended ? (
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
