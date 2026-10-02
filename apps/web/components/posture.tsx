/**
 * posture.tsx — posture badges and the Tide loader.
 *
 * Shape carries meaning; colour only echoes it. Square = aligned, diamond =
 * blocking, hollow ring = unverified, hatch = not measured. Every badge carries
 * its word — nothing is colour-only. The Tide loader is the brand's loading
 * state (docs/DESIGN-SYSTEM.md) and is reduced-motion aware.
 */

import type { ReactElement } from "react";

import type { Posture } from "@/lib/posture";
import { POSTURE_META } from "@/lib/posture";

const SHAPE: Record<Posture, ReactElement> = {
  pass: <span className="block size-2 rounded-[1px] bg-[var(--color-pass)]" />,
  block: (
    <span
      className="block size-2 rotate-45 bg-[var(--color-block)]"
      style={{ borderRadius: 1 }}
    />
  ),
  unverified: (
    <span
      className="block size-2 rounded-full border"
      style={{ borderColor: "var(--color-unverified)" }}
    />
  ),
  // Stale = measured once, now quiet: half-filled, half-hatched — it visibly
  // contains both facts. Not measured (below) is hatched only: nothing exists.
  stale: (
    <span className="block size-2 rounded-[1px] overflow-hidden" style={{ border: "1px solid var(--color-unmeasured)" }}>
      <span className="block h-1 w-full bg-[var(--color-unmeasured)]" />
    </span>
  ),
  unmeasured: <span className="hatch block size-2 rounded-[1px]" />,
};

const TONE: Record<Posture, string> = {
  pass: "var(--color-pass)",
  block: "var(--color-block)",
  unverified: "var(--color-unverified)",
  stale: "var(--color-unmeasured)",
  unmeasured: "var(--color-unmeasured)",
};

export function PostureBadge({
  posture,
  reason,
}: {
  posture: Posture;
  reason?: string;
}) {
  const meta = POSTURE_META[posture];
  return (
    <span
      data-testid="posture-badge"
      className="inline-flex items-center gap-2"
      title={reason ?? meta.meaning}
    >
      {SHAPE[posture]}
      <span
        className="num text-[10px] font-semibold tracking-[0.12em] uppercase"
        style={{ color: TONE[posture] }}
      >
        {meta.label}
      </span>
    </span>
  );
}

/** The Tide — three wave strokes flowing in phase. Brand loading state. */
export function TideLoader({ label = "Loading" }: { label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className="inline-flex items-center gap-3"
    >
      <svg width="42" height="20" viewBox="0 0 120 60" fill="none" aria-hidden>
        <g stroke="var(--color-accent)" strokeWidth="11" strokeLinecap="round">
          <path
            className="tide-1"
            d="M18 22 C 32 10, 46 10, 60 22 C 74 34, 88 34, 102 22"
          />
          <path
            className="tide-2"
            d="M18 42 C 32 30, 46 30, 60 42 C 74 54, 88 54, 102 42"
          />
        </g>
      </svg>
      <span className="label">{label}</span>
      <style>{`
        .tide-1 { animation: tide 1.2s ease-in-out infinite; }
        .tide-2 { animation: tide 1.2s ease-in-out infinite 0.15s; }
        @keyframes tide {
          0%, 100% { transform: translateX(0); }
          50% { transform: translateX(14px); }
        }
      `}</style>
    </span>
  );
}
