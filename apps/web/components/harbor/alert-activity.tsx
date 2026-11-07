/**
 * alert-activity.tsx — the last 30 days of alerts as one strip.
 *
 * A column per calendar day ending today, as tall as the number of events
 * that fired that day. The part already handled (acknowledged or resolved) is
 * green, the part still waiting on a person is amber. A day nothing fired is
 * a short grey tick on the baseline: quiet, not missing.
 *
 * It is drawn from the events the page loaded, so when the list is cut short
 * the caption says so instead of claiming the whole month. No hooks and no
 * clock: `today` comes from the server page. The figures are also in words.
 */

import type { CSSProperties } from "react";
import { DrawOnView } from "./draw-on-view";

export type ActivityEvent = { triggeredAt: string; handled: boolean };

const DAYS = 30;
const W = 600;
const H = 56;
const SLOT = W / DAYS;
const BAR = 11;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const r2 = (n: number) => Math.round(n * 100) / 100;

function addDays(key: string, n: number): string {
  const t = Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function dayLabel(key: string): string {
  return `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`;
}

export function AlertActivity({ events, today, truncated }: { events: ActivityEvent[]; today: string; truncated: boolean }) {
  const first = addDays(today, -(DAYS - 1));
  const days = Array.from({ length: DAYS }, (_, i) => ({ date: addDays(today, i - (DAYS - 1)), handled: 0, open: 0 }));
  const index = new Map(days.map((d, i) => [d.date, i]));
  for (const e of events) {
    const i = index.get(e.triggeredAt.slice(0, 10));
    if (i === undefined) continue;
    const day = days[i]!;
    if (e.handled) day.handled += 1;
    else day.open += 1;
  }
  const handled = days.reduce((s, d) => s + d.handled, 0);
  const open = days.reduce((s, d) => s + d.open, 0);
  const fired = handled + open;
  const busy = days.filter((d) => d.handled + d.open > 0).length;
  const top = Math.max(1, ...days.map((d) => d.handled + d.open));

  const summary =
    fired === 0
      ? `Nothing fired in the last ${DAYS} days.`
      : `${fired} event${fired === 1 ? "" : "s"} fired on ${busy} of the last ${DAYS} days: ${handled} handled, ${open} still open.`;

  return (
    <figure className="flex max-w-[52rem] flex-col gap-2 pb-4" data-testid="alert-activity" data-draw>
      <DrawOnView />
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        className="block overflow-visible"
      >
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--color-rule)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {days.map((d, i) => {
          const x = r2(i * SLOT + (SLOT - BAR) / 2);
          const total = d.handled + d.open;
          const label = dayLabel(d.date);
          if (total === 0) {
            return (
              <g key={d.date}>
                <title>{`${label}: nothing fired`}</title>
                <rect x={r2(i * SLOT)} y={0} width={r2(SLOT)} height={H} fill="transparent" />
                <rect x={x} y={H - 2} width={BAR} height={2} fill="var(--color-rule-2)" />
              </g>
            );
          }
          const h = r2(Math.max(4, (total / top) * (H - 4)));
          const openH = d.open > 0 ? r2(Math.max(3, (d.open / total) * h)) : 0;
          return (
            <g key={d.date} className="hb-grow-y" style={{ "--i": i } as CSSProperties}>
              <title>{`${label}: ${total} fired, ${d.handled} handled, ${d.open} still open`}</title>
              <rect x={r2(i * SLOT)} y={0} width={r2(SLOT)} height={H} fill="transparent" />
              {/* Handled at the base, still-open stacked on top: the open part is what needs a person. */}
              <rect x={x} y={r2(H - h)} width={BAR} height={r2(h - openH)} fill="var(--color-done)" />
              {openH > 0 ? <rect x={x} y={r2(H - h)} width={BAR} height={openH} fill="var(--color-warn-mark)" /> : null}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-meta text-fg-3">
        <span className="tnum">
          {dayLabel(first)} to {dayLabel(today)}
        </span>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px] bg-done" />
            Handled
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px] bg-warn-mark" />
            Still open
          </span>
        </span>
      </div>
      <figcaption className="text-ui text-fg-2">
        {summary}
        {truncated ? <span className="text-fg-3"> Drawn from the latest events loaded; older ones are not counted.</span> : null}
      </figcaption>
    </figure>
  );
}
