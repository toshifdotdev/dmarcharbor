"use client";

/**
 * landing-portal-map.tsx — white label, drawn as the agency's own line.
 *
 * The line is the agency's colour (a fictional agency's here) and runs from
 * the agency to its client. Each station on it is something the client sees
 * under the agency's name: the portal, the monthly report, the request to
 * approve a stricter policy. The client is the terminus.
 *
 * One route, drawn twice: across the figure from 640px, and down it on phones,
 * where a line across would set its labels too small to read. CSS shows one.
 * Same rules as the other maps: fixed geometry, coordinates rounded, messages
 * added only after hydration and paused off screen.
 */

import { useRef } from "react";
import { length, q, rounded, SPEED, type Pt } from "./landing-geometry";
import { useRide } from "./landing-motion";
import s from "./landing.module.css";

/** Sample names: invented, and checked not to belong to a real business. */
export const AGENCY = "Wistholm IT";
export const AGENCY_PORTAL = "portal.wistholm-it.example";
export const CLIENT = "Haskerley Law";

const TITLE = `A sample agency’s own line, in its colour, from ${AGENCY} to its client ${CLIENT}: the portal in its colours, the monthly report with its logo, and approval requests asked in its name.`;

interface Drawing {
  viewBox: string;
  points: Pt[];
  origin: Pt;
  originLabel: Pt;
  stops: { name: string; kind: string; at: Pt; label: Pt; anchor: "start" | "middle" }[];
  end: Pt;
  endLabel: Pt;
  endAnchor: "start" | "end";
  /** Capsules lie across the line: tall on a line that runs across, wide on one that runs down. */
  tall: boolean;
}

const STOPS = [
  { name: "Portal", kind: "in your colours" },
  { name: "Monthly report", kind: "with your logo" },
  { name: "Approval", kind: "asked in your name" },
] as const;

const ACROSS: Drawing = {
  viewBox: "8 0 684 290",
  points: [
    [36, 70],
    [360, 70],
    [510, 220],
    [664, 220],
  ],
  origin: [36, 70],
  originLabel: [22, 106],
  stops: [
    { ...STOPS[0], at: [170, 70], label: [170, 26], anchor: "middle" },
    { ...STOPS[1], at: [300, 70], label: [300, 26], anchor: "middle" },
    { ...STOPS[2], at: [588, 220], label: [588, 260], anchor: "middle" },
  ],
  end: [664, 220],
  endLabel: [679, 162],
  endAnchor: "end",
  tall: true,
};

const DOWN: Drawing = {
  viewBox: "0 0 340 484",
  points: [
    [40, 28],
    [40, 200],
    [110, 270],
    [110, 452],
  ],
  origin: [40, 28],
  originLabel: [72, 26],
  stops: [
    { ...STOPS[0], at: [40, 100], label: [72, 98], anchor: "start" },
    { ...STOPS[1], at: [40, 170], label: [72, 168], anchor: "start" },
    { ...STOPS[2], at: [110, 330], label: [142, 328], anchor: "start" },
  ],
  end: [110, 452],
  endLabel: [148, 450],
  endAnchor: "start",
  tall: false,
};

export function PortalMap() {
  return (
    <>
      <Route drawing={ACROSS} id="pm-across" className={`${s.map} ${s.portalAcross}`} titled />
      <Route drawing={DOWN} id="pm-down" className={s.portalDown} />
    </>
  );
}

function Route({ drawing, id, className, titled }: { drawing: Drawing; id: string; className: string; titled?: boolean }) {
  const svg = useRef<SVGSVGElement | null>(null);
  const moving = useRide(svg);
  const d = rounded(drawing.points, 14);
  const dur = length(drawing.points) / SPEED;
  const { tall } = drawing;
  // The phone drawing is shown near its own size, so its labels are set larger.
  const big = !tall;

  return (
    <svg
      ref={svg}
      viewBox={drawing.viewBox}
      className={className}
      role={titled ? "img" : undefined}
      aria-labelledby={titled ? `${id}-title` : undefined}
      aria-hidden={titled ? undefined : true}
    >
      {/* One string: a <title> split into several text nodes does not hydrate cleanly. */}
      {titled ? <title id={`${id}-title`}>{TITLE}</title> : null}

      <path id={`${id}-line`} d={d} fill="none" strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" className={s.agencyLine} />

      {moving
        ? [0, 1, 2].map((i) => (
            <circle key={i} r={4.5} className={`${s.mMsg} ${s.agencyMsg}`}>
              <animateMotion dur={`${q(dur)}s`} begin={`${q(-(dur / 3) * i)}s`} repeatCount="indefinite">
                <mpath href={`#${id}-line`} />
              </animateMotion>
            </circle>
          ))
        : null}

      <circle cx={drawing.origin[0]} cy={drawing.origin[1]} r={7.5} className={`${s.mOrigin} ${s.agencyOrigin}`} />

      {drawing.stops.map((stop) => (
        <rect
          key={stop.name}
          x={stop.at[0] - (tall ? 11 : 17)}
          y={stop.at[1] - (tall ? 17 : 11)}
          width={tall ? 22 : 34}
          height={tall ? 34 : 22}
          rx={11}
          className={s.mStation}
        />
      ))}
      {/* The client: the terminus, the larger capsule. */}
      <rect
        x={drawing.end[0] - (tall ? 15 : 22)}
        y={drawing.end[1] - (tall ? 22 : 15)}
        width={tall ? 30 : 44}
        height={tall ? 44 : 30}
        rx={15}
        className={s.mStation}
      />

      <Label at={drawing.originLabel} name={AGENCY} kind="you" big={big} agency inline={tall} />
      {drawing.stops.map((stop) => (
        <Label key={stop.name} at={stop.label} name={stop.name} kind={stop.kind} big={big} anchor={stop.anchor} />
      ))}
      <Label at={drawing.endLabel} name={CLIENT} kind="your client" big={big} anchor={drawing.endAnchor} />
    </svg>
  );
}

function Label({
  at,
  name,
  kind,
  big,
  agency,
  inline,
  anchor = "start",
}: {
  at: Pt;
  name: string;
  kind: string;
  big: boolean;
  agency?: boolean;
  /** Name and kind on one line, the way the hero map labels its origins. */
  inline?: boolean;
  anchor?: "start" | "middle" | "end";
}) {
  return (
    <text x={at[0]} y={at[1]} textAnchor={anchor} className={big ? `${s.pLbl} ${s.pLblBig}` : s.pLbl} data-agency={agency ? "" : undefined}>
      <tspan className={s.pName}>{name}</tspan>
      {inline ? (
        <tspan className={s.pKind} dx={7}>
          {kind}
        </tspan>
      ) : (
        <tspan className={s.pKind} x={at[0]} dy={big ? 20 : 17}>
          {kind}
        </tspan>
      )}
    </text>
  );
}
