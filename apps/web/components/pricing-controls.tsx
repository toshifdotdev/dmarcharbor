"use client";

/**
 * pricing-controls.tsx — the pricing page's display controls: currency and
 * billing interval, on one line. They are one family of question — which
 * currency am I quoted, and which period am I buying — and they sit together
 * so a reader picks both before reading a single figure.
 *
 * Currency is the stored billing preference when there is an account: the
 * value a later checkout sends. GET/PATCH /api/workspaces/:id/billing/currency
 * is the contract ({ preferredCurrency, locked, reason }); once `locked`, the
 * control is disabled and `reason` is the explanation (a field, never parsed
 * out of a message). A 409 CURRENCY_LOCKED means a payment already exists: the
 * state is re-read rather than failing generically. Signed out, currency is
 * display only and INR is the default — said out loud, never implied.
 *
 * Interval is display only and travels in the URL.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setBillingCurrency } from "@/lib/ops-client";

// The purchasable currencies. Reads from GET /api/plans today; switches to
// GET /api/capabilities the moment that endpoint lands (its owner's call).
const CURRENCIES = ["INR", "USD"] as const;
const INTERVALS = ["monthly", "annual"] as const;

export type PricingCurrency = (typeof CURRENCIES)[number];
export type PricingInterval = (typeof INTERVALS)[number];

export function PricingControls({
  currency,
  interval,
  locked,
  reason,
  persistable,
  organizationId,
  availableCurrencies = CURRENCIES,
}: {
  currency: PricingCurrency;
  interval: PricingInterval;
  locked: boolean;
  reason: string | null;
  persistable: boolean;
  organizationId: string | null;
  /** The currencies this deployment can actually charge. One entry collapses
    *  the group to a single chip — a one-option toggle is noise. */
  availableCurrencies?: readonly PricingCurrency[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Both controls shape one URL; neither may drop the other's selection.
  const href = (next: { currency?: PricingCurrency; interval?: PricingInterval }) =>
    `/pricing?currency=${next.currency ?? currency}&interval=${next.interval ?? interval}`;

  async function chooseCurrency(next: PricingCurrency) {
    if (next === currency || locked || busy) return;
    setError(null);
    if (!persistable || !organizationId) {
      // Display only: nothing to persist until there is an account.
      router.replace(href({ currency: next }));
      return;
    }
    setBusy(true);
    const res = await setBillingCurrency(organizationId, next);
    setBusy(false);
    if (!res.ok) {
      if (res.error.code === "CURRENCY_LOCKED") {
        // A payment exists: the toggle is stale. Re-read the preference so the
        // reason field renders and the control disables itself.
        router.refresh();
        return;
      }
      setError(res.error.message ?? "The currency could not be changed.");
      return;
    }
    router.replace(href({ currency: next }));
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        {/* Currency: the value a checkout charges. One purchasable
            currency renders as a single chip — no label, no default note. */}
        {availableCurrencies.length > 1 ? (
          <div data-testid="pricing-currency" className="flex items-center gap-2">
            <span className="label">Currency</span>
            {availableCurrencies.map((c) => (
              <button
                key={c}
                type="button"
                disabled={locked || busy}
                aria-pressed={currency === c}
                onClick={() => chooseCurrency(c)}
                data-testid={`pricing-currency-${c}`}
                className="rounded-[2px] border px-3 py-1.5 text-[12px] font-semibold cursor-pointer disabled:cursor-not-allowed"
                style={{
                  borderColor: currency === c ? "var(--color-accent)" : "var(--color-line-strong)",
                  background: currency === c ? "var(--color-accent)" : "transparent",
                  color: currency === c ? "var(--color-accent-ink)" : "var(--color-ink-2)",
                  opacity: locked || busy ? 0.5 : 1,
                }}
              >
                {c === "INR" ? "₹ INR" : "$ USD"}
              </button>
            ))}
            <span className="num text-[11px]" style={{ color: "var(--color-ink-3)" }}>
              INR is the default
            </span>
          </div>
        ) : (
          // The collapsed state: one currency is purchasable, so this is an
          // indicator, not a choice: no aria-pressed on a span that is not a
          // toggle. The chip says what you will be charged in, full stop.
          <div data-testid="pricing-currency" className="flex items-center gap-2">
            <span
              data-testid={`pricing-currency-${availableCurrencies[0]}`}
              aria-label={`Currency: ${availableCurrencies[0]}`}
              className="rounded-[2px] border px-3 py-1.5 text-[12px] font-semibold"
              style={{
                borderColor: "var(--color-accent)",
                background: "var(--color-accent)",
                color: "var(--color-accent-ink)",
              }}
            >
              {availableCurrencies[0] === "INR" ? "₹ INR" : "$ USD"}
            </span>
          </div>
        )}

      {/* Interval: which price the big figure shows. */}
      <div data-testid="pricing-interval" className="flex items-center gap-2">
        <span className="label">Billing</span>
        {INTERVALS.map((i) => (
          <button
            key={i}
            type="button"
            aria-pressed={interval === i}
            onClick={() => router.replace(href({ interval: i }))}
            data-testid={`pricing-interval-${i.toUpperCase()}`}
            className="rounded-[2px] border px-3 py-1.5 text-[12px] font-semibold"
            style={{
              borderColor: interval === i ? "var(--color-accent)" : "var(--color-line-strong)",
              background: interval === i ? "var(--color-accent)" : "transparent",
              color: interval === i ? "var(--color-accent-ink)" : "var(--color-ink-2)",
            }}
          >
            {i === "monthly" ? "Monthly" : (
              <>
                Annual
                <span className="ml-1.5 text-[10.5px] font-medium" style={{ color: interval === i ? "var(--color-accent-ink)" : "var(--color-pass)" }}>
                  save 2 months
                </span>
              </>
            )}
          </button>
        ))}
      </div>

      {locked ? (
        <p
          role="status"
          data-testid="pricing-currency-locked"
          className="text-[12px]"
          style={{ color: "var(--color-unverified)" }}
        >
          {reason ?? "The currency is fixed because this workspace has a payment."}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px]" style={{ color: "var(--color-block)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
