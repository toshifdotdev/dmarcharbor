/**
 * donut.tsx — parts of a whole, as a ring, with its legend beside it.
 *
 * Used only where the parts are few and the whole is the point: who sends a
 * domain its reports, and what receivers did with the mail. Each arc carries
 * a share in words in the legend and the accessible name, so nothing is said
 * by colour alone. The ring draws round once on view (draw-on-view.tsx).
 * No hooks besides that: it renders on the server.
 */

import type { CSSProperties } from "react";
import { DrawOnView } from "./draw-on-view";

export interface DonutPart {
  key: string;
  label: string;
  value: number;
  /** A CSS colour. */
  colour: string;
  /** The label is an identifier (a domain), set in the data face. */
  mono?: boolean;
}

const R = 38;
const C = 2 * Math.PI * R;

function share(v: number, total: number): string {
  const p = (v / total) * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p >= 99.95 ? 100 : Math.round(p * 10) / 10}%`;
}

export function Donut({
  title,
  kind,
  parts,
  centre,
  centreKind,
  testId,
}: {
  title: string;
  kind: string;
  parts: DonutPart[];
  /** The figure in the hole, e.g. "3" or "97.9%". */
  centre: string;
  centreKind: string;
  testId?: string;
}) {
  const shown = parts.filter((p) => p.value > 0);
  const total = shown.reduce((n, p) => n + p.value, 0);
  if (total === 0) return null;
  // A hairline of white between arcs, unless one part is the whole ring.
  const gap = shown.length > 1 ? 1.6 : 0;
  let offset = 0;

  return (
    <figure className="m-0 flex min-w-0 flex-col gap-3" data-draw data-testid={testId}>
      <DrawOnView />
      <p className="border-b border-rule pb-2 text-ui">
        <span className="font-bold text-fg">{title}</span> <span className="text-fg-3">{kind}</span>
      </p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <svg
          width="112"
          height="112"
          viewBox="0 0 100 100"
          role="img"
          aria-label={`${title}: ${shown.map((p) => `${p.label} ${share(p.value, total)}`).join(", ")}`}
          className="block shrink-0 -rotate-90"
        >
          <circle cx="50" cy="50" r={R} fill="none" stroke="var(--color-rule)" strokeWidth="12" />
          {shown.map((p, i) => {
            const len = (p.value / total) * C;
            const arc = Math.max(0.01, len - gap);
            const el = (
              <circle
                key={p.key}
                cx="50"
                cy="50"
                r={R}
                fill="none"
                stroke={p.colour}
                strokeWidth="12"
                strokeDasharray={`${arc.toFixed(2)} ${(C - arc).toFixed(2)}`}
                strokeDashoffset={(-offset).toFixed(2)}
                className="hb-donut"
                style={{ "--i": i } as CSSProperties}
              />
            );
            offset += len;
            return el;
          })}
          <g className="rotate-90 [transform-origin:50px_50px]">
            <text x="50" y="50" textAnchor="middle" fill="var(--color-fg)" style={{ fontSize: 17, fontWeight: 740 }} className="tnum">
              {centre}
            </text>
            <text x="50" y="64" textAnchor="middle" fill="var(--color-fg-3)" style={{ fontSize: 9.5 }}>
              {centreKind}
            </text>
          </g>
        </svg>
        <ul className="flex min-w-0 flex-1 flex-col gap-1.5 text-meta">
          {shown.map((p) => (
            <li key={p.key} className="flex min-w-0 items-center gap-2">
              <span aria-hidden className="block size-2.5 shrink-0 rounded-[2px]" style={{ background: p.colour }} />
              <span className={`min-w-0 truncate font-semibold text-fg ${p.mono ? "data" : ""}`} title={p.label}>
                {p.label}
              </span>
              <span className="tnum ml-auto pl-2 text-fg-3">{share(p.value, total)}</span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}
