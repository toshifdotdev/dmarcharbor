"use client";

/**
 * landing-route-map.tsx — one domain's mail, drawn as a transit map. The home
 * page hero.
 *
 * Each service that sends as the domain is a line. The lines join into one
 * trunk, stop at two stations (authenticated by SPF or DKIM, then aligned with
 * the From domain) and end at the Inbox. The unknown sender is a dashed red
 * line: it fails at the first station and is turned away to Rejected.
 *
 * Messages ride the lines as small dots. They are added after hydration, only
 * when motion is allowed, and paused while the map is off screen, so the
 * server HTML is the still map. All geometry is fixed at module level.
 */

import { useRef } from "react";
import { length, q, rounded, SPEED, type Pt } from "./landing-geometry";
import { useRide } from "./landing-motion";
import s from "./landing.module.css";

const X0 = 36;
/** Parallel lines sit 11 apart; on a 45° run that is 11 x root 2 along the axis. */
const D = 11 * Math.SQRT2;
const S1 = 410;
const S2 = 520;
const END = 640;
const REJECT_AT: Pt = [566, 360];

interface Line {
  id: string;
  name: string;
  kind: string;
  color: string;
  y0: number;
  points: readonly Pt[];
  /** Label above the start (lines that bend down) or below it (lines that bend up). */
  label: "above" | "below";
  forged?: boolean;
}

/** A line that runs right at y0, bends 45° onto the trunk at yb, then runs to x1. */
function bend(y0: number, yb: number, diagStartX: number, x1: number): Pt[] {
  const run = Math.abs(yb - y0);
  return [
    [X0, y0],
    [diagStartX, y0],
    [diagStartX + run, yb],
    [x1, yb],
  ];
}

const LINES: Line[] = [
  { id: "ms", name: "Microsoft 365", kind: "staff mail", color: "#1f5fd6", y0: 50, label: "above", points: bend(50, 192, 178, END) },
  { id: "hub", name: "HubSpot", kind: "marketing", color: "#f07c1b", y0: 128, label: "above", points: bend(128, 203, 128 + 128 - D, END) },
  { id: "xero", name: "Xero", kind: "invoices", color: "#13a050", y0: 214, label: "above", points: [[X0, 214], [END, 214]] },
  { id: "chimp", name: "Mailchimp", kind: "newsletters", color: "#f2b705", y0: 300, label: "below", points: bend(300, 225, 245, END) },
  { id: "zen", name: "Zendesk", kind: "helpdesk", color: "#8a3fd1", y0: 378, label: "below", points: bend(378, 236, 545 + D - 378, END) },
  {
    id: "forged",
    name: "Unknown sender",
    kind: "fails SPF and DKIM",
    color: "#d9342b",
    y0: 456,
    label: "below",
    forged: true,
    points: [
      [X0, 456],
      [545 + 2 * D - 456, 456],
      [545 + 2 * D - 247, 247],
      [430, 247],
      [430 + (REJECT_AT[1] - 247), REJECT_AT[1]],
      REJECT_AT,
    ],
  },
];

const PATHS = LINES.map((l) => ({ ...l, d: rounded(l.points, 14), len: length(l.points) }));

export function RouteMap() {
  const svg = useRef<SVGSVGElement | null>(null);
  const moving = useRide(svg);

  return (
    <svg ref={svg} viewBox="14 18 666 478" className={s.map} role="img" aria-labelledby="rt-map-title">
      <title id="rt-map-title">
        Mail routes for an example domain: five named services reach the inbox, and an unknown sender is rejected.
      </title>

      {/* Lines */}
      {PATHS.map((l) => (
        <path
          key={l.id}
          id={`rt-${l.id}`}
          d={l.d}
          fill="none"
          stroke={l.color}
          strokeWidth={7}
          strokeLinecap={l.forged ? "butt" : "round"}
          strokeLinejoin="round"
          strokeDasharray={l.forged ? "10 7" : undefined}
        />
      ))}

      {/* Messages, riding the lines; they pass under the stations. */}
      {moving
        ? PATHS.flatMap((l) => {
            const dur = l.len / SPEED;
            const count = l.forged ? 2 : 3;
            return Array.from({ length: count }, (_, i) => (
              <circle key={`${l.id}-${i}`} r={4.5} className={s.mMsg} stroke={l.color}>
                <animateMotion dur={`${q(dur)}s`} begin={`${q(-(dur / count) * i - (l.y0 % 7) * 0.3)}s`} repeatCount="indefinite">
                  <mpath href={`#rt-${l.id}`} />
                </animateMotion>
              </circle>
            ));
          })
        : null}

      {/* Where each line starts */}
      {PATHS.map((l) => (
        <circle key={`o-${l.id}`} cx={X0} cy={l.y0} r={6.5} className={s.mOrigin} stroke={l.forged ? l.color : undefined} />
      ))}

      {/* Stations: a capsule across every line that stops there. */}
      <rect x={S1 - 12} y={180} width={24} height={79} rx={12} className={s.mStation} />
      <rect x={S2 - 12} y={180} width={24} height={68} rx={12} className={s.mStation} />
      <rect x={END - 16} y={177} width={32} height={74} rx={16} className={s.mStation} />

      {/* The unknown sender fails at the first station. */}
      <path d={`M${S1 - 4.5} 242.5 L${S1 + 4.5} 251.5 M${S1 + 4.5} 242.5 L${S1 - 4.5} 251.5`} className={s.mFail} />

      {/* Rejected: a terminus bar, then its label. */}
      <rect x={REJECT_AT[0]} y={REJECT_AT[1] - 13} width={5} height={26} rx={1.5} className={s.mBar} />

      {/* Labels */}
      {PATHS.map((l) => (
        <text
          key={`t-${l.id}`}
          x={X0 - 14}
          y={l.label === "above" ? l.y0 - 16 : l.y0 + 28}
          className={s.mLbl}
          data-forged={l.forged ? "" : undefined}
        >
          <tspan className={s.mName}>{l.name}</tspan>
          <tspan className={s.mKind} dx={7}>
            {l.kind}
          </tspan>
        </text>
      ))}
      <StationLabel x={S1} title="SPF · DKIM" sub="authenticated" />
      <StationLabel x={S2} title="Aligned" sub="with the From domain" />
      <StationLabel x={END} title="Inbox" sub="delivered" />
      <text x={REJECT_AT[0] + 16} y={REJECT_AT[1] - 2} className={s.mLbl} data-forged="">
        <tspan className={s.mName}>Rejected</tspan>
        <tspan x={REJECT_AT[0] + 16} dy={17} className={s.mKind}>
          at p=reject
        </tspan>
      </text>
    </svg>
  );
}

function StationLabel({ x, title, sub }: { x: number; title: string; sub: string }) {
  return (
    <text x={x} y={146} textAnchor="middle" className={s.mLbl}>
      <tspan className={s.mName}>{title}</tspan>
      <tspan x={x} dy={17} className={s.mKind}>
        {sub}
      </tspan>
    </text>
  );
}
