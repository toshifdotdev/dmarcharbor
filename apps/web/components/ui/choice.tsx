"use client";

/**
 * choice.tsx — checkbox, switch, and the textarea.
 *
 * The checkbox is the native input, drawn over: form participation, label
 * clicks and screen-reader semantics come from the platform. The switch is a
 * button with role="switch", for settings that take effect the moment they are
 * flipped; anything that waits for a Save button is a checkbox, never a switch,
 * because a switch that has not done anything yet is a lie about state.
 */

import { clsx } from "clsx";
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export function Checkbox({
  label,
  hint,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label className={clsx("group inline-flex cursor-pointer items-start gap-2.5 has-[:disabled]:cursor-not-allowed", className)}>
      <span className="relative mt-[2px] grid size-4 shrink-0 place-items-center">
        <input
          type="checkbox"
          className={clsx(
            "peer size-4 appearance-none rounded-[5px] border border-rule-2 bg-paper",
            "checked:border-act checked:bg-act hover:border-fg-3 disabled:bg-paper-3 disabled:checked:bg-fg-3 disabled:checked:border-fg-3",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-act",
          )}
          {...rest}
        />
        <svg viewBox="0 0 16 16" className="pointer-events-none absolute size-3 text-act-ink opacity-0 peer-checked:opacity-100" aria-hidden>
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </span>
      <span className="min-w-0">
        <span className="block text-ui font-medium text-fg group-has-[:disabled]:text-fg-3">{label}</span>
        {hint ? <span className="mt-0.5 block text-meta text-fg-3">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  busy,
  describedBy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. Visible text beside the switch should say the same. */
  label: string;
  disabled?: boolean;
  /** The change is in flight: the switch shows where it is going and holds. */
  busy?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      aria-describedby={describedBy}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-100",
        checked ? "border-act bg-act" : "border-rule-2 bg-paper-3",
        "disabled:cursor-not-allowed disabled:border-rule-2 disabled:bg-paper-3",
        busy && "opacity-70",
      )}
    >
      <span
        aria-hidden
        className={clsx(
          "block size-3.5 rounded-full transition-transform duration-100",
          checked ? "translate-x-[18px] bg-white" : "translate-x-[2px] bg-paper ring-1 ring-rule-2",
        )}
      />
    </button>
  );
}

export function Textarea({
  className,
  mono,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return (
    <textarea
      className={clsx(
        "min-h-[88px] w-full rounded-ctl border border-rule-2 bg-paper px-3 py-2 text-ui text-fg placeholder:text-fg-4",
        "hover:border-fg-4 focus-visible:border-act focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-act-line/35",
        "disabled:cursor-not-allowed disabled:bg-paper-3 disabled:text-fg-3 aria-[invalid=true]:border-fail",
        mono && "data",
        className,
      )}
      {...rest}
    />
  );
}
