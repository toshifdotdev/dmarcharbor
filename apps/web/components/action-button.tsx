"use client";

/**
 * action-button.tsx — the one button with a loading state.
 *
 * THE BUG THIS FIXES: swapping the label for a spinner collapses the button's
 * content width. If the content is laid out as anything but true centring, the
 * spinner lands where the leftover space puts it — pushed right — and the
 * layout moves under the pointer on a double click. A loading state that
 * reflows the control you just clicked is the kind of detail a customer feels
 * without being able to name it.
 *
 * THE FIX, mechanical: label and spinner sit in the same grid cell (both
 * `grid-area: 1 / 1`), so the button's width is the max of the two states and
 * cannot change between them, and the visible one is centred by the grid
 * rather than by whatever the label's width made look centred.
 *
 * Every button with a loading state uses this component. If you find one that
 * does not, move it here — a second implementation reintroduces the bug.
 */

import type { CSSProperties, ReactNode } from "react";

export function ActionButton({
  label,
  loadingLabel,
  busy,
  disabled,
  onClick,
  variant = "primary",
  testId,
  style,
  type = "button",
}: {
  /** A string or a resolved ternary — the button keeps one cell for it. */
  label: ReactNode;
  loadingLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "block";
  testId?: string;
  style?: CSSProperties;
  type?: "button" | "submit";
}) {
  const variantStyle: CSSProperties =
    variant === "primary"
      ? { background: "var(--color-accent)", color: "var(--color-accent-ink)" }
      : variant === "block"
        ? { background: "var(--color-block)", color: "#fff" }
        : {
            border: "1px solid var(--color-line-strong)",
            color: "var(--color-ink-2)",
          };

  return (
    <button
      type={type}
      disabled={disabled || busy}
      onClick={onClick}
      data-testid={testId}
      data-busy={busy ? "true" : undefined}
      className="rounded-[2px] px-5 py-2.5 text-[13.5px] font-semibold"
      style={{
        ...variantStyle,
        ...style,
        // Both states occupy one cell: width never changes, and the visible
        // state is centred by the grid: not by the label's leftover space.
        display: "inline-grid",
        gridTemplateAreas: '"stack"',
        placeItems: "center",
        opacity: busy || disabled ? 0.6 : 1,
      }}
    >
      <span style={{ gridArea: "stack", visibility: busy ? "hidden" : "visible", whiteSpace: "nowrap" }}>
        {label}
      </span>
      {busy ? (
        <span style={{ gridArea: "stack" }} aria-hidden>
          <ButtonSpinner />
          <span className="sr-only">{loadingLabel ?? "Working"}</span>
        </span>
      ) : null}
    </button>
  );
}

/**
 * The Tide, sized for a button: just the wave, no label text, so the spinner
 * never widens the control. Reduced-motion aware via the shared stylesheet.
 */
function ButtonSpinner() {
  return (
    <svg width="34" height="14" viewBox="0 0 120 50" fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth="11" strokeLinecap="round">
        <path className="tide-1" d="M18 18 C 32 8, 46 8, 60 18 C 74 28, 88 28, 102 18" />
        <path className="tide-2" d="M18 36 C 32 26, 46 26, 60 36 C 74 46, 88 46, 102 36" />
      </g>
      <style>{`
        .tide-1 { animation: tide 1.2s ease-in-out infinite; }
        .tide-2 { animation: tide 1.2s ease-in-out infinite 0.15s; }
        @keyframes tide {
          0%, 100% { transform: translateX(0); }
          50% { transform: translateX(14px); }
        }
      `}</style>
    </svg>
  );
}
