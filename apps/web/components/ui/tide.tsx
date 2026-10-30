/**
 * tide.tsx — the waiting mark, in the Routes language: a message riding a
 * short line from an origin to a terminus, the way messages ride the lines on
 * the home page's map. Nothing has arrived yet; something is on its way.
 *
 * It carries no word; the caller supplies the role="status" and the sr-only
 * label (LoadingState in ./states does both). The line is the accent token
 * (--color-act), so on a tenant's verified domain it takes their colour. The
 * motion lives in globals.css (.hb-ride); under prefers-reduced-motion the
 * message rests halfway along the line.
 *
 * The name and test id are kept from the earlier wave mark, so every caller
 * and check that looks for it still finds it.
 */

import type { CSSProperties } from "react";

export function TideMark({ size = 48, className }: { size?: number; className?: string }) {
  // `size` is the mark's height budget in the earlier wave mark's terms; the
  // line is drawn about twice as wide as that, and a fifth as tall.
  const width = Math.round(size * 2.3);
  return (
    <svg
      width={width}
      height={Math.round(width * 0.2)}
      viewBox="0 0 120 24"
      fill="none"
      aria-hidden
      focusable="false"
      data-testid="tide-mark"
      className={className}
    >
      <path d="M12 12 H106" stroke="var(--color-act)" strokeWidth="5" strokeLinecap="round" />
      {/* The message, riding under the stations. */}
      <g className="hb-ride" style={{ "--ride": "84px" } as CSSProperties}>
        <circle cx="18" cy="12" r="4" fill="var(--color-paper)" stroke="var(--color-act)" strokeWidth="2.5" />
      </g>
      <circle cx="12" cy="12" r="6.5" fill="var(--color-paper)" stroke="var(--color-fg)" strokeWidth="3" />
      <rect x="99" y="2.5" width="16" height="19" rx="8" fill="var(--color-paper)" stroke="var(--color-fg)" strokeWidth="3" />
    </svg>
  );
}
