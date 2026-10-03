"use client";

/**
 * confirm-action.tsx — destructive actions get a deliberate second step.
 *
 * "Must not be one keystroke away from something harmless": the control is
 * keyboard-reachable (it is a button), but the destructive call happens only
 * after an explicit second press on a control that names the consequence.
 * No modal is involved, so nothing has to trap focus — the confirm pair lives
 * in document order right after its trigger, which is where a keyboard user
 * expects it.
 */

import { useState } from "react";

export function ConfirmAction({
  label,
  confirmLabel,
  consequence,
  onConfirm,
  testId,
  tone = "block",
  busy,
}: {
  label: string;
  confirmLabel: string;
  consequence: string;
  onConfirm: () => void;
  testId?: string;
  tone?: "block" | "ink";
  busy?: boolean;
}) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        data-testid={testId}
        className="text-[11.5px] underline"
        style={{ color: tone === "block" ? "var(--color-block)" : "var(--color-ink-2)" }}
      >
        {label}
      </button>
    );
  }

  return (
    <span
      role="group"
      data-testid={testId ? `${testId}-confirm` : undefined}
      className="flex items-center gap-2"
    >
      <span className="text-[11px]" style={{ color: "var(--color-ink-3)" }}>
        {consequence}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
        data-testid={testId ? `${testId}-confirm-button` : undefined}
        className="rounded-[2px] border px-2.5 py-1 text-[11px] font-semibold"
        style={{
          borderColor: tone === "block" ? "var(--color-block)" : "var(--color-line-strong)",
          color: tone === "block" ? "var(--color-block)" : "var(--color-ink)",
        }}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="text-[11px]"
        style={{ color: "var(--color-ink-3)" }}
      >
        cancel
      </button>
    </span>
  );
}
