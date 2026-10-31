/**
 * lines.tsx — the transit-map pieces the integration and record screens share
 * (area 6b: Slack, Teams, webhooks, PSA, DNS publishing, the report mailbox,
 * API keys, the audit trail, forensic samples, export, erasure).
 *
 *   ConnectionLine  one integration drawn as a line from where events start to
 *                   where they arrive, with the state said in a word above it.
 *                     live      solid ink to an open terminus
 *                     paused    a planned segment (dashed ink): ready, not used
 *                     failing   solid ink up to a short red bar: refused there
 *                     none      a planned segment to a closed (grey) terminus
 *                     unknown   a dotted grey line, every station closed
 *   SetupSteps      setup instructions as stations down one line, ending in a
 *                   terminus where the value is pasted. Dashed while the steps
 *                   are still to take, solid once the thing is connected.
 *   StopLine        a short lifecycle as stations on one horizontal line (an
 *                   export link, an erasure's grace period).
 *
 * Colour stays in the meaning: ink for the line, red only where something is
 * refused, grey for what is absent. Every state also travels as a word. No
 * hooks and no motion: the server HTML is the final picture.
 */

import { clsx } from "clsx";
import type { ReactNode } from "react";
import { PostureMark } from "@/components/ui/badge";
import type { Posture } from "@/lib/posture";

export type LineState = "live" | "paused" | "failing" | "none" | "unknown";

const STATE_POSTURE: Record<LineState, Posture> = {
  live: "pass",
  failing: "block",
  paused: "stale",
  none: "unmeasured",
  unknown: "unmeasured",
};

const STATE_TEXT: Record<LineState, string> = {
  live: "text-ok",
  failing: "text-fail",
  paused: "text-fg-3",
  none: "text-fg-3",
  unknown: "text-fg-3",
};

/** A state word with its shape, sized for a status line. */
export function LineStateWord({ state, children, size = "md" }: { state: LineState; children: ReactNode; size?: "md" | "lg" }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center whitespace-nowrap font-semibold",
        STATE_TEXT[state],
        size === "lg" ? "gap-2 text-body" : "gap-1.5 text-ui",
      )}
    >
      <PostureMark posture={STATE_POSTURE[state]} size={size === "lg" ? 11 : 9} />
      {children}
    </span>
  );
}

export interface LineStop {
  name: ReactNode;
  kind?: ReactNode;
  /** Identifiers (a channel, a host) are set in the data face. */
  mono?: boolean;
  /** A middle station that is absent (grey), whatever the line's state. */
  closed?: boolean;
}

function StopLabel({ stop, align }: { stop: LineStop; align: "left" | "center" | "right" }) {
  return (
    <p
      className={clsx(
        "min-w-0 text-ui leading-snug",
        align === "right" && "text-right",
        align === "center" && "text-center",
      )}
    >
      <span className={clsx("block break-words font-bold text-fg", stop.mono && "data font-semibold")}>{stop.name}</span>
      {stop.kind ? <span className="block text-meta text-fg-3">{stop.kind}</span> : null}
    </p>
  );
}

/**
 * One integration as a line. `word` names the state ("Delivering", "Paused");
 * `detail` says the evidence for it ("last delivered 2 hours ago"); `aside`
 * holds the one control that belongs beside the state (an on/off switch).
 */
export function ConnectionLine({
  state,
  word,
  detail,
  aside,
  from,
  via,
  to,
  label,
  testId,
}: {
  state: LineState;
  word: ReactNode;
  detail?: ReactNode;
  aside?: ReactNode;
  from: LineStop;
  via?: LineStop;
  to: LineStop;
  /** Accessible summary of the drawing, read in place of the lines. */
  label: string;
  testId?: string;
}) {
  const closedEnd = state === "none" || state === "unknown" || state === "failing";
  const closedVia = state === "unknown" || Boolean(via?.closed);
  return (
    <div data-testid={testId} data-line-state={state} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <LineStateWord state={state} size="lg">
            {word}
          </LineStateWord>
          {detail ? <span className="text-ui text-fg-2">{detail}</span> : null}
        </p>
        {aside ? <div className="flex items-center gap-2">{aside}</div> : null}
      </div>
      <div role="img" aria-label={label} className="relative h-[22px]">
        <svg
          aria-hidden
          height="22"
          className="absolute top-0 block overflow-visible"
          style={{ left: 9, width: "calc(100% - 24px)" }}
        >
          {state === "live" ? <line x1="0" x2="100%" y1="11" y2="11" stroke="var(--color-fg)" strokeWidth="5" strokeLinecap="round" /> : null}
          {state === "paused" || state === "none" ? (
            <line x1="0" x2="100%" y1="11" y2="11" stroke="var(--color-fg)" strokeWidth="5" strokeDasharray="9 7" />
          ) : null}
          {state === "failing" ? (
            <>
              <line x1="0" x2="74%" y1="11" y2="11" stroke="var(--color-fg)" strokeWidth="5" strokeLinecap="round" />
              <line x1="82%" x2="100%" y1="11" y2="11" stroke="var(--color-rule)" strokeWidth="5" strokeLinecap="round" />
            </>
          ) : null}
          {state === "unknown" ? (
            <line x1="0" x2="100%" y1="11" y2="11" stroke="var(--color-rule-2)" strokeWidth="3" strokeLinecap="round" strokeDasharray="0.01 8" />
          ) : null}
        </svg>
        {state === "failing" ? (
          // The refusal: a short red bar across the line, where the far end said no.
          <span aria-hidden className="absolute top-[1px] h-5 w-[5px] -translate-x-1/2 rounded-full bg-fail" style={{ left: "calc(9px + (100% - 24px) * 0.78)" }} />
        ) : null}
        <span
          aria-hidden
          className={clsx(
            "absolute left-0 top-[2px] size-[18px] rounded-full border-[3px] bg-paper",
            state === "unknown" ? "border-rule-2" : "border-fg",
          )}
        />
        {via ? (
          <span
            aria-hidden
            className={clsx(
              "absolute left-1/2 top-[3px] h-4 w-[26px] -translate-x-1/2 rounded-full border-[3px] bg-paper",
              closedVia ? "border-rule-2" : "border-fg",
            )}
          />
        ) : null}
        <span
          aria-hidden
          className={clsx(
            "absolute right-0 top-[1px] h-5 w-[34px] rounded-full border-[3px] bg-paper",
            closedEnd ? "border-rule-2" : "border-fg",
          )}
        />
      </div>
      <div className={clsx("grid gap-x-4", via ? "grid-cols-3" : "grid-cols-2")}>
        <StopLabel stop={from} align="left" />
        {via ? <StopLabel stop={via} align="center" /> : null}
        <StopLabel stop={to} align="right" />
      </div>
    </div>
  );
}

/**
 * Setup instructions as stations down one line. The last stop is the terminus:
 * the field on this page the value goes into.
 */
export function SetupSteps({
  title,
  steps,
  done = false,
  className,
}: {
  title: ReactNode;
  steps: Array<{ key: string; name: ReactNode; detail?: ReactNode }>;
  /** The integration is already connected: the line is built. */
  done?: boolean;
  className?: string;
}) {
  return (
    <div className={clsx("flex flex-col gap-3", className)}>
      <p className="text-ui font-bold text-fg">{title}</p>
      <ol className="flex flex-col">
        {steps.map((step, i) => {
          const terminus = i === steps.length - 1;
          return (
            <li key={step.key} className="relative grid grid-cols-[30px_minmax(0,1fr)] pb-4 last:pb-0">
              {!terminus ? (
                <span
                  aria-hidden
                  className={clsx("absolute bottom-[-2px] left-[9.5px] top-[15px] border-l-[3px] border-fg", done ? "border-solid" : "border-dashed")}
                />
              ) : null}
              <span aria-hidden className="relative flex h-[18px] items-center">
                <span
                  className={clsx(
                    "block border-[3px] border-fg bg-paper",
                    terminus ? "h-[14px] w-[24px] rounded-full" : "ml-[4px] size-[14px] rounded-full",
                  )}
                />
              </span>
              <span className="min-w-0">
                <span className="block text-ui font-semibold leading-[18px] text-fg">{step.name}</span>
                {step.detail ? <span className="mt-0.5 block text-meta text-fg-2">{step.detail}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * A short lifecycle on one horizontal line. Each gap is `built` (ink),
 * `planned` (dashed ink: it will happen unless stopped) or `unbuilt` (grey).
 * A stop can be the terminus (a capsule) or `closed` (grey, not reached).
 */
export function StopLine({
  label,
  stops,
  segments,
  className,
}: {
  label: string;
  stops: Array<{ key: string; name: ReactNode; note?: ReactNode; terminus?: boolean; closed?: boolean }>;
  segments: Array<"built" | "planned" | "unbuilt">;
  className?: string;
}) {
  const n = stops.length;
  const cx = (i: number) => `${(((i + 0.5) / n) * 100).toFixed(2)}%`;
  return (
    <div className={clsx("relative", className)}>
      <div aria-hidden className="relative h-5">
        <svg height="20" width="100%" className="absolute inset-0 block overflow-visible">
          {segments.map((s, i) => (
            <line
              key={i}
              x1={cx(i)}
              x2={cx(i + 1)}
              y1="10"
              y2="10"
              stroke={s === "unbuilt" ? "var(--color-rule)" : "var(--color-fg)"}
              strokeWidth="5"
              strokeLinecap={s === "planned" ? "butt" : "round"}
              strokeDasharray={s === "planned" ? "8 6" : undefined}
            />
          ))}
        </svg>
        {stops.map((s, i) => (
          <span
            key={s.key}
            className={clsx(
              "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] bg-paper",
              s.terminus ? "h-4 w-[28px]" : "size-[14px]",
              s.closed ? "border-rule-2" : "border-fg",
            )}
            style={{ left: cx(i) }}
          />
        ))}
      </div>
      <ol aria-label={label} className="mt-2 grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
        {stops.map((s) => (
          <li key={s.key} className="min-w-0 px-1.5 text-center">
            <span className={clsx("block text-ui font-bold", s.closed ? "text-fg-3" : "text-fg")}>{s.name}</span>
            {s.note ? <span className="mt-0.5 block text-meta text-fg-3">{s.note}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
