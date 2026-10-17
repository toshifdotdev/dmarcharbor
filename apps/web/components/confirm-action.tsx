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

/**
 * What a destructive call reports back.
 *
 * Returning `undefined` means "nothing went wrong", which is what every older
 * caller does. Returning `{ ok: false, message }` keeps the control armed and
 * puts the reason on screen — the difference between "it did nothing, apparently"
 * and a refusal that can be acted on, such as revoking a portal grant and trying
 * again.
 */
export interface ConfirmOutcome {
  ok: boolean;
  message?: string;
}

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
  onConfirm: () => void | Promise<ConfirmOutcome | void>;
  testId?: string;
  tone?: "block" | "ink";
  busy?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A destructive call that can be fired twice by one impatient double-click is
  // its own kind of bug, so the button disables itself for the round trip rather
  // than trusting the caller to pass `busy`.
  const [pending, setPending] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => {
          // Re-arming clears the last refusal, so the reason for it never sits on
          // screen contradicting the question being asked now.
          setError(null);
          setArmed(true);
        }}
        data-testid={testId}
        className="text-[11.5px] underline"
        style={{ color: tone === "block" ? "var(--color-block)" : "var(--color-ink-2)" }}
      >
        {label}
      </button>
    );
  }

  async function confirm() {
    setPending(true);
    let result: void | ConfirmOutcome;
    try {
      result = await onConfirm();
    } finally {
      setPending(false);
    }
    // `undefined` is the pre-existing contract: the caller reported nothing, so
    // there is nothing to show and the row is free to disappear.
    if (result === undefined || result === null || result.ok) {
      setArmed(false);
      return;
    }
    // A refusal leaves the control armed, on purpose. The operator can read why,
    // go and resolve it, and press the same button again — rather than having
    // the question vanish and leave them wondering whether it worked.
    setError(result.message ?? "That could not be deleted. Try again.");
  }

  return (
    <span
      role="group"
      data-testid={testId ? `${testId}-confirm` : undefined}
      className="flex flex-wrap items-center gap-2"
    >
      <span className="text-[11px]" style={{ color: "var(--color-ink-3)" }}>
        {consequence}
      </span>
      <button
        type="button"
        disabled={busy || pending}
        onClick={confirm}
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
        onClick={() => {
          setArmed(false);
          setError(null);
        }}
        className="text-[11px]"
        style={{ color: "var(--color-ink-3)" }}
      >
        cancel
      </button>
      {error ? (
        <span
          role="alert"
          data-testid={testId ? `${testId}-error` : undefined}
          className="basis-full text-[11px]"
          style={{ color: "var(--color-block)" }}
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}
