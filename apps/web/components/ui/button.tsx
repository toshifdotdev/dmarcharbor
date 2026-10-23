/**
 * button.tsx — Chart system buttons and button-shaped links.
 *
 * Four variants and no more:
 *   primary    the one action a screen is for. Accent fill, so a tenant's brand
 *              colour lands here (globals.css, ACCENT RULE).
 *   secondary  every other action. A sheet with a hairline.
 *   ghost      tertiary, in-table, toolbar.
 *   danger     destructive, and only behind a confirmation.
 *
 * Busy keeps its width. Label and the sounding indicator share one grid cell,
 * so the control never reflows under a double click: the bug ActionButton was
 * written to fix, kept fixed here.
 */

import Link from "next/link";
import { clsx } from "clsx";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-grid shrink-0 select-none place-items-center whitespace-nowrap rounded-ctl font-ui font-semibold " +
  "transition-[background-color,border-color,color,box-shadow] duration-100 " +
  "disabled:cursor-not-allowed aria-disabled:cursor-not-allowed";

const variants: Record<ButtonVariant, string> = {
  // Disabled is NEUTRAL and legible for every variant: a recessed face with
  // label-grey text (5.8:1), never a faded copy of the enabled colour.
  primary:
    "border border-cta bg-cta text-cta-ink hover:border-cta-hover hover:bg-cta-hover hover:text-cta-ink " +
    "active:border-cta-press active:bg-cta-press " +
    "disabled:border-rule-2 disabled:bg-paper-3 disabled:text-fg-3 aria-disabled:border-rule-2 aria-disabled:bg-paper-3 aria-disabled:text-fg-3",
  secondary:
    "border border-rule-2 bg-paper-2 text-fg shadow-[0_1px_0_rgb(18_26_34/0.04)] hover:border-fg-3 hover:bg-white " +
    "active:bg-paper-3 disabled:bg-paper-3 disabled:text-fg-3 disabled:shadow-none disabled:hover:border-rule-2",
  ghost:
    "text-fg-2 hover:bg-paper-3 hover:text-fg active:bg-rule disabled:text-fg-3 disabled:hover:bg-transparent",
  danger:
    "border border-fail bg-fail text-white hover:border-crit hover:bg-crit hover:text-white " +
    "disabled:border-rule-2 disabled:bg-paper-3 disabled:text-fg-3",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 px-2.5 text-meta",
  md: "h-8 gap-2 px-3.5 text-ui",
  lg: "h-10 gap-2 px-5 text-body",
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

/** Three marks taken in turn: the busy state, sized to sit inside a button. */
function Soundings() {
  return (
    <span className="inline-flex gap-[3px]">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="block size-[5px] bg-current"
          style={{ animation: `hb-fade 0.9s ${i * 0.15}s ease-in-out infinite alternate` }}
        />
      ))}
    </span>
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
