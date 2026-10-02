/**
 * entitlement-gate.tsx — the client-side twin of upgrade-gate: an inline
 * notice for a 402 that a mutation returned. Routed by the `feature` key from
 * the body (carried on a data attribute for tests, never rendered — a
 * routing key is not user copy), and the plan wording is the API's own
 * message quoted verbatim.
 */

import Link from "next/link";
import type { ApiErrorBody } from "@/lib/types";

export function EntitlementNotice({
  error,
  onDismiss,
}: {
  error: ApiErrorBody["error"];
  onDismiss?: () => void;
}) {
  return (
    <div
      role="status"
      data-feature={error.feature ?? "unknown"}
      className="rounded-[2px] border px-4 py-3"
      style={{
        borderColor: "var(--color-unverified)",
        background: "var(--color-unverified-soft)",
      }}
    >
      <div
        className="num text-[12.5px] font-semibold tracking-[0.12em] uppercase"
        style={{ color: "var(--color-unverified)" }}
      >
        Not on your current plan
      </div>
      <p className="mt-1.5 text-[15px]" style={{ color: "var(--color-ink-2)" }}>
        {error.message ?? "This capability is not included in the current plan."}
      </p>
      <div className="mt-2.5 flex items-center gap-4">
        <Link href="/billing" className="text-[14.5px] font-semibold underline" style={{ color: "var(--color-ink)" }}>
          See plan options
        </Link>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="text-[14px]"
            style={{ color: "var(--color-ink-3)" }}
          >
            dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
