"use client";

/**
 * landing-alerts-map.tsx — where an alert goes, drawn as an interchange.
 *
 * Four things that can go wrong on a client domain arrive from the left and
 * stop at one station, the alert. Six lines leave it for the places a team
 * already works: email, Slack, Teams, and a ticket in the PSA. The forged
 * sender is the dashed red line, as on the hero map. Reports that stopped
 * arriving are a grey dashed line with no messages on it, because that is the
 * event: nothing is coming.
 *
 * Same rules as the hero map: fixed geometry, coordinates rounded, messages
 * added only after hydration and paused off screen.
 */

import { useRef } from "react";
import { length, q, rounded, SPEED, type Pt } from "./landing-geometry";
import { useRide } from "./landing-motion";
import s from "./landing.module.css";

const X0 = 36;
const ST = 300;
const TX = 636;

type Tone = "plain" | "forged" | "quiet";

interface Route {
  id: string;
  name: string;
  kind: string;
  points: Pt[];
  tone: Tone;
}

/** In: runs right at y0, bends 45° onto its lane, and stops at the station. */
function arrive(y0: number, lane: number, diagX: number): Pt[] {
  return [
    [X0, y0],
    [diagX, y0],
    [diagX + Math.abs(lane - y0), lane],
    [ST, lane],
  ];
}

/** Out: leaves the station on its lane, bends 45° to y1, runs to a terminus. */
function depart(lane: number, y1: number, diagX: number): Pt[] {
  return [
    [ST, lane],
    [diagX, lane],
    [diagX + Math.abs(y1 - lane), y1],
    [TX, y1],
  ];
}

/**
 * Lanes at the station are 11 apart. Diagonals that run side by side start
 * 11 x root 2 apart along the axis, so they stay 11 apart across the bend.
 */
const IN: (Route & { y0: number; label: "above" | "below" })[] = [
  { id: "new", name: "New sender", kind: "fails SPF and DKIM", tone: "forged", y0: 56, label: "above", points: arrive(56, 203.5, 110) },
  { id: "fail", name: "Failures", kind: "over your threshold", tone: "plain", y0: 150, label: "below", points: arrive(150, 214.5, 188.44) },
  { id: "quiet", name: "Reports", kind: "stopped arriving", tone: "quiet", y0: 290, label: "above", points: arrive(290, 225.5, 188.44) },
  { id: "dns", name: "DNS record", kind: "changed", tone: "plain", y0: 384, label: "below", points: arrive(384, 236.5, 110) },
];

const OUT: (Route & { y1: number })[] = [
  { id: "email", name: "Email", kind: "your team", tone: "plain", y1: 40, points: depart(192.5, 40, 360) },
  { id: "slack", name: "Slack", kind: "a channel", tone: "plain", y1: 112, points: depart(203.5, 112, 364.56) },
  { id: "teams", name: "Teams", kind: "a channel", tone: "plain", y1: 184, points: depart(214.5, 184, 369.12) },
  { id: "halo", name: "HaloPSA", kind: "a ticket", tone: "plain", y1: 256, points: depart(225.5, 256, 369.12) },
  { id: "cw", name: "ConnectWise", kind: "a ticket", tone: "plain", y1: 328, points: depart(236.5, 328, 364.56) },
  { id: "autotask", name: "Autotask", kind: "a ticket", tone: "plain", y1: 400, points: depart(247.5, 400, 360) },
];

const STROKE: Record<Tone, string> = { plain: "#15171b", forged: "#d9342b", quiet: "#a3a8b0" };

const withPaths = <T extends Route>(routes: T[]) => routes.map((r) => ({ ...r, d: rounded(r.points, 14), len: length(r.points) }));
const IN_PATHS = withPaths(IN);
const OUT_PATHS = withPaths(OUT);

export function AlertsMap() {
  const svg = useRef<SVGSVGElement | null>(null);
  const moving = useRide(svg);

  return (
    <svg ref={svg} viewBox="8 -6 656 438" className={s.map} role="img" aria-labelledby="al-map-title">
      <title id="al-map-title">
        Where alerts go: a new sender failing SPF and DKIM, failures over a threshold, reports that stop arriving and a
        changed DNS record each raise an alert, which goes to email, Slack or Teams, or opens a ticket in HaloPSA,
        ConnectWise or Autotask.
      </title>

      {[...IN_PATHS, ...OUT_PATHS].map((r) => (
        <path
          key={r.id}
          id={`al-${r.id}`}
          d={r.d}
          fill="none"
          stroke={STROKE[r.tone]}
          strokeWidth={6}
          strokeLinecap={r.tone === "plain" ? "round" : "butt"}
          strokeLinejoin="round"
          strokeDasharray={r.tone === "forged" ? "10 7" : r.tone === "quiet" ? "3 8" : undefined}
        />
      ))}

      {/* Messages: into the station on every live line, then out on each route. */}
      {moving
        ? [...IN_PATHS.filter((r) => r.tone !== "quiet"), ...OUT_PATHS].flatMap((r, n) => {
            const dur = r.len / SPEED;
            return [0, 1].map((i) => (
              <circle key={`${r.id}-${i}`} r={4} className={s.mMsg} stroke={STROKE[r.tone]}>
                <animateMotion dur={`${q(dur)}s`} begin={`${q(-(dur / 2) * i - (n % 5) * 0.37)}s`} repeatCount="indefinite">
                  <mpath href={`#al-${r.id}`} />
                </animateMotion>
              </circle>
            ));
          })
        : null}

      {/* Where each event starts */}
      {IN_PATHS.map((r) => (
        <circle
          key={`o-${r.id}`}
          cx={X0}
          cy={r.y0}
          r={6.5}
          className={s.mOrigin}
          stroke={r.tone === "plain" ? undefined : STROKE[r.tone]}
        />
      ))}

      {/* The alert: one station across every lane in and out. */}
      <rect x={ST - 12} y={181} width={24} height={78} rx={12} className={s.mStation} />

      {/* Where each alert ends up */}
      {OUT_PATHS.map((r) => (
        <rect key={`t-${r.id}`} x={TX - 12} y={r.y1 - 15} width={24} height={30} rx={12} className={s.mStation} />
      ))}

      {/* Labels */}
      {IN_PATHS.map((r) => (
        <text
          key={`l-${r.id}`}
          x={X0 - 14}
          y={r.label === "above" ? r.y0 - 16 : r.y0 + 28}
          className={s.mLbl}
          data-forged={r.tone === "forged" ? "" : undefined}
        >
          <tspan className={s.mName}>{r.name}</tspan>
          <tspan className={s.mKind} dx={7}>
            {r.kind}
          </tspan>
        </text>
      ))}
      {OUT_PATHS.map((r) => (
        <text key={`l-${r.id}`} x={TX + 12} y={r.y1 - 24} textAnchor="end" className={s.mLbl}>
          <tspan className={s.mName}>{r.name}</tspan>
          <tspan className={s.mKind} dx={7}>
            {r.kind}
          </tspan>
        </text>
      ))}
      <text x={ST} y={150} textAnchor="middle" className={s.mLbl}>
        <tspan className={s.mName}>Alert</tspan>
        <tspan x={ST} dy={17} className={s.mKind}>
          your rules
        </tspan>
      </text>
    </svg>
  );
}
