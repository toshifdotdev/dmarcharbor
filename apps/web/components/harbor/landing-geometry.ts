/**
 * landing-geometry.ts — the line drawing shared by the home page's maps.
 *
 * Every coordinate is rounded to two decimals before it reaches markup, so the
 * server and the browser print the same path strings and hydration has
 * nothing to disagree about.
 */

export type Pt = readonly [number, number];

export const q = (n: number) => Math.round(n * 100) / 100;

/** A polyline with each corner rounded to radius r, as an SVG path. */
export function rounded(points: readonly Pt[], r: number): string {
  let d = `M${q(points[0][0])} ${q(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const l1 = Math.hypot(x1 - x0, y1 - y0);
    const l2 = Math.hypot(x2 - x1, y2 - y1);
    const k = Math.min(r, l1 / 2, l2 / 2);
    const ax = x1 - ((x1 - x0) / l1) * k;
    const ay = y1 - ((y1 - y0) / l1) * k;
    const bx = x1 + ((x2 - x1) / l2) * k;
    const by = y1 + ((y2 - y1) / l2) * k;
    d += ` L${q(ax)} ${q(ay)} Q${q(x1)} ${q(y1)} ${q(bx)} ${q(by)}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d} L${q(lx)} ${q(ly)}`;
}

/** The length of a polyline, for timing the messages that ride it. */
export function length(points: readonly Pt[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return n;
}

/** Map units per second for a riding message. */
export const SPEED = 92;
