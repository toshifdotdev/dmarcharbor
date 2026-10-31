"use client";

/**
 * volume-chart.tsx — daily observed volume for one domain, drawn by hand.
 *
 * The rules (Rule Zero, applied to a chart):
 * - The window is calendar days ending today, so trailing silence shows. A day
 *   with no report received is a hatched column, never a zero bar: absence of
 *   measurement, not measurement of nothing.
 * - Failed DMARC messages sit at the base of each column in the fail colour, so the
 *   failing share of a day reads against its own total, not a separate chart.
 * - Annotations come from the data or not at all: the peak is labelled with
 *   its value, the API's own spikes (more than two standard deviations above
 *   the mean) are marked, the last report is a rule, and the gap since it is
 *   bracketed as "no report · N days" (never "quiet": a missing report says
 *   nothing about whether mail was sent). Past five days it adds "stale", the same threshold and the same day count the posture uses.
 *
 * Drawn at the container's real pixel width (ResizeObserver), so hairlines are
 * one pixel and labels are 11px at every size. The readout row above the plot
 * doubles as the legend and as the hover readout. A table of the same daily
 * figures sits beneath for keyboard and screen-reader use.
 *
 * Dates are handled as UTC day keys (YYYY-MM-DD), matching the API's buckets,
 * and formatted without the runtime locale, so server and browser agree.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { STALE_AFTER_DAYS } from "@/lib/posture";
import type { TrendPoint, TrendSpike } from "@/lib/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const H = 228;
const M = { top: 34, right: 52, bottom: 26, left: 4 };

function dayLabel(key: string) {
  const [, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

function addDays(key: string, n: number) {
  const t = Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function niceCeil(v: number) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

const fmt = (n: number) => n.toLocaleString("en-GB");
const compact = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function VolumeChart({
  points,
  spikes,
  days,
  today,
  lastReportAt,
  daysWithoutReport,
  domainName,
  showFailures = true,
}: {
  points: TrendPoint[];
  spikes: TrendSpike[];
  days: number;
  /** The server's UTC day key for "today". */
  today: string;
  lastReportAt: string | null;
  /** Whole days since the last report was RECEIVED, computed on the server by
   *  lib/posture.daysSinceReport: the same number the posture is decided on. */
  daysWithoutReport: number | null;
  domainName: string;
  /** False when the series carries no per-day failure counts (the public
   *  share payload): columns are then plain volume, never labelled "passed". */
  showFailures?: boolean;
}) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(960);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const series = useMemo(() => {
    const byDay = new Map(points.map((p) => [p.date.slice(0, 10), p]));
    return Array.from({ length: days }, (_, i) => {
      const key = addDays(today, i - (days - 1));
      return byDay.get(key) ?? { date: key, reportsReceived: 0, messagesObserved: 0, failedMessages: 0 };
    }).map((p) => ({ ...p, date: p.date.slice(0, 10) }));
  }, [points, days, today]);

  const observed = series.filter((p) => p.reportsReceived > 0);
  const peakPoint = observed.reduce<(typeof series)[number] | null>((a, p) => (!a || p.messagesObserved > a.messagesObserved ? p : a), null);
  const top = niceCeil(peakPoint?.messagesObserved ?? 0);
  const totals = observed.reduce(
    (a, p) => ({ m: a.m + p.messagesObserved, f: a.f + p.failedMessages, r: a.r + p.reportsReceived }),
    { m: 0, f: 0, r: 0 },
  );

  const innerW = width - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  const slot = innerW / days;
  const barW = Math.max(2, Math.min(18, slot * 0.68));
  const x = (i: number) => M.left + i * slot + (slot - barW) / 2;
  const y = (v: number) => M.top + innerH - (v / top) * innerH;

  const lastKey = lastReportAt ? lastReportAt.slice(0, 10) : null;
  const lastIdx = lastKey ? series.findIndex((p) => p.date === lastKey) : -1;
  const gapDays = daysWithoutReport;
  const spikeSet = new Map(spikes.map((s) => [s.date.slice(0, 10), s]));
  const labelEvery = slot < 14 ? 7 : slot < 28 ? 4 : 2;
  const hovered = hover !== null ? series[hover] : null;

  return (
    <figure className="m-0 flex flex-col gap-2">
      {/* Readout: totals at rest, the hovered day on hover. It is also the legend. */}
      <div className="flex min-h-[20px] flex-wrap items-baseline gap-x-5 gap-y-1 text-meta" aria-hidden>
        {hovered ? (
          <>
            <span className="tnum font-semibold text-fg">{dayLabel(hovered.date)}</span>
            {hovered.reportsReceived === 0 ? (
              <span className="text-void">no report received: not measured</span>
            ) : (
              <>
                {showFailures ? (
                  <>
                    <Key swatch="bg-fg-2" label="passed" value={fmt(hovered.messagesObserved - hovered.failedMessages)} />
                    <Key swatch="bg-fail" label="failed DMARC" value={fmt(hovered.failedMessages)} strong={hovered.failedMessages > 0} />
                  </>
                ) : (
                  <Key swatch="bg-fg-2" label="messages" value={fmt(hovered.messagesObserved)} />
                )}
                <span className="tnum text-fg-3">
                  {hovered.reportsReceived} report{hovered.reportsReceived === 1 ? "" : "s"}
                </span>
              </>
            )}
          </>
        ) : (
          <>
            {showFailures ? (
              <>
                <Key swatch="bg-fg-2" label="passed" value={fmt(totals.m - totals.f)} />
                <Key swatch="bg-fail" label="failed DMARC" value={fmt(totals.f)} strong={totals.f > 0} />
              </>
            ) : (
              <Key swatch="bg-fg-2" label="messages" value={fmt(totals.m)} />
            )}
            <Key swatch="void-hatch border border-rule-2" label="days not measured" value={String(days - observed.length)} />
            <span className="text-fg-3">daily, by day the report was received</span>
          </>
        )}
      </div>

      <div ref={wrap} className="relative w-full" onPointerLeave={() => setHover(null)}>
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          role="img"
          aria-label={`Daily message volume for ${domainName} over the last ${days} days: ${observed.length} days with reports, ${days - observed.length} days with no measurement, ${fmt(totals.m)} messages${showFailures ? ` and ${fmt(totals.f)} failed DMARC` : ""} in total.`}
          className="block select-none"
        >
          <defs>
            <pattern id="void-hatch" width="6" height="6" patternTransform="rotate(-45)" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-void)" strokeWidth="1.2" opacity="0.32" />
            </pattern>
          </defs>

          {/* Grid: zero, half, top. Labels on the right, beside the latest data. */}
          {(peakPoint ? [0, top / 2, top].filter((v) => Number.isInteger(v)) : [0]).map((v) => (
            <g key={v}>
              <line
                x1={M.left}
                x2={width - M.right}
                y1={Math.round(y(v)) + 0.5}
                y2={Math.round(y(v)) + 0.5}
                stroke={v === 0 ? "var(--color-fg)" : "var(--color-rule)"}
              />
              <text x={width - M.right + 8} y={y(v) + 4} fill="var(--color-fg-3)" style={{ fontSize: 11 }} className="tnum">
                {compact(v)}
              </text>
            </g>
          ))}

          {/* Columns. */}
          {series.map((p, i) => {
            if (p.reportsReceived === 0) {
              return <rect key={p.date} x={x(i)} y={M.top} width={barW} height={innerH} fill="url(#void-hatch)" />;
            }
            const failH = (p.failedMessages / top) * innerH;
            return (
              <g key={p.date} opacity={hover === null || hover === i ? 1 : 0.55}>
                <rect x={x(i)} y={y(p.messagesObserved)} width={barW} height={y(0) - y(p.messagesObserved)} fill="var(--color-fg-2)" />
                {p.failedMessages > 0 ? (
                  <rect x={x(i)} y={y(0) - Math.max(1.5, failH)} width={barW} height={Math.max(1.5, failH)} fill="var(--color-fail)" />
                ) : null}
              </g>
            );
          })}

          {!peakPoint ? (
            <text x={M.left + innerW / 2} y={M.top + innerH / 2} textAnchor="middle" fill="var(--color-void)" stroke="var(--color-paper-2)" strokeWidth={6} paintOrder="stroke" style={{ fontSize: 12, fontWeight: 600 }}>
              {/* On a phone the sentence is wider than the chart: two lines. */}
              {innerW < 420 ? (
                <>
                  <tspan x={M.left + innerW / 2} dy={-8}>
                    No report received in the last {days} days:
                  </tspan>
                  <tspan x={M.left + innerW / 2} dy={16}>
                    nothing here is measured.
                  </tspan>
                </>
              ) : (
                <>No report received in the last {days} days: nothing here is measured.</>
              )}
            </text>
          ) : null}

          {/* Peak, labelled directly. */}
          {peakPoint ? (
            <text
              x={x(series.indexOf(peakPoint)) + barW / 2}
              y={y(peakPoint.messagesObserved) - 6}
              textAnchor="middle"
              fill="var(--color-fg)"
              stroke="var(--color-paper)"
              strokeWidth={4}
              paintOrder="stroke"
              style={{ fontSize: 11, fontWeight: 600 }}
              className="tnum"
            >
              {fmt(peakPoint.messagesObserved)}
            </text>
          ) : null}

          {/* Spikes as the API defines them. */}
          {series.map((p, i) => {
            const s = spikeSet.get(p.date);
            if (!s || p === peakPoint) return null;
            return (
              <text key={`s-${p.date}`} x={x(i) + barW / 2} y={y(p.messagesObserved) - 6} textAnchor="middle" fill="var(--color-fg)" style={{ fontSize: 11, fontWeight: 600 }}>
                ×{s.multiple}
              </text>
            );
          })}

          {/* The last report, and how long since one was received. Never
              "quiet": a missing report does not mean no mail was sent. */}
          {lastIdx >= 0 && gapDays !== null && gapDays >= 1 ? (
            <g>
              {/* One string child: React treats <title> specially, and a
                  multi-part child fails hydration. */}
              <title>{`No aggregate report has been received for ${gapDays} day${gapDays === 1 ? "" : "s"}. Mail may still be flowing; receivers have not reported it.`}</title>
              <line x1={x(lastIdx) + barW / 2} x2={x(lastIdx) + barW / 2} y1={12} y2={y(0)} stroke="var(--color-fg-3)" strokeWidth="1" />
              <line
                x1={x(lastIdx) + barW / 2}
                x2={width - M.right}
                y1={14}
                y2={14}
                stroke={gapDays > STALE_AFTER_DAYS ? "var(--color-void)" : "var(--color-fg-3)"}
                strokeWidth={gapDays > STALE_AFTER_DAYS ? 2 : 1}
              />
              <line x1={width - M.right} x2={width - M.right} y1={10} y2={18} stroke="var(--color-fg-3)" />
              <text
                x={Math.min(x(lastIdx) + barW / 2 + 6, width - M.right - 170)}
                y={10}
                fill={gapDays > STALE_AFTER_DAYS ? "var(--color-void)" : "var(--color-fg-2)"}
                style={{ fontSize: 11, fontWeight: 600 }}
              >
                {`no report · ${gapDays} day${gapDays === 1 ? "" : "s"}${gapDays > STALE_AFTER_DAYS ? " · stale" : ""}`}
              </text>
            </g>
          ) : null}
          {lastKey && lastIdx < 0 ? (
            <text x={M.left} y={14} fill="var(--color-void)" style={{ fontSize: 11, fontWeight: 600 }}>
              last report {dayLabel(lastKey)}, before this window
            </text>
          ) : null}

          {/* X axis: dates counted back from today. */}
          {series.map((p, i) =>
            (days - 1 - i) % labelEvery === 0 ? (
              <g key={`x-${p.date}`}>
                <line x1={x(i) + barW / 2} x2={x(i) + barW / 2} y1={y(0)} y2={y(0) + 4} stroke="var(--color-fg)" />
                <text x={x(i) + barW / 2} y={H - 8} textAnchor={i === days - 1 ? "end" : "middle"} fill="var(--color-fg-3)" style={{ fontSize: 11 }} className="tnum">
                  {i === days - 1 ? "today" : dayLabel(p.date)}
                </text>
              </g>
            ) : null,
          )}

          {/* Hover targets: one per day, full height. Pointer only; the table below serves the keyboard. */}
          {series.map((p, i) => (
            <rect key={`h-${p.date}`} x={M.left + i * slot} y={0} width={slot} height={H} fill="transparent" onPointerEnter={() => setHover(i)} />
          ))}
        </svg>
      </div>

      <details className="group text-meta">
        <summary className="inline-flex cursor-pointer items-center gap-1 font-semibold text-fg-2 hover:text-fg">
          Daily figures <span className="text-fg-4 group-open:hidden">({observed.length} day{observed.length === 1 ? "" : "s"} with reports)</span>
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto border-y border-rule">
          <table className="w-full text-meta">
            <caption className="sr-only">Daily figures for {domainName}</caption>
            <thead>
              <tr className="legend text-left">
                <th className="py-1 pr-3 font-semibold">Day</th>
                <th className="py-1 pr-3 text-right font-semibold">Reports</th>
                <th className="py-1 pr-3 text-right font-semibold">Messages</th>
                {showFailures ? <th className="py-1 text-right font-semibold">Failed DMARC</th> : null}
              </tr>
            </thead>
            <tbody>
              {[...series].reverse().map((p) => (
                <tr key={p.date} className="border-t border-rule">
                  <td className="tnum py-1 pr-3 text-fg-2">{dayLabel(p.date)}</td>
                  {p.reportsReceived === 0 ? (
                    <td colSpan={showFailures ? 3 : 2} className="py-1 text-right text-void">
                      not measured
                    </td>
                  ) : (
                    <>
                      <td className="tnum py-1 pr-3 text-right">{p.reportsReceived}</td>
                      <td className="tnum py-1 pr-3 text-right">{fmt(p.messagesObserved)}</td>
                      {showFailures ? <td className={clsx("tnum py-1 text-right", p.failedMessages > 0 && "font-semibold text-fail")}>{fmt(p.failedMessages)}</td> : null}
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function Key({ swatch, label, value, strong }: { swatch: string; label: string; value: string; strong?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={clsx("inline-block size-2.5 translate-y-[1px]", swatch)} />
      <span className={clsx("tnum font-semibold", strong ? "text-fail" : "text-fg")}>{value}</span>
      <span className="text-fg-3">{label}</span>
    </span>
  );
}
