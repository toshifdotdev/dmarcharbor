"use client";

/**
 * parts.tsx — the pieces every settings section is built from.
 *
 *   Panel          one decision on the page: a heading, a line on why it
 *                  matters, the controls. Sections are a stack of these, not a
 *                  form. The heading sits over a hairline, like a figure head.
 *   DangerZone     where an action cannot be taken back. An ink rule, the
 *                  permanent mark and a plain statement of what is lost, set
 *                  apart so it is never next to a harmless button. The red is
 *                  kept for the button behind the confirmation; the words carry
 *                  the weight.
 *   OnceSecret     a value the API returns once (an API key, a signing secret,
 *                  a TXT token). An ink frame that says it will not be shown
 *                  again, and leaves only when dismissed.
 *
 * And the map's marks at working density, so every settings screen says state
 * the same way:
 *
 *   StateMark      the shape that travels with a state word: filled square
 *                  done or on, diamond blocking, ring waiting or unverified,
 *                  half-filled square stale, hatch not measured, an open
 *                  station (white, ink ring) and a closed one (hollow, grey).
 *   StateWord      a state word with its shape. Never colour alone.
 *   PermanentMark  the hollow diamond that marks a section or zone holding an
 *                  action that cannot be undone. Ink, not red: it is for
 *                  finding, not warning.
 *   StepLine       a short line of stations for something set up in steps
 *                  (a custom domain, two-step verification): travelled in ink,
 *                  the current stop a capsule, the rest a dashed planned
 *                  segment, the transit convention for a line not yet built.
 *   RouteColumn    a vertical route with labelled stops, for the figures that
 *                  explain who gets in or what a client sees.
 *   FigureHead     a figure's head: a bold name, a lighter kind, a hairline.
 *
 * No clock and no randomness: every value arrives as a prop, so the server HTML
 * is the final picture.
 */

import type { CSSProperties, ReactNode } from "react";
import { clsx } from "clsx";
import { Button } from "@/components/ui/button";
import { CopyValue } from "@/components/ui/copy";

export function Panel({
  title,
  why,
  aside,
  id,
  children,
  className,
  testId,
}: {
  title: ReactNode;
  /** Why this decision matters, in a sentence. */
  why?: ReactNode;
  aside?: ReactNode;
  id?: string;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section aria-labelledby={id} data-testid={testId} className={clsx("flex min-w-0 flex-col gap-4", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1.5 border-b border-rule pb-2.5">
        <div className="min-w-0 flex-1 basis-[22rem]">
          <h2 id={id} className="display text-h2 text-fg">
            {title}
          </h2>
          {why ? <p className="mt-1 max-w-[70ch] text-ui text-fg-2">{why}</p> : null}
        </div>
        {aside ? <div className="flex flex-wrap items-center gap-2 text-meta text-fg-3">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function DangerZone({
  title,
  consequence,
  children,
  testId,
}: {
  title: ReactNode;
  /** What is lost, said plainly. Shown before the control, always. */
  consequence: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className="mt-6 flex flex-col gap-4 border-t-2 border-fg pt-4">
      <div>
        <p className="flex items-center gap-2 text-meta font-semibold text-fg">
          <PermanentMark />
          Cannot be undone
        </p>
        <h2 className="display mt-1.5 text-h2 text-fg">{title}</h2>
        <div className="mt-1.5 max-w-[70ch] text-ui text-fg-2">{consequence}</div>
      </div>
      {children}
    </section>
  );
}

export function OnceSecret({
  title,
  value,
  label,
  children,
  onDismiss,
  dismissLabel = "I have stored it",
  testId,
  dismissTestId,
}: {
  title: ReactNode;
  value: string;
  /** Names the value for the copy button: "API key". */
  label: string;
  children?: ReactNode;
  onDismiss: () => void;
  dismissLabel?: string;
  testId?: string;
  dismissTestId?: string;
}) {
  return (
    <div role="status" data-testid={testId} className="flex flex-col gap-3 rounded-sheet border-2 border-fg bg-paper px-5 py-4">
      <div>
        <p className="flex items-center gap-2 text-meta font-semibold text-fg">
          <StateMark shape="open" tone="ink" />
          Shown once
        </p>
        <p className="mt-1 text-body font-semibold text-fg">{title}</p>
      </div>
      <CopyValue value={value} label={label} />
      {children ? <div className="text-ui text-fg-2">{children}</div> : null}
      <div>
        <Button variant="primary" size="sm" onClick={onDismiss} data-testid={dismissTestId}>
          {dismissLabel}
        </Button>
      </div>
    </div>
  );
}

/** A count with its noun, pluralised: "3 domains", "1 domain". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}

/* ── Marks ─────────────────────────────────────────────────────────────── */

export type MarkShape = "square" | "diamond" | "ring" | "half" | "hatch" | "open" | "closed";
export type MarkTone = "ok" | "warn" | "fail" | "ink" | "void";

const MARK: Record<MarkTone, string> = {
  ok: "var(--color-ok)",
  warn: "var(--color-warn-mark)",
  fail: "var(--color-fail)",
  ink: "var(--color-fg)",
  void: "var(--color-void)",
};

const WORD: Record<MarkTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  fail: "text-fail",
  ink: "text-fg",
  void: "text-fg-3",
};

/** The shape that travels with a state word, sized to 12.5 to 14.5px text. */
export function StateMark({ shape, tone = "ink", size = 10 }: { shape: MarkShape; tone?: MarkTone; size?: number }) {
  const c = MARK[tone];
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden className="shrink-0 self-center">
      {shape === "square" ? <rect x="0.5" y="0.5" width="9" height="9" fill={c} /> : null}
      {shape === "diamond" ? <path d="M5 0 10 5 5 10 0 5Z" fill={c} /> : null}
      {shape === "ring" ? <circle cx="5" cy="5" r="3.9" fill="none" stroke={c} strokeWidth="2" /> : null}
      {shape === "half" ? (
        <>
          <rect x="1" y="1" width="8" height="8" fill="none" stroke={c} strokeWidth="1.5" />
          <rect x="1" y="5" width="8" height="4" fill={c} />
        </>
      ) : null}
      {shape === "hatch" ? (
        <>
          <rect x="1" y="1" width="8" height="8" fill="none" stroke={c} strokeWidth="1.2" />
          <path d="M1 5 5 1M1 9 9 1M5 9 9 5" stroke={c} strokeWidth="1.2" />
        </>
      ) : null}
      {shape === "open" ? <circle cx="5" cy="5" r="3.6" fill="var(--color-paper)" stroke={c} strokeWidth="2.4" /> : null}
      {shape === "closed" ? (
        <circle cx="5" cy="5" r="3.7" fill="var(--color-paper)" stroke="var(--color-rule-2)" strokeWidth="2" />
      ) : null}
    </svg>
  );
}

/** A state word with its shape: "On", "Verified", "Not signed in yet". */
export function StateWord({
  shape,
  tone,
  children,
  className,
  title,
  size = "ui",
}: {
  shape: MarkShape;
  tone: MarkTone;
  children: ReactNode;
  className?: string;
  title?: string;
  size?: "meta" | "ui";
}) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1.5 whitespace-nowrap font-semibold",
        size === "meta" ? "text-meta" : "text-ui",
        WORD[tone],
        className,
      )}
    >
      <StateMark shape={shape} tone={tone} size={size === "meta" ? 9 : 10} />
      {children}
    </span>
  );
}

/** Holds an action that cannot be undone. A hollow ink diamond. */
export function PermanentMark({ size = 9, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={clsx("shrink-0", className)}
    >
      {label ? <title>{label}</title> : null}
      <path d="M5 0.9 9.1 5 5 9.1 0.9 5Z" fill="var(--color-paper)" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/* ── Lines ─────────────────────────────────────────────────────────────── */

const PLANNED: CSSProperties = {
  backgroundImage: "repeating-linear-gradient(to right, var(--color-fg) 0 6px, transparent 6px 11px)",
};
const PLANNED_DOWN: CSSProperties = {
  backgroundImage: "repeating-linear-gradient(to bottom, var(--color-fg) 0 6px, transparent 6px 11px)",
};
const CLOSED_DOWN: CSSProperties = {
  backgroundImage: "repeating-linear-gradient(to bottom, var(--color-rule-2) 0 2px, transparent 2px 6px)",
};
const FORGED_ACROSS: CSSProperties = {
  backgroundImage: "repeating-linear-gradient(to right, var(--color-fail) 0 6px, transparent 6px 11px)",
};

export type StepState = "done" | "current" | "planned";

/**
 * Stations for something set up in steps. The segment into a station is
 * travelled (ink) once that station is reached; beyond the current stop the
 * line is planned (dashed).
 */
export function StepLine({
  steps,
  label,
  className,
}: {
  steps: Array<{ key: string; title: ReactNode; body?: ReactNode; state: StepState }>;
  /** Names the line for screen readers: "Custom domain setup". */
  label: string;
  className?: string;
}) {
  const word: Record<StepState, string> = { done: "done", current: "current step", planned: "still to do" };
  return (
    <ol
      aria-label={label}
      className={clsx("grid w-full max-w-[760px]", className)}
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
    >
      {steps.map((s, i) => {
        const next = steps[i + 1];
        return (
          <li key={s.key} aria-current={s.state === "current" ? "step" : undefined} className="relative min-w-0 pr-3 pt-6">
            {next ? (
              <span
                aria-hidden
                className={clsx("absolute left-[7px] top-[5px] h-[5px] w-full", next.state === "planned" ? "" : "bg-fg")}
                style={next.state === "planned" ? PLANNED : undefined}
              />
            ) : null}
            <span
              aria-hidden
              className={clsx(
                "absolute left-0 z-[1] block rounded-full",
                s.state === "done" && "top-0 size-[15px] border-[3px] border-fg bg-fg",
                s.state === "current" && "-top-[4.5px] h-[24px] w-[15px] border-[3px] border-fg bg-paper",
                s.state === "planned" && "top-0 size-[15px] border-[2.5px] border-fg-4 bg-paper",
              )}
            />
            <p className={clsx("text-ui leading-[1.3]", s.state === "planned" ? "font-medium text-fg-3" : "font-semibold text-fg")}>
              {s.title}
              <span className="sr-only">, {word[s.state]}</span>
            </p>
            {s.body ? <p className="mt-0.5 text-meta text-fg-3">{s.body}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

export interface RouteStop {
  key: string;
  name: ReactNode;
  kind?: ReactNode;
  /** origin: where the route starts; station: a stop; terminus: where it ends. */
  shape: "origin" | "station" | "terminus";
  /** The segment arriving at this stop: travelled (default), planned, or closed. */
  arrive?: "travelled" | "planned" | "closed";
  /** Absent, or never reached: a hollow grey stop. */
  closed?: boolean;
  /** A branch turned away at this stop: a dashed red stub ending at a red bar. */
  refused?: { name: ReactNode; kind?: ReactNode };
}

/**
 * A vertical route, read top to bottom. Each stop's segment arrives from the
 * stop above, so the first stop carries none.
 */
export function RouteColumn({ stops, label, className }: { stops: RouteStop[]; label?: string; className?: string }) {
  return (
    <ol aria-label={label} className={clsx("flex flex-col", className)}>
      {stops.map((s, i) => {
        const next = stops[i + 1];
        const into = next?.arrive ?? "travelled";
        const lineStyle: CSSProperties | undefined = next
          ? into === "closed"
            ? CLOSED_DOWN
            : into === "planned"
              ? PLANNED_DOWN
              : undefined
          : undefined;
        const big = s.shape === "terminus";
        return (
          <li key={s.key} className={clsx("relative pl-9", next && "pb-4")}>
            {next ? (
              <span
                aria-hidden
                className={clsx("absolute bottom-0 left-[8px] top-[14px] w-[5px]", into === "travelled" && "bg-fg")}
                style={lineStyle}
              />
            ) : null}
            <span
              aria-hidden
              className={clsx(
                "absolute top-[1px] z-[1] block h-[21px] rounded-full bg-paper",
                big ? "-left-[4px] w-[29px]" : "left-0 w-[21px]",
                s.closed ? "border-[2.5px] border-rule-2" : "border-[3px] border-fg",
              )}
            />
            <p className="min-h-[22px] pt-[2px] text-ui leading-[1.35]">
              <span className={clsx("font-semibold", s.closed ? "text-fg-3" : "text-fg")}>{s.name}</span>
              {s.kind ? <span className={s.closed ? "text-fg-4" : "text-fg-3"}> {s.kind}</span> : null}
            </p>
            {s.refused ? (
              <div className="relative mt-2 flex items-center gap-2.5">
                <span aria-hidden className="-ml-[26px] h-[5px] w-[42px] shrink-0" style={FORGED_ACROSS} />
                <span aria-hidden className="h-[18px] w-[5px] shrink-0 rounded-full bg-fail" />
                <p className="min-w-0 text-ui leading-[1.35]">
                  <span className="font-semibold text-fail">{s.refused.name}</span>
                  {s.refused.kind ? <span className="text-fg-3"> {s.refused.kind}</span> : null}
                </p>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** A figure's head, as on the home page's map: bold name, lighter kind, hairline. */
export function FigureHead({ name, kind, aside }: { name: ReactNode; kind?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule pb-2">
      <p className="text-ui">
        <span className="font-bold text-fg">{name}</span>
        {kind ? <span className="text-fg-3"> {kind}</span> : null}
      </p>
      {aside ? <div className="text-meta text-fg-3">{aside}</div> : null}
    </div>
  );
}
