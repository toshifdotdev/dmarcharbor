/**
 * ops-parts.tsx — the pieces the operations screens share: alerts, digests,
 * notifications, prospects and monthly client reports.
 *
 *   OpsSection      one part of an operations screen: a heading, a short
 *                   count or meta beside it, actions at the right edge.
 *   StateMark       the small shapes that travel with a state word, so no
 *                   state is said in colour alone (diamond needs a person,
 *                   ring is in someone's hands, square is done, hatch is
 *                   nothing to show).
 *   EscalationLine  an alert's reminder ladder as a strip map: the first
 *                   notice and each reminder are stations, the workspace
 *                   owner is the terminus. Travelled in ink, still to come
 *                   dashed (a step that is ready but not taken), and closed
 *                   in grey once someone has acknowledged it.
 *   RouteList       a vertical route with stations beside their labels: how
 *                   a rule or a schedule will run, read top to bottom.
 *
 * No hooks and no clock: every value arrives as a prop, so the server HTML is
 * the final picture and hydration never disagrees.
 */

import { clsx } from "clsx";
import type { CSSProperties, ReactNode } from "react";

export function OpsSection({
  id,
  title,
  meta,
  why,
  actions,
  children,
  className,
  testId,
}: {
  id: string;
  title: ReactNode;
  /** A count or a short fact beside the heading. */
  meta?: ReactNode;
  /** One sentence under the heading, when the heading alone is not enough. */
  why?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section aria-labelledby={id} data-testid={testId} className={clsx("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id={id} className="display text-h2 text-fg">
              {title}
            </h2>
            {meta ? <span className="text-meta text-fg-3">{meta}</span> : null}
          </div>
          {why ? <p className="mt-1 max-w-[72ch] text-ui text-fg-2">{why}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export type MarkShape = "diamond" | "ring" | "square" | "half" | "hatch" | "dot";

const MARK_COLOUR: Record<"fail" | "warn" | "ok" | "ink" | "void", string> = {
  fail: "var(--color-fail)",
  warn: "var(--color-warn-mark)",
  ok: "var(--color-ok)",
  ink: "var(--color-fg)",
  void: "var(--color-void)",
};

/** A state's shape, sized to sit beside 12.5 to 14.5px text. */
export function StateMark({
  shape,
  tone = "ink",
  size = 9,
}: {
  shape: MarkShape;
  tone?: keyof typeof MARK_COLOUR;
  size?: number;
}) {
  const c = MARK_COLOUR[tone];
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden className="shrink-0 self-center">
      {shape === "diamond" ? <path d="M5 0 10 5 5 10 0 5Z" fill={c} /> : null}
      {shape === "ring" ? <circle cx="5" cy="5" r="3.9" fill="none" stroke={c} strokeWidth="2" /> : null}
      {shape === "square" ? <rect x="0.5" y="0.5" width="9" height="9" fill={c} /> : null}
      {shape === "dot" ? <circle cx="5" cy="5" r="4" fill={c} /> : null}
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
    </svg>
  );
}

/** A state word with its shape. */
export function StateWord({
  shape,
  tone,
  children,
  className,
  title,
}: {
  shape: MarkShape;
  tone: "fail" | "warn" | "ok" | "ink" | "void";
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const text = { fail: "text-fail", warn: "text-warn", ok: "text-ok", ink: "text-fg", void: "text-fg-3" }[tone];
  return (
    <span title={title} className={clsx("inline-flex items-center gap-1.5 whitespace-nowrap text-ui font-semibold", text, className)}>
      <StateMark shape={shape} tone={tone} />
      {children}
    </span>
  );
}

/**
 * The reminder ladder. Level 1 is the first notice (sent when the event
 * fires), each reminder adds one, up to the rule's maximum; then the open
 * event only rolls up to the workspace owner, the terminus.
 */
export function EscalationLine({
  level,
  max,
  state,
}: {
  level: number;
  max: number;
  state: "open" | "acknowledged" | "resolved";
}) {
  const n = Math.max(1, Math.min(5, Math.round(max) || 1));
  const at = Math.max(1, Math.min(n, Math.round(level) || 1));
  const S = 28;
  const X0 = 10;
  const Y = 12;
  const xs = Array.from({ length: n }, (_, i) => X0 + i * S);
  const xT = X0 + n * S;
  const W = xT + 11;
  const open = state === "open";
  const c = at - 1;
  const ink = "var(--color-fg)";
  const closed = "var(--color-rule-2)";

  return (
    <svg width={W} height={24} viewBox={`0 0 ${W} 24`} aria-hidden className="block shrink-0">
      {Array.from({ length: n }, (_, i) => {
        const x1 = xs[i];
        const x2 = i + 1 < n ? xs[i + 1] : xT;
        const travelled = i + 1 <= c;
        return (
          <line
            key={`s${i}`}
            x1={x1}
            y1={Y}
            x2={x2}
            y2={Y}
            stroke={travelled ? ink : open ? ink : "var(--color-rule)"}
            strokeWidth={5}
            strokeLinecap={travelled ? "round" : "butt"}
            strokeDasharray={!travelled && open ? "6 5" : undefined}
          />
        );
      })}
      {xs.map((x, i) =>
        i === c ? (
          <circle key={`p${i}`} cx={x} cy={Y} r={7.5} fill="var(--color-paper)" stroke={ink} strokeWidth={3} />
        ) : (
          <circle
            key={`p${i}`}
            cx={x}
            cy={Y}
            r={5}
            fill="var(--color-paper)"
            stroke={i < c || open ? ink : closed}
            strokeWidth={i < c ? 3 : 2.5}
          />
        ),
      )}
      <rect
        x={xT - 8}
        y={1.5}
        width={16}
        height={21}
        rx={8}
        fill="var(--color-paper)"
        stroke={open ? ink : closed}
        strokeWidth={open ? 3 : 2.5}
      />
    </svg>
  );
}

/**
 * The path from empty to full, as stations on one line (the same picture as
 * EmptyState's steps in ui/states.tsx): the first station is where you are.
 */
export function StepLine({ steps, className }: { steps: Array<{ title: string; body: ReactNode }>; className?: string }) {
  return (
    <ol className={clsx("grid max-w-[860px] gap-y-5 sm:grid-cols-3", className)}>
      {steps.map((s, i) => (
        <li
          key={s.title}
          className={clsx(
            "relative border-t-[3px] pr-6 pt-4",
            i === 0 ? "border-fg" : "border-rule-2",
            "before:absolute before:-top-[8.5px] before:left-0 before:size-[14px] before:rounded-full before:border-[3px] before:bg-paper before:content-['']",
            i === 0 ? "before:border-fg" : "before:border-rule-2",
          )}
        >
          <p className="text-ui font-bold text-fg">{s.title}</p>
          <p className="mt-1 text-meta text-fg-2">{s.body}</p>
        </li>
      ))}
    </ol>
  );
}

export interface RouteStop {
  key: string;
  name: ReactNode;
  kind?: ReactNode;
  /** origin: where the route starts; station: a stop; terminus: where it ends. */
  shape: "origin" | "station" | "terminus";
  /** The segment arriving at this stop is still to come: drawn dashed. */
  planned?: boolean;
  /** Absent or not in effect: a hollow grey stop on a grey line. */
  closed?: boolean;
}

/**
 * A vertical route. Each stop's segment arrives from the stop above, so the
 * first stop carries none; `planned` on a stop dashes the segment into it.
 */
export function RouteList({ stops, className, label }: { stops: RouteStop[]; className?: string; label?: string }) {
  return (
    <ol aria-label={label} className={clsx("flex flex-col", className)}>
      {stops.map((s, i) => {
        const next = stops[i + 1];
        const lineStyle: CSSProperties | undefined = next
          ? next.closed
            ? { background: "var(--color-rule)" }
            : next.planned
              ? { backgroundImage: "repeating-linear-gradient(to bottom, var(--color-fg) 0 6px, transparent 6px 11px)" }
              : { background: "var(--color-fg)" }
          : undefined;
        return (
          <li key={s.key} className={clsx("relative min-h-[26px] pl-8", next && "pb-3.5")}>
            {next ? <span aria-hidden className="absolute bottom-[-12px] left-[7px] top-[12px] w-[5px]" style={lineStyle} /> : null}
            <span
              aria-hidden
              className={clsx(
                "absolute left-0 z-[1] block w-[19px] border-[3px] bg-paper",
                s.shape === "terminus" ? "top-0 h-[26px] rounded-full" : "top-[2.5px] h-[19px] rounded-full",
                s.closed ? "border-rule-2" : "border-fg",
              )}
            />
            <p className="pt-[2px] text-ui leading-[1.35]">
              <span className={clsx("font-semibold", s.closed ? "text-fg-3" : "text-fg")}>{s.name}</span>
              {s.kind ? <span className="text-fg-3"> {s.kind}</span> : null}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
