/**
 * upgrade-gate.tsx — the one place a 402 becomes an upgrade prompt.
 *
 * The 402 body is { error: { code, message, feature } } where feature is the
 * entitlement key. The prompt is ROUTED BY THAT KEY internally — never by
 * pattern matching the message — but the key is a routing detail, not user
 * copy: it rides on a data attribute for tests, never on screen. Plan names
 * come from the API's own error body; nothing here knows what a plan is called.
 */

import Link from "next/link";
import type { ApiErrorBody } from "@/lib/types";

export function UpgradePrompt({
  error,
  context,
}: {
  error: ApiErrorBody["error"];
  context?: string;
}) {
  return (
    <div
      role="status"
      data-feature={error.feature ?? "unknown"}
      className="lift rounded-[2px] border px-5 py-6"
      style={{
        background: "var(--color-surface)",
        borderColor: "var(--color-line-strong)",
      }}
    >
      <div className="label">Not on your current plan</div>
      <p
        className="mt-2 text-[17.5px] font-semibold tracking-[-0.012em]"
        style={{ color: "var(--color-ink)" }}
      >
        {error.message ?? "This capability is not included in the current plan."}
      </p>
      {context ? (
        <p className="mt-1.5 text-[15px]" style={{ color: "var(--color-ink-2)" }}>
          {context}
        </p>
      ) : null}
      <div className="mt-4 flex items-center gap-3">
        <Link
          href="/billing"
          className="rounded-[2px] px-4 py-2 text-[14.5px] font-semibold"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
        >
          See plan options
        </Link>
        <Link
          href="/"
          className="text-[14px]"
          style={{ color: "var(--color-ink-3)" }}
        >
          Back to portfolio
        </Link>
      </div>
    </div>
  );
}
