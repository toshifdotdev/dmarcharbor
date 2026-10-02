/**
 * trend-chart.tsx — observed volume over time, drawn as SVG.
 *
 * The chart's honesty rules (Rule Zero applied to a chart):
 * - A day with no reports is NOT a zero bar. It is a hatched gap: absence of
 *   measurement, never measurement of nothing.
 * - The trailing silence after the last observation is a blackout band, labelled
 *   with when the feed went quiet — never smoothed away, never averaged in.
 * - Failed messages are drawn on top of the observed total in the block colour;
 *   they are never a separate chart that can be scrolled past.
 */

import type { TrendPoint } from "@/lib/types";
import { fmtVolume } from "@/lib/posture";

/**
 * The API buckets a point per day a report was RECEIVED — a day with no report
 * simply has no entry, so a sparse series would silently compress the silence
 * between observations. Expand it into a full daily window instead: every
 * calendar day gets a slot, and a day with no entry is a hatched gap. This is
 * Rule Zero applied to a chart — absence must be visible, never compressed.
 */
export function expandDailyWindow(
  points: TrendPoint[],
  days: number,
  lastReportAt: string | null,
): TrendPoint[] {
  const end = lastReportAt ? new Date(lastReportAt) : new Date();
  const byDate = new Map(points.map((p) => [p.date.slice(0, 10), p]));
  const out: TrendPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push(
      byDate.get(d) ?? {
        date: d,
        reportsReceived: 0,
        messagesObserved: 0,
        failedMessages: 0,
      },
    );
  }
  return out;
}

export function TrendChart({
  points,
  lastReportAt,
  domainName,
  windowDays,
}: {
  points: TrendPoint[];
  lastReportAt: string | null;
  domainName: string;
  windowDays?: number;
}) {
  const expanded = expandDailyWindow(points, windowDays ?? 30, lastReportAt);
  const observed = expanded.filter((p) => p.reportsReceived > 0);
  const missing = expanded.filter((p) => p.reportsReceived === 0);

  if (observed.length === 0) {
    return (
      <figure className="flex flex-col gap-3">
        <svg viewBox="0 0 720 200" width="100%" role="img" aria-label={`No measurement for ${domainName} in this window.`}>
          <defs>
            <pattern id="void-hatch" width="6" height="6" patternTransform="rotate(-45)" patternUnits="userSpaceOnUse">
              <rect width="6" height="6" fill="transparent" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-unmeasured)" strokeWidth="1.5" opacity="0.4" />
            </pattern>
          </defs>
          <rect x="46" y="12" width="666" height="162" fill="url(#void-hatch)" />
        </svg>
        <p className="num text-[10.5px]" style={{ color: "var(--color-ink-3)" }}>
          Nothing measured in this window — {missing.length} unmeasured days.
        </p>
      </figure>
    );
  }

  const peak = Math.max(1, ...expanded.map((p) => p.messagesObserved));
  const W = 720;
  const H = 200;
  const PAD_L = 46;
  const PAD_B = 26;
  const innerW = W - PAD_L - 8;
  const innerH = H - PAD_B - 12;
  const slot = innerW / expanded.length;
  const barW = Math.max(3, slot * 0.62);

  const y = (v: number) => 12 + innerH - (v / peak) * innerH;

  const staleSince = lastReportAt
    ? new Date(lastReportAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
    : null;

  return (
    <figure className="flex flex-col gap-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Daily message volume for ${domainName}. ${observed.length} observed days, ${missing.length} days with no measurement.`}
      >
        <defs>
          <pattern id="void-hatch" width="6" height="6" patternTransform="rotate(-45)" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill="transparent" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-unmeasured)" strokeWidth="1.5" opacity="0.4" />
          </pattern>
        </defs>

        {/* baseline */}
        <line x1={PAD_L} y1={y(0)} x2={W - 8} y2={y(0)} stroke="var(--color-line-strong)" strokeWidth="1" />
        <text x={4} y={y(peak)} fill="var(--color-ink-3)" fontSize="9" fontFamily="var(--font-mono)">
          {fmtVolume(peak)}
        </text>
        <text x={4} y={y(0)} fill="var(--color-ink-3)" fontSize="9" fontFamily="var(--font-mono)">
          0
        </text>

        {expanded.map((p, i) => {
          const x = PAD_L + i * slot + (slot - barW) / 2;
          if (p.reportsReceived === 0) {
            // No measurement. A hatched gap, never a zero bar.
            return (
              <rect
                key={p.date}
                x={x}
                y={12}
                width={barW}
                height={innerH}
                fill="url(#void-hatch)"
              />
            );
          }
          const h = (p.messagesObserved / peak) * innerH;
          const failH = (p.failedMessages / peak) * innerH;
          return (
            <g key={p.date}>
              <rect x={x} y={y(p.messagesObserved)} width={barW} height={h} fill="var(--color-accent)" opacity="0.85" />
              {p.failedMessages > 0 ? (
                <rect x={x} y={y(p.failedMessages)} width={barW} height={failH} fill="var(--color-block)" />
              ) : null}
            </g>
          );
        })}
      </svg>

      <figcaption
        className="num flex flex-wrap items-center gap-x-5 gap-y-1 text-[10.5px]"
        style={{ color: "var(--color-ink-3)" }}
      >
        <span>
          <Swatch color="var(--color-accent)" /> {observed.length} observed days
        </span>
        <span>
          <Swatch color="var(--color-block)" /> failed messages
        </span>
        <span>
          <Swatch hatched /> {missing.length} days not measured
        </span>
        {staleSince ? <span>feed last reported {staleSince}</span> : null}
      </figcaption>
    </figure>
  );
}

function Swatch({ color, hatched }: { color?: string; hatched?: boolean }) {
  return (
    <span
      aria-hidden
      className={hatched ? "hatch mr-1 inline-block size-2 rounded-[1px]" : "mr-1 inline-block size-2 rounded-[1px]"}
      style={{ background: color }}
    />
  );
}
