"use client";

/**
 * pass-rate-chart.tsx — DMARC, SPF and DKIM pass rates by day, as lines.
 *
 * The volume chart says how much mail; this says how well it authenticated,
 * so a fix (or a break) shows on the day it happened. Same rules:
 * - Calendar days ending today. A day with no report is hatched and the line
 *   breaks there: no rate is drawn through silence, and never a zero.
 * - DMARC passed is the outcome, in the green of a line in service; SPF and
 *   DKIM are the inputs, in ink and dashed grey, so the sender colours stay
 *   for senders. The 95% rule is amber: below it, enforcing starts to stop
 *   real mail.
 * - The readout above the plot is the legend, and the hovered day on hover.
 *
 * Drawn at the container's real width; the lines draw in once on view.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { TrendPoint } from "@/lib/types";
import { calendarSeries } from "./mini-trend";
import { DrawOnView } from "./draw-on-view";

const H = 176;
const M = { top: 14, right: 52, bottom: 24, left: 4 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const THRESHOLD = 95;

function dayLabel(key: string) {
  const [, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

type Rate = { dmarc: number; spf: number | null; dkim: number | null };

function rates(p: TrendPoint): Rate | null {
  if (p.reportsReceived === 0 || p.messagesObserved === 0) return null;
  const n = p.messagesObserved;
  return {
    dmarc: ((n - p.failedMessages) / n) * 100,
    spf: typeof p.spfPassMessages === "number" ? (p.spfPassMessages / n) * 100 : null,
    dkim: typeof p.dkimPassMessages === "number" ? (p.dkimPassMessages / n) * 100 : null,
  };
}

const pct = (v: number | null) => (v === null ? "not measured" : `${v >= 99.95 ? "100" : v.toFixed(1)}%`);

export function PassRateChart({ points, days = 30, today, subject }: { points: TrendPoint[]; days?: number; today: string; subject: string }) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(960);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(300, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const series = useMemo(() => calendarSeries(points, today, days).map((p) => ({ date: p.date, r: rates(p as TrendPoint) })), [points, today, days]);
  const observed = series.filter((s) => s.r);
  const hasInputs = observed.some((s) => s.r?.spf !== null);

  // The scale starts low enough to show the lowest day, in steps of ten, and never above 90.
  const lowest = Math.min(THRESHOLD, ...observed.flatMap((s) => [s.r!.dmarc, s.r!.spf ?? 100, s.r!.dkim ?? 100]));
  const floor = Math.max(0, Math.min(90, Math.floor((lowest - 2) / 10) * 10));
  const innerW = width - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  const slot = innerW / days;
  const x = (i: number) => Math.round((M.left + i * slot + slot / 2) * 100) / 100;
  const y = (v: number) => Math.round((M.top + innerH - ((v - floor) / (100 - floor)) * innerH) * 100) / 100;

  /** Runs of consecutive measured days, so the line breaks across silence. */
  function runs(pick: (r: Rate) => number | null): string[] {
    const out: string[] = [];
    let current: string[] = [];
    series.forEach((s, i) => {
      const v = s.r ? pick(s.r) : null;
      if (v === null) {
        if (current.length) out.push(current.join(" "));
        current = [];
        return;
      }
      current.push(`${current.length ? "L" : "M"}${x(i)} ${y(v)}`);
    });
    if (current.length) out.push(current.join(" "));
    return out;
  }

  const total = points.reduce(
    (a, p) => ({ n: a.n + p.messagesObserved, f: a.f + p.failedMessages, s: a.s + (p.spfPassMessages ?? 0), k: a.k + (p.dkimPassMessages ?? 0) }),
    { n: 0, f: 0, s: 0, k: 0 },
  );
  const overall: Rate | null = total.n
    ? { dmarc: ((total.n - total.f) / total.n) * 100, spf: hasInputs ? (total.s / total.n) * 100 : null, dkim: hasInputs ? (total.k / total.n) * 100 : null }
    : null;
  const shown = hover !== null ? series[hover] : null;
  const read = shown ? shown.r : overall;

  const lines: Array<{ key: keyof Rate; label: string; stroke: string; width: number; dash?: string }> = [
    { key: "dkim", label: "DKIM aligned", stroke: "var(--color-fg-4)", width: 2, dash: "5 4" },
    { key: "spf", label: "SPF aligned", stroke: "var(--color-fg-2)", width: 2 },
    { key: "dmarc", label: "DMARC passed", stroke: "var(--color-done)", width: 3 },
  ];
  const drawn = lines.filter((l) => l.key === "dmarc" || hasInputs);

  return (
    <figure className="m-0 flex flex-col gap-2" data-draw data-testid="pass-rate-chart">
      <DrawOnView />
      <div className="flex min-h-[20px] flex-wrap items-center gap-x-5 gap-y-1 text-meta" aria-hidden>
        {shown ? <span className="tnum font-semibold text-fg">{dayLabel(shown.date)}</span> : null}
        {shown && !shown.r ? (
          <span className="text-void">no report received: not measured</span>
        ) : (
          [...drawn].reverse().map((l) => (
            <span key={l.key} className="inline-flex items-center gap-1.5">
              <svg width="16" height="6" aria-hidden>
                <line x1="1" x2="15" y1="3" y2="3" stroke={l.stroke} strokeWidth={l.width} strokeDasharray={l.dash} strokeLinecap="round" />
              </svg>
              <span className="tnum font-semibold text-fg">{pct(read ? read[l.key] : null)}</span>
              <span className="text-fg-3">{l.label}</span>
            </span>
          ))
        )}
        {!shown ? <span className="text-fg-3">{hover === null ? `over the last ${days} days` : ""}</span> : null}
      </div>

      <div ref={wrap} className="relative w-full" onPointerLeave={() => setHover(null)}>
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          role="img"
          aria-label={
            overall
              ? `Pass rates for ${subject} over the last ${days} days: DMARC ${pct(overall.dmarc)}${hasInputs ? `, SPF ${pct(overall.spf)}, DKIM ${pct(overall.dkim)}` : ""}. ${days - observed.length} days not measured.`
              : `No report received for ${subject} in the last ${days} days: nothing here is measured.`
          }
          className="block select-none"
        >
          <defs>
            <pattern id="rate-hatch" width="6" height="6" patternTransform="rotate(-45)" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-void)" strokeWidth="1.2" opacity="0.28" />
            </pattern>
          </defs>
          {series.map((s, i) =>
            s.r ? null : <rect key={`h${s.date}`} x={x(i) - slot / 2} y={M.top} width={slot} height={innerH} fill="url(#rate-hatch)" />,
          )}
          {[100, (100 + floor) / 2, floor].map((v) => (
            <g key={v}>
              <line x1={M.left} x2={width - M.right} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} stroke={v === floor ? "var(--color-fg)" : "var(--color-rule)"} />
              <text x={width - M.right + 8} y={y(v) + 4} fill="var(--color-fg-3)" style={{ fontSize: 12.5 }} className="tnum">
                {v}%
              </text>
            </g>
          ))}
          {/* The enforcement line: below it, enforcing would stop real mail. */}
          <line x1={M.left} x2={width - M.right} y1={y(THRESHOLD)} y2={y(THRESHOLD)} stroke="var(--color-warn-mark)" strokeWidth={1.5} strokeDasharray="4 4" />
          <text x={width - M.right + 8} y={y(THRESHOLD) + 4} fill="var(--color-warn)" style={{ fontSize: 12.5, fontWeight: 600 }} className="tnum">
            {THRESHOLD}%
          </text>
          {drawn.map((l, li) =>
            runs((r) => r[l.key]).map((d, ri) => (
              <path
                key={`${l.key}${ri}`}
                d={d}
                fill="none"
                stroke={l.stroke}
                strokeWidth={l.width}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={l.dash}
                pathLength={l.dash ? undefined : 1}
                className={l.dash ? undefined : "hb-draw"}
                style={l.dash ? undefined : ({ strokeDasharray: 1, "--i": li } as CSSProperties)}
              />
            )),
          )}
          {series.map((s, i) =>
            s.r ? (
              <circle key={`d${s.date}`} cx={x(i)} cy={y(s.r.dmarc)} r={hover === i ? 5 : 3.5} fill="var(--color-paper)" stroke="var(--color-done)" strokeWidth={2.5} />
            ) : null,
          )}
          {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + innerH} stroke="var(--color-rule-2)" /> : null}
          {series.map((s, i) =>
            (days - 1 - i) % (slot < 14 ? 7 : slot < 28 ? 4 : 2) === 0 ? (
              <text
                key={`x${s.date}`}
                // A label near either edge is anchored inwards, so it is never cut on a phone.
                x={i === days - 1 ? Math.min(x(i) + slot / 2, width - M.right) : x(i) < 30 ? Math.max(0, x(i) - slot / 2) : x(i)}
                y={H - 6}
                textAnchor={i === days - 1 ? "end" : x(i) < 30 ? "start" : "middle"}
                fill="var(--color-fg-3)"
                style={{ fontSize: 12.5 }}
                className="tnum"
              >
                {i === days - 1 ? "today" : dayLabel(s.date)}
              </text>
            ) : null,
          )}
          {series.map((s, i) => (
            <rect key={`t${s.date}`} x={x(i) - slot / 2} y={0} width={slot} height={H} fill="transparent" onPointerEnter={() => setHover(i)} />
          ))}
        </svg>
      </div>
    </figure>
  );
}
