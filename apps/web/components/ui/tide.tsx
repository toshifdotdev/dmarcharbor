/**
 * tide.tsx — the waiting mark, in the Routes language: a message riding a
 * short line from an origin to a terminus, the way messages ride the lines on
 * the home page's map. Nothing has arrived yet; something is on its way.
 *
 * It carries no word; the caller supplies the role="status" and the label
 * (LoadingState and InlineWaiting in ./states do both). The line is the accent
 * token (--color-act), so on a tenant's verified domain it takes their colour.
 *
 * The message is drawn halfway along the line, so the still picture (no CSS
 * yet, or prefers-reduced-motion) is the same in both cases. The motion lives
 * in globals.css (.hb-ride): it rides from the origin to the terminus, centred
 * on that halfway point, for everyone who has not asked for less motion.
 *
 * The name (TideMark) and the test id (tide-mark) are what callers and checks
 * look for; keep both.
 */

import type { CSSProperties } from "react";

export function TideMark({ size = 48, className }: { size?: number; className?: string }) {
  // `size` is a height budget for the space the mark sits in; the line is
  // drawn 2.3 times as wide as that, and a fifth of that width tall.
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
      {/* The message, riding under the stations: from x 18 to x 102. */}
      <g className="hb-ride" style={{ "--ride": "84px" } as CSSProperties}>
        <circle cx="60" cy="12" r="4" fill="var(--color-paper)" stroke="var(--color-act)" strokeWidth="2.5" />
      </g>
      <circle cx="12" cy="12" r="6.5" fill="var(--color-paper)" stroke="var(--color-fg)" strokeWidth="3" />
      <rect x="99" y="2.5" width="16" height="19" rx="8" fill="var(--color-paper)" stroke="var(--color-fg)" strokeWidth="3" />
    </svg>
  );
}
