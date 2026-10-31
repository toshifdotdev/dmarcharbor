/**
 * station-strip.tsx — a short sequence drawn as stations on one line: the
 * steering file's strip map, at the size of a side panel.
 *
 *   built      ink: the steps already taken
 *   planned    dashed ink: the next step, ready but not taken (the transit
 *              convention for a line under construction)
 *   unbuilt    rule grey: steps ahead that the evidence does not support yet
 *   unobserved the whole line dotted and every station closed: nothing was
 *              observed, which is never drawn as being at the first station
 *
 * The station you are at is drawn larger and named in bold. Coordinates are
 * percentages of the strip's width, so the drawing keeps its proportions at
 * any width without scaling its strokes. No hooks: the domain page renders it
 * on the server, and the switch panel inside its client component.
 */

import { clsx } from "clsx";
import type { ReactNode } from "react";

export type StationState = "passed" | "here" | "ahead";
export type SegmentState = "built" | "planned" | "unbuilt";

const Y = 12;

export function StationStrip({
  label,
  stations,
  segments,
  unobserved,
  className,
}: {
  /** Accessible name of the list, e.g. "DMARC policy ladder". */
  label: string;
  stations: Array<{ key: string; name: ReactNode; note?: ReactNode; state: StationState }>;
  /** One per gap between stations. */
  segments: SegmentState[];
  unobserved?: boolean;
  className?: string;
}) {
  const n = stations.length;
  const cx = (i: number) => `${((i + 0.5) / n) * 100}%`;
  return (
    <div className={clsx("relative", className)}>
      <svg aria-hidden width="100%" height={Y * 2} className="block overflow-visible">
        {unobserved ? (
          <line x1={cx(0)} x2={cx(n - 1)} y1={Y} y2={Y} stroke="var(--color-rule-2)" strokeWidth={3} strokeLinecap="round" strokeDasharray="0.01 7" />
        ) : (
          segments.map((segment, i) => (
            <line
              key={i}
              x1={cx(i)}
              x2={cx(i + 1)}
              y1={Y}
              y2={Y}
              stroke={segment === "unbuilt" ? "var(--color-rule)" : "var(--color-fg)"}
              strokeWidth={5}
              strokeLinecap={segment === "planned" ? "butt" : "round"}
              strokeDasharray={segment === "planned" ? "7 5" : undefined}
            />
          ))
        )}
        {stations.map((station, i) => {
          const here = station.state === "here" && !unobserved;
          const reached = !unobserved && station.state !== "ahead";
          return (
            <circle
              key={station.key}
              cx={cx(i)}
              cy={Y}
              r={here ? 7.5 : 5}
              fill="var(--color-paper)"
              stroke={reached ? "var(--color-fg)" : "var(--color-rule-2)"}
              strokeWidth={3}
            />
          );
        })}
      </svg>
      <ol aria-label={label} className="mt-1.5 grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
        {stations.map((station) => {
          const here = station.state === "here" && !unobserved;
          return (
            <li key={station.key} aria-current={here ? "step" : undefined} className="min-w-0 px-1 text-center">
              <span className={clsx("block text-ui", here ? "font-bold text-fg" : station.state === "ahead" || unobserved ? "font-medium text-fg-3" : "font-semibold text-fg-2")}>
                {station.name}
              </span>
              {station.note ? <span className="mt-0.5 block text-meta text-fg-3">{station.note}</span> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export type StopState = "done" | "pending" | "blocked" | "optional";

const STOP_WORD: Record<StopState, { label: string; className: string }> = {
  done: { label: "done", className: "text-ok" },
  pending: { label: "pending", className: "text-fg-3" },
  blocked: { label: "blocked", className: "text-fail" },
  optional: { label: "optional", className: "text-fg-3" },
};

/**
 * Steps as stations down a vertical line: the line is built (ink) below each
 * step that is done, unbuilt (grey) below the rest. A blocked step's station
 * is red, an optional one dashed. The state also travels as a word.
 */
export function StationList({
  label,
  stops,
  className,
}: {
  label: string;
  stops: Array<{ key: string; title: ReactNode; detail?: ReactNode; state: StopState }>;
  className?: string;
}) {
  return (
    <ol aria-label={label} className={clsx("flex flex-col", className)}>
      {stops.map((stop, i) => {
        const last = i === stops.length - 1;
        return (
          <li key={stop.key} className="relative pb-3.5 pl-8 last:pb-0">
            {!last ? (
              <span
                aria-hidden
                className={clsx("absolute bottom-0 left-[8px] top-[12px] w-[3px]", stop.state === "done" ? "bg-fg" : "bg-rule")}
              />
            ) : null}
            <span
              aria-hidden
              className={clsx(
                "absolute left-[2px] top-[2px] size-[15px] rounded-full border-[3px] bg-paper",
                stop.state === "done" && "border-fg",
                stop.state === "pending" && "border-rule-2",
                stop.state === "blocked" && "border-fail",
                stop.state === "optional" && "border-dashed border-rule-2",
              )}
            />
            <p className="flex flex-wrap items-baseline gap-x-2 text-ui">
              <span className="font-semibold text-fg">{stop.title}</span>
              <span className={clsx("text-meta font-semibold", STOP_WORD[stop.state].className)}>{STOP_WORD[stop.state].label}</span>
            </p>
            {stop.detail ? <p className="mt-0.5 text-meta text-fg-3">{stop.detail}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
