"use client";

/**
 * pricing-currency.tsx — the currency toggle on the pricing page.
 *
 * GET/PATCH /api/workspaces/:id/billing/currency is the contract:
 * { preferredCurrency, locked, reason }. The toggle changes the currency shown
 * and the currency a later checkout sends — they are one choice, so a page can
 * never quote one currency and charge another. Once `locked` is true the
 * control is disabled and `reason` is the explanation (a field, never parsed
 * out of a message). A 409 CURRENCY_LOCKED means a payment already exists:
 * the state is re-read and `reason` is shown, not a generic failure.
 *
 * Signed out there is nothing to persist — the toggle is display only, and the
 * page falls back to the default, which is INR and says so rather than being
 * implicit.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setBillingCurrency } from "@/lib/ops-client";

export function PricingCurrencyToggle({
  currency,
  locked,
  reason,
  persistable,
  organizationId,
}: {
  currency: "USD" | "INR";
  locked: boolean;
  reason: string | null;
  persistable: boolean;
  organizationId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(next: "USD" | "INR") {
    if (next === currency || locked || busy) return;
    setError(null);
    if (!persistable || !organizationId) {
      // Display only: nothing to persist until there is an account.
      router.replace(`/pricing?currency=${next}`);
      return;
    }
    setBusy(true);
    const res = await setBillingCurrency(organizationId, next);
    setBusy(false);
    if (!res.ok) {
      if (res.error.code === "CURRENCY_LOCKED") {
        // A payment exists — the toggle is stale. Re-read the preference so the
        // reason field renders and the control disables itself.
        router.refresh();
        return;
      }
      setError(res.error.message ?? "The currency could not be changed.");
      return;
    }
    router.replace(`/pricing?currency=${next}`);
    router.refresh();
  }

  return (
    <div data-testid="pricing-currency" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="label">Currency</span>
        {(["INR", "USD"] as const).map((c) => (
          <button
            key={c}
            type="button"
            disabled={locked || busy}
            aria-pressed={currency === c}
            onClick={() => choose(c)}
            data-testid={`pricing-currency-${c}`}
            className="rounded-[2px] border px-3 py-1.5 text-[12px] font-semibold"
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
      {locked ? (
        <p role="status" data-testid="pricing-currency-locked" className="text-[12px]" style={{ color: "var(--color-unverified)" }}>
          {reason ??
            "The currency is fixed because this workspace has a payment."}
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
