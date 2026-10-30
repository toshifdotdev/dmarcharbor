/**
 * button.tsx — buttons and button-shaped links, in the Routes language: pills.
 *
 * Four variants and no more:
 *   primary    the one action a screen is for. Ink, or the tenant's brand
 *              colour on their verified domain (globals.css, ACCENT).
 *   secondary  every other action. White with a hairline.
 *   ghost      tertiary, in-table, toolbar.
 *   danger     destructive, and only behind a confirmation.
 *
 * Busy keeps its width. Label and the busy indicator share one grid cell, so
 * the control never reflows under a double click: the bug ActionButton was
 * written to fix, kept fixed here.
 */

import Link from "next/link";
import { clsx } from "clsx";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-grid shrink-0 select-none place-items-center whitespace-nowrap rounded-full font-ui font-semibold " +
  "transition-[background-color,border-color,color,box-shadow] duration-100 " +
  "disabled:cursor-not-allowed aria-disabled:cursor-not-allowed";

const variants: Record<ButtonVariant, string> = {
  // Disabled is NEUTRAL and legible for every variant: a recessed face with
  // grey text, never a faded copy of the enabled colour.
  primary:
    "border border-cta bg-cta text-cta-ink hover:border-cta-hover hover:bg-cta-hover hover:text-cta-ink " +
    "active:border-cta-press active:bg-cta-press " +
    "disabled:border-rule disabled:bg-paper-3 disabled:text-fg-3 aria-disabled:border-rule aria-disabled:bg-paper-3 aria-disabled:text-fg-3",
  secondary:
    "border border-rule-2 bg-paper text-fg hover:border-fg-3 active:bg-paper-3 " +
    "disabled:border-rule disabled:bg-paper-3 disabled:text-fg-3 disabled:hover:border-rule",
  ghost:
    "text-fg-2 hover:bg-paper-3 hover:text-fg active:bg-rule disabled:text-fg-3 disabled:hover:bg-transparent",
  danger:
    "border border-fail bg-fail text-white hover:border-crit hover:bg-crit hover:text-white " +
    "disabled:border-rule disabled:bg-paper-3 disabled:text-fg-3",
};

const sizes: Record<ButtonSize, string> = {
  // sm is the in-table and toolbar size. It keeps the old 10px side padding:
  // rows of four or five of these were laid out against it.
  sm: "h-[30px] gap-1.5 px-2.5 text-meta",
  md: "h-9 gap-2 px-4 text-ui",
  lg: "h-11 gap-2 px-6 text-body",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string) {
  return clsx(base, variants[variant], sizes[size], extra);
}

function Inner({ busy, busyLabel, children }: { busy?: boolean; busyLabel?: string; children: ReactNode }) {
  return (
    <>
      <span
        className="col-start-1 row-start-1 inline-flex items-center gap-[inherit]"
        style={{ visibility: busy ? "hidden" : "visible" }}
      >
        {children}
      </span>
      {busy ? (
        <span className="col-start-1 row-start-1 inline-flex items-center" aria-hidden>
          <Soundings />
        </span>
      ) : null}
      {busy ? <span className="sr-only">{busyLabel ?? "Working"}</span> : null}
    </>
  );
}

/**
 * Three stations lit in turn, like a line being travelled: the busy state,
 * sized to sit inside a button.
 */
function Soundings() {
  return (
    // One svg rather than three spans, so the mark is a single box that can be
    // centred (and measured as centred) in the button.
    <svg width="23" height="5" viewBox="0 0 23 5" className="block" aria-hidden>
      {[0, 1, 2].map((i) => (
        <circle
          key={i}
          cx={2.5 + i * 9}
          cy="2.5"
          r="2.5"
          fill="currentColor"
          style={{ animation: `hb-fade 0.9s ${i * 0.15}s ease-in-out infinite alternate` }}
        />
      ))}
    </svg>
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  busy,
  busyLabel,
  className,
  children,
  type = "button",
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
  /** Read to screen readers while busy, so the state change is announced. */
  busyLabel?: string;
}) {
  return (
    <button
      type={type}
      // Busy is not disabled: it keeps its full colour so the person can see
      // which action is running, and it swallows repeat clicks instead.
      disabled={disabled}
      aria-busy={busy || undefined}
      data-busy={busy ? "true" : undefined}
      className={buttonClass(variant, size, clsx(busy && "cursor-progress", className))}
      {...rest}
      onClick={busy ? (e) => e.preventDefault() : rest.onClick}
    >
      <Inner busy={busy} busyLabel={busyLabel}>
        {children}
      </Inner>
    </button>
  );
}

export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  children,
  ...rest
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      <span className="inline-flex items-center gap-[inherit]">{children}</span>
    </Link>
  );
}
