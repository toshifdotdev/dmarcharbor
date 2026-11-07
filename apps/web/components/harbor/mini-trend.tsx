/**
 * mini-trend.tsx — a domain's last 30 days at the size of a table cell.
 *
 * The domain page's volume chart, shrunk to one row: a column per calendar day
 * ending today, passed mail green and failed mail red at the base. A day with
 * no report received is a short grey tick on the baseline, never an empty
 * slot that reads as zero mail. Each row is scaled to its own busiest day,
 * because the question in a list is "has this domain changed", not "which
 * domain is biggest" (the Messages column answers that).
 *
 * No hooks and no clock: `today` comes from the server page, so the server
 * HTML and the browser agree. The figures are also in the accessible name.
 */

import type { TrendPoint } from "@/lib/types";

const DAYS = 30;
const W = 120;
const H = 22;
const SLOT = W / DAYS;
const BAR = 2.6;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(key: string): string {
  return `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`;
}

function addDays(key: string, n: number): string {
  const t = Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** The calendar days ending `today`, each with its point or none. */
export function calendarSeries(points: TrendPoint[], today: string, days = DAYS): Array<TrendPoint | { date: string; reportsReceived: 0; messagesObserved: 0; failedMessages: 0 }> {
  const byDay = new Map(points.map((p) => [p.date.slice(0, 10), p]));
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(today, i - (days - 1));
    return byDay.get(date) ?? { date, reportsReceived: 0, messagesObserved: 0, failedMessages: 0 };
  });
}

export function MiniTrend({ points, today }: { points: TrendPoint[]; today: string }) {
  const series = calendarSeries(points, today);
  const observed = series.filter((p) => p.reportsReceived > 0);
  const top = Math.max(1, ...observed.map((p) => p.messagesObserved));
  const failedDays = observed.filter((p) => p.failedMessages > 0).length;
  const label =
    observed.length === 0
      ? `No report received in the last ${DAYS} days.`
      : `Last ${DAYS} days: ${observed.length} day${observed.length === 1 ? "" : "s"} with reports, ${failedDays} with failed DMARC mail, ${DAYS - observed.length} not measured.`;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="block overflow-visible">
      <title>{label}</title>
      {series.map((p, i) => {
        const x = Math.round((i * SLOT + (SLOT - BAR) / 2) * 100) / 100;
        const day = dayLabel(p.date);
        if (p.reportsReceived === 0) {
          return (
            <g key={p.date}>
              <title>{`${day}: no report, not measured`}</title>
              {/* A full-height hover target, so the tooltip is easy to reach. */}
              <rect x={i * SLOT} y={0} width={SLOT} height={H} fill="transparent" />
              <rect x={x} y={H - 2} width={BAR} height={2} fill="var(--color-rule-2)" />
            </g>
          );
        }
        const h = Math.max(2, Math.round((p.messagesObserved / top) * (H - 2) * 100) / 100);
        const fail = p.failedMessages > 0 ? Math.max(1.5, Math.round((p.failedMessages / top) * (H - 2) * 100) / 100) : 0;
        return (
          <g key={p.date}>
            <title>{`${day}: ${p.messagesObserved.toLocaleString("en-GB")} messages, ${p.failedMessages.toLocaleString("en-GB")} failed DMARC`}</title>
            <rect x={i * SLOT} y={0} width={SLOT} height={H} fill="transparent" />
            <rect x={x} y={H - h} width={BAR} height={h} fill="var(--color-done)" />
            {fail > 0 ? <rect x={x} y={H - fail} width={BAR} height={fail} fill="var(--color-fail)" /> : null}
          </g>
        );
      })}
    </svg>
  );
}
