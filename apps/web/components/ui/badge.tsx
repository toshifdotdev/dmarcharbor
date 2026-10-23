/**
 * badge.tsx — state words, and the posture marks.
 *
 * A badge is a word with a state colour, and every state has a SHAPE as well,
 * so nothing on screen is colour-only (the Monolith vocabulary, kept because it
 * is right):
 *
 *   aligned       filled square
 *   blocking      filled diamond
 *   unverified    open ring
 *   stale         half-filled square: it was measured, then reports stopped
 *   not measured  hatched square: nothing exists to show
 *
 * Badges are text with a mark, not pills. On paper a filled lozenge per row is
 * shouting; a mark and a word in the state colour reads at a glance and keeps
 * the column quiet.
 */

import { clsx } from "clsx";
import type { ReactNode } from "react";
import { POSTURE_META, type Posture } from "@/lib/posture";

export type Tone = "neutral" | "ok" | "warn" | "fail" | "crit" | "void" | "accent";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-fg-2",
  ok: "text-ok",
  warn: "text-warn",
  fail: "text-fail",
  crit: "text-crit",
  void: "text-void",
  accent: "text-act",
};

/**
 * A state word. `boxed` draws a hairline frame and wash: for the few places a
 * state must read as a label on its own (a status in a page header), never in
 * a table column.
 */
export function Badge({
  tone = "neutral",
  boxed,
  children,
  className,
  title,
}: {
  tone?: Tone;
  boxed?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-meta font-semibold",
        TONE_TEXT[tone],
        boxed && "rounded-[2px] border px-1.5 py-px",
        boxed && tone === "ok" && "border-ok/30 bg-ok-wash",
        boxed && tone === "warn" && "border-warn/30 bg-warn-wash",
        boxed && tone === "fail" && "border-fail/30 bg-fail-wash",
        boxed && tone === "crit" && "border-crit bg-crit text-white",
        boxed && tone === "void" && "border-void/30 bg-void-wash",
        boxed && tone === "neutral" && "border-rule-2 bg-paper-3",
        boxed && tone === "accent" && "border-act bg-paper-2",
        className,
      )}
    >
      {children}
    </span>
  );
}

export const POSTURE_TONE: Record<Posture, Tone> = {
  pass: "ok",
  block: "fail",
  unverified: "warn",
  stale: "void",
  unmeasured: "void",
};

/** The posture shape alone, sized to the text it sits beside. */
export function PostureMark({ posture, size = 9 }: { posture: Posture; size?: number }) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 10 10" aria-hidden className="shrink-0 self-center">
      {posture === "pass" ? <rect x="0.5" y="0.5" width="9" height="9" fill="var(--color-ok)" /> : null}
      {posture === "block" ? <path d="M5 0 10 5 5 10 0 5Z" fill="var(--color-fail)" /> : null}
      {posture === "unverified" ? (
        <circle cx="5" cy="5" r="3.9" fill="none" stroke="var(--color-warn-mark)" strokeWidth="2" />
      ) : null}
      {posture === "stale" ? (
        <>
          <rect x="1" y="1" width="8" height="8" fill="none" stroke="var(--color-void)" strokeWidth="1.5" />
          <rect x="1" y="5" width="8" height="4" fill="var(--color-void)" />
        </>
      ) : null}
      {posture === "unmeasured" ? (
        <>
          <rect x="1" y="1" width="8" height="8" fill="none" stroke="var(--color-void)" strokeWidth="1.2" />
          <path d="M1 5 5 1M1 9 9 1M5 9 9 5" stroke="var(--color-void)" strokeWidth="1.2" />
        </>
      ) : null}
    </svg>
  );
}

/**
 * The posture of a domain: mark and word. `data-testid="posture-badge"` and the
 * bare label text are what the clickthrough suite reads; keep both.
 */
export function PostureBadge({
  posture,
  reason,
  size = "md",
}: {
  posture: Posture;
  reason?: string;
  size?: "md" | "lg";
}) {
  const meta = POSTURE_META[posture];
  return (
    <span
      data-testid="posture-badge"
      title={reason ?? meta.meaning}
      className={clsx(
        "inline-flex items-center whitespace-nowrap font-semibold",
        TONE_TEXT[POSTURE_TONE[posture]],
        size === "lg" ? "gap-2 text-body" : "gap-1.5 text-ui",
      )}
    >
      <PostureMark posture={posture} size={size === "lg" ? 11 : 9} />
      {meta.label}
    </span>
  );
}

/** A counter in a nav item or tab. Accent: it is an unread / active count. */
export function CountPill({ n, label }: { n: number; label: string }) {
  return (
    <span
      aria-label={label}
      className="tnum inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-act px-1 text-[10.5px] font-bold text-act-ink"
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}
