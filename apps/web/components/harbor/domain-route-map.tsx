"use client";

/**
 * domain-route-map.tsx — one domain's measured mail, drawn as the home page's
 * transit map, from the API's figures only.
 *
 * Each sender in the aggregate reports is a line (domain-routes.ts decides
 * which). The lines join one trunk and stop at two stations, the two checks
 * DMARC rests on: SPF aligned and DKIM aligned. Mail that failed both failed
 * DMARC; it leaves the second station on the red line, and where that line
 * ends is what the published policy asks receivers to do with it: refuse it,
 * put it in spam, or (at p=none) deliver it anyway. A line with failures is
 * crossed out at that station; a sender whose every message failed is the
 * dashed red line itself.
 *
 * Silence is drawn as silence: a domain never measured gets closed, grey
 * stations on a dotted line and no sender at all, and a stale domain keeps its
 * last measured lines but nothing rides them.
 *
 * Drawn at the container's real width (measured after mount, as the volume
 * chart is) so labels stay 12 to 13px; below 720px the drawing scrolls inside
 * itself rather than shrinking. Messages ride the lines only after hydration,
 * only when motion is allowed, and only while the map is on screen.
 */

import { useEffect, useId, useRef, useState } from "react";
import { clsx } from "clsx";
import { length, q, rounded, SPEED, type Pt } from "./landing-geometry";
import { useRide } from "./landing-motion";
import { passPercent, type RouteLine } from "./domain-routes";

export type RouteMode = "live" | "stale" | "unmeasured";

/** Row pitch at the origins, and the gap between parallel lines on the trunk. */
const P = 46;
const TR = 11;
/** On a 45° run, parallel lines need 11·√2 vertically; the ends step by the rest. */
const STAG = TR * (Math.SQRT2 - 1);
const MIN_W = 720;
const DROP = 40;
const STROKE = 6;

type Outcome = "refuse" | "quarantine" | "deliver" | "unknown";

function outcomeOf(policy: string, testing: boolean): Outcome {
  const p = policy.trim().toLowerCase();
  const level = p === "reject" ? 2 : p === "quarantine" ? 1 : p === "none" ? 0 : -1;
  if (level < 0) return "unknown";
  const applied = testing && level > 0 ? level - 1 : level;
  return applied === 2 ? "refuse" : applied === 1 ? "quarantine" : "deliver";
}

function outcomeKind(policy: string, testing: boolean, outcome: Outcome): string {
  const p = policy.trim().toLowerCase();
  if (outcome === "refuse") return "refused at p=reject";
  if (outcome === "quarantine") return testing ? "spam folder: p=reject, t=y" : "spam folder at p=quarantine";
  if (outcome === "deliver") return testing && p === "quarantine" ? "delivered: p=quarantine, t=y" : "delivered anyway at p=none";
  return "no policy observed";
}

const fmt = (n: number) => n.toLocaleString("en-US");

interface Track {
  line: RouteLine | null;
  y: number;
  t: number;
  d: string;
  len: number;
  /** Where the line's own passing mail ends. */
  endX: number;
}

function geometry(lines: RouteLine[], width: number) {
  // A skeleton line stands in when nothing was measured, so the stations still
  // have something to sit on.
  const n = Math.max(1, lines.length);
  let W = Math.max(MIN_W, width);
  for (;;) {
    const LW = Math.min(250, Math.round(W * 0.27));
    const X0 = LW + 18;
    const Y0 = Math.max(28, 54 - (n - 1) * 17.5);
    const mid = (n - 1) / 2;
    const ys = Array.from({ length: n }, (_, i) => Y0 + i * P);
    const TC = Y0 + mid * P;
    const ts = Array.from({ length: n }, (_, i) => TC + (i - mid) * TR);
    const ds = ys.map((y, i) => ts[i] - y);
    const dmax = Math.max(0, ...ds.map((d) => Math.abs(d)));
    const J = X0 + 22 + dmax;
    const innerAbove = ds.reduce((m, d, i) => (d > 0.01 ? i : m), -1);
    const innerBelow = ds.findIndex((d) => d < -0.01);
    const step = ds.map((d, i) => (d > 0.01 ? innerAbove - i : d < -0.01 ? i - innerBelow : 0));
    const Js = step.map((s) => J + s * STAG);
    const A = Math.max(...Js) + 30;
    const END = W - 80;
    const S1 = A + (END - A) * 0.24;
    const S2 = A + (END - A) * 0.56;
    // Widen (and scroll inside) rather than let two station labels, or the
    // red line's label, run into each other.
    if ((S2 - S1 < 100 || S2 + 236 > W) && W < 1800) {
      W += 20;
      continue;
    }
    return { W, LW, X0, ys, ts, ds, Js, END, S1, S2, n };
  }
}

interface MapProps {
  domainName: string;
  lines: RouteLine[];
  mode: RouteMode;
  messages: number;
  failed: number;
  /** Aligned pass rates as the API sends them (percent), null when unmeasured. */
  spfRate: number | null;
  dkimRate: number | null;
  /** The policy the page header shows: none, quarantine, reject, or a word for none observed. */
  policy: string;
  /** t=y is published: the policy is applied one step softer. */
  testing: boolean;
}

/**
 * The map from 640px up; below that, the same lines as a strip map per
 * sender, which reads down a phone instead of across it. Both are in the
 * server HTML and CSS picks one, so nothing moves after hydration.
 */
export function DomainRouteMap(props: MapProps) {
  return (
    <>
      <div className="hidden sm:block">
        <WideMap {...props} />
      </div>
      <div className="sm:hidden">
        <CompactRoutes {...props} />
      </div>
    </>
  );
}

function WideMap({ domainName, lines, mode, messages, failed, spfRate, dkimRate, policy, testing }: MapProps) {
  const uid = `rm${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const wrap = useRef<HTMLDivElement | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(960);
  const moving = useRide(svg);

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const drawn = mode === "unmeasured" ? [] : lines;
  const outcome = outcomeOf(policy, testing);
  const { W, LW, X0, ys, ts, ds, Js, END, S1, S2, n } = geometry(drawn, width);

  const skeleton = drawn.length === 0;
  const forgedIdx = drawn.findIndex((l) => l.forged);
  const partial = drawn.some((l) => !l.forged && l.failed > 0);
  const hasRed = !skeleton && (forgedIdx >= 0 || partial);
  const yRed = forgedIdx >= 0 ? ts[forgedIdx] : ts[n - 1] + TR;
  const honestTs = drawn.flatMap((l, i) => (l.forged ? [] : [ts[i]]));
  const deliverRed = hasRed && outcome === "deliver";
  const xTurn = S2 + 26;
  const yBar = yRed + DROP;
  const xBar = xTurn + DROP + 60;
  const redTail: Pt[] = deliverRed
    ? [[END, yRed]]
    : [
        [xTurn, yRed],
        [xTurn + DROP, yBar],
        [xBar, yBar],
      ];

  const tracks: Track[] = (skeleton ? [null] : drawn).map((line, i) => {
    const y = ys[i];
    const t = ts[i];
    const d = ds[i];
    const head: Pt[] = Math.abs(d) < 0.01 ? [[X0, y]] : [[X0, y], [Js[i] - Math.abs(d), y], [Js[i], t]];
    const points: Pt[] = line?.forged ? [...head, [S2, t], ...redTail] : [...head, [END, t]];
    return { line, y, t, d: rounded(points, 14), len: length(points), endX: line?.forged ? S2 : END };
  });
  const emergent =
    hasRed && forgedIdx < 0
      ? (() => {
          const points: Pt[] = [[S2, yRed], ...redTail];
          return { d: rounded(points, 14), len: length(points) };
        })()
      : null;

  const capTop = ts[0] - 11;
  /** Every station label sits on one baseline, above the tallest capsule. */
  const labelY = ts[0] - 14;
  const s1Bottom = ts[n - 1] + 11;
  const s2Bottom = (hasRed ? Math.max(ts[n - 1], yRed) : ts[n - 1]) + 11;
  const inboxTop = honestTs.length ? honestTs[0] - 14 : ts[0] - 14;
  const inboxBottom = (deliverRed ? yRed : honestTs.length ? honestTs[honestTs.length - 1] : ts[0]) + 14;
  const inboxClosed = skeleton || (honestTs.length === 0 && !deliverRed);
  const bottomY = Math.max(
    ys[n - 1] + 26,
    hasRed && !deliverRed ? yBar + 54 : 0,
    deliverRed ? yRed + 56 : 0,
    s2Bottom + 8,
  );
  const H = Math.ceil(bottomY);
  const passed = Math.max(0, messages - failed);
  const live = mode === "live" && !skeleton;

  const summary = skeleton
    ? `Mail routes for ${domainName}: nothing measured. No sender has appeared in an aggregate report, so every check is not measured.`
    : `Mail routes for ${domainName}: ${drawn.length} line${drawn.length === 1 ? "" : "s"}, ${fmt(messages)} messages. ` +
      `SPF aligned ${passPercent(spfRate)}, DKIM aligned ${passPercent(dkimRate)}. ` +
      (failed > 0 ? `${fmt(failed)} failed DMARC, ${outcomeKind(policy, testing, outcome)}.` : "No message failed DMARC.");

  return (
    <div ref={wrap} className="relative overflow-x-auto" data-testid="route-map">
      <div className="relative" style={{ width: W, height: H }}>
        <svg ref={svg} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="absolute inset-0 block">
          {/* Lines */}
          {tracks.map((tr, i) =>
            tr.line ? (
              <path
                key={tr.line.key}
                id={`${uid}-l${i}`}
                d={tr.d}
                fill="none"
                stroke={tr.line.colour}
                strokeWidth={STROKE}
                strokeLinecap={tr.line.forged ? "butt" : "round"}
                strokeLinejoin="round"
                strokeDasharray={tr.line.forged ? "9 6" : undefined}
              />
            ) : (
              <path
                key="skeleton"
                d={tr.d}
                fill="none"
                stroke="var(--color-rule-2)"
                strokeWidth={3}
                strokeLinecap="round"
                strokeDasharray="0.01 7"
              />
            ),
          )}
          {emergent ? (
            <path
              id={`${uid}-red`}
              d={emergent.d}
              fill="none"
              stroke="var(--color-route-red)"
              strokeWidth={STROKE}
              strokeLinejoin="round"
              strokeDasharray="9 6"
            />
          ) : null}

          {/* Messages ride after hydration, only on a live feed. */}
          {moving && live
            ? tracks.flatMap((tr, i) => {
                if (!tr.line) return [];
                const dur = tr.len / SPEED;
                const count = tr.line.forged ? 1 : 2;
                return Array.from({ length: count }, (_, k) => (
                  <circle key={`${i}-${k}`} r={4} fill="var(--color-paper)" stroke={tr.line!.colour} strokeWidth={2.5}>
                    <animateMotion dur={`${q(dur)}s`} begin={`${q(-(dur / count) * k - i * 0.83)}s`} repeatCount="indefinite">
                      <mpath href={`#${uid}-l${i}`} />
                    </animateMotion>
                  </circle>
                ));
              })
            : null}
          {moving && live && emergent ? (
            <circle r={4} fill="var(--color-paper)" stroke="var(--color-route-red)" strokeWidth={2.5}>
              <animateMotion dur={`${q(emergent.len / SPEED)}s`} begin="-0.6s" repeatCount="indefinite">
                <mpath href={`#${uid}-red`} />
              </animateMotion>
            </circle>
          ) : null}

          {/* Origins */}
          {tracks.map((tr, i) => (
            <circle
              key={`o-${i}`}
              cx={X0}
              cy={tr.y}
              r={6.5}
              fill="var(--color-paper)"
              stroke={!tr.line ? "var(--color-rule-2)" : tr.line.forged ? "var(--color-route-red)" : "var(--color-fg)"}
              strokeWidth={3}
            />
          ))}

          {/* Stations: one capsule across every line that stops there. */}
          <Capsule x={S1} top={capTop} bottom={s1Bottom} w={22} closed={skeleton} />
          <Capsule x={S2} top={capTop} bottom={s2Bottom} w={22} closed={skeleton} />
          <Capsule x={END} top={inboxTop} bottom={inboxBottom} w={28} closed={inboxClosed} />

          {/* A line that lost mail is crossed out where it failed both checks. */}
          {!skeleton
            ? drawn.map((l, i) =>
                l.failed > 0 ? (
                  <path
                    key={`x-${l.key}`}
                    d={`M${q(S2 - 4)} ${q(ts[i] - 4)} L${q(S2 + 4)} ${q(ts[i] + 4)} M${q(S2 + 4)} ${q(ts[i] - 4)} L${q(S2 - 4)} ${q(ts[i] + 4)}`}
                    stroke="var(--color-fail)"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    fill="none"
                  />
                ) : null,
              )
            : null}

          {/* Where failing mail goes. */}
          {hasRed && !deliverRed ? (
            outcome === "unknown" ? (
              <Capsule x={xBar} top={yBar - 13} bottom={yBar + 13} w={14} closed />
            ) : (
              <rect x={q(xBar - 2.5)} y={q(yBar - 13)} width={5} height={26} rx={1.5} fill="var(--color-fail)" />
            )
          ) : null}

          <StationLabel x={S1} y={labelY} name="SPF" kind={skeleton ? "not measured" : `${passPercent(spfRate)} aligned`} />
          <StationLabel x={S2} y={labelY} name="DKIM" kind={skeleton ? "not measured" : `${passPercent(dkimRate)} aligned`} />
          <StationLabel
            x={END}
            y={labelY}
            name="Inbox"
            kind={skeleton ? "not measured" : passed > 0 ? `${fmt(passed)} passed DMARC` : "nothing passed DMARC"}
          />
          {hasRed ? (
            deliverRed ? (
              <text x={q(END + 14)} y={q(yRed + 32)} textAnchor="end" style={{ fontSize: 13 }}>
                <tspan fill="var(--color-fail)" fontWeight={700}>{`${fmt(failed)} failed DMARC`}</tspan>
                <tspan x={q(END + 14)} dy={16} fill="var(--color-fg-3)" style={{ fontSize: 12 }}>
                  {outcomeKind(policy, testing, outcome)}
                </tspan>
              </text>
            ) : (
              <text x={q(xTurn + DROP)} y={q(yBar + 32)} style={{ fontSize: 13 }}>
                <tspan fill="var(--color-fail)" fontWeight={700}>{`${fmt(failed)} failed DMARC`}</tspan>
                <tspan x={q(xTurn + DROP)} dy={16} fill="var(--color-fg-3)" style={{ fontSize: 12 }}>
                  {outcomeKind(policy, testing, outcome)}
                </tspan>
              </text>
            )
          ) : null}
        </svg>

        {/* Line labels are text, not drawing: they truncate, select and read aloud. */}
        <ol aria-label={`Senders on the map of ${domainName}`} className="absolute inset-y-0 left-0" style={{ width: LW }}>
          {tracks.map((tr) => (
            <li
              key={tr.line?.key ?? "none"}
              className="absolute left-0 flex h-[38px] w-full flex-col justify-center"
              style={{ top: q(tr.y - 20) }}
              title={tr.line ? `${tr.line.name}: ${tr.line.kind}, ${tr.line.sources} source${tr.line.sources === 1 ? "" : "s"}` : undefined}
            >
              {tr.line ? (
                <>
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span
                      className={clsx(
                        "min-w-0 shrink truncate text-ui font-bold",
                        tr.line.mono && "data",
                        tr.line.forged ? "text-fail" : "text-fg",
                      )}
                    >
                      {tr.line.name}
                    </span>
                    <span className="min-w-0 shrink-[2] truncate text-meta text-fg-3">{tr.line.kind}</span>
                  </span>
                  <span className="tnum truncate text-meta text-fg-3">
                    {fmt(tr.line.total)} message{tr.line.total === 1 ? "" : "s"}
                    {tr.line.failed > 0 ? (
                      <span className="font-semibold text-fail">
                        {" · "}
                        {tr.line.forged ? "all failed DMARC" : `${fmt(tr.line.failed)} failed DMARC`}
                      </span>
                    ) : null}
                  </span>
                </>
              ) : (
                <>
                  <span className="truncate text-ui font-bold text-fg-3">No sender measured</span>
                  <span className="truncate text-meta text-fg-4">
                    {mode === "unmeasured" ? "no aggregate report received" : "the reports name no sender"}
                  </span>
                </>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Capsule({ x, top, bottom, w, closed }: { x: number; top: number; bottom: number; w: number; closed?: boolean }) {
  return (
    <rect
      x={q(x - w / 2)}
      y={q(top)}
      width={w}
      height={q(Math.max(w, bottom - top))}
      rx={w / 2}
      fill="var(--color-paper)"
      stroke={closed ? "var(--color-rule-2)" : "var(--color-fg)"}
      strokeWidth={3}
    />
  );
}

function StationLabel({ x, y, name, kind }: { x: number; y: number; name: string; kind: string }) {
  return (
    <text x={q(x)} y={q(y - 24)} textAnchor="middle" style={{ fontSize: 13 }}>
      <tspan fill="var(--color-fg)" fontWeight={700}>
        {name}
      </tspan>
      <tspan x={q(x)} dy={16} fill="var(--color-fg-3)" style={{ fontSize: 12 }}>
        {kind}
      </tspan>
    </text>
  );
}

// ─── phones: one strip per sender ─────────────────────────────────────────────

/** Station positions across a strip, as percentages of its width. */
const C = { origin: 2.5, spf: 40, dkim: 65, bar: 80, end: 92 } as const;
const at = (v: number) => `${v}%`;

function share(part: number, total: number): string {
  return total > 0 ? passPercent((part / total) * 100) : "not measured";
}

function CompactRoutes({ domainName, lines, mode, failed, policy, testing }: MapProps) {
  const drawn = mode === "unmeasured" ? [] : lines;
  const outcome = outcomeOf(policy, testing);
  return (
    <div data-testid="route-strips">
      <div aria-hidden className="relative h-6 border-b border-rule text-meta font-bold text-fg">
        <span className="absolute -translate-x-1/2" style={{ left: at(C.spf) }}>
          SPF
        </span>
        <span className="absolute -translate-x-1/2" style={{ left: at(C.dkim) }}>
          DKIM
        </span>
        <span className="absolute right-0">Inbox</span>
      </div>
      <ol aria-label={`Senders on the map of ${domainName}`}>
        {drawn.length === 0 ? (
          <li className="border-b border-rule py-2.5">
            <p className="text-ui font-bold text-fg-3">No sender measured</p>
            <p className="text-meta text-fg-4">
              {mode === "unmeasured" ? "no aggregate report received" : "the reports name no sender"}
            </p>
            <svg aria-hidden width="100%" height={20} className="mt-1.5 block overflow-visible">
              <line x1={at(C.origin)} x2={at(C.end)} y1={10} y2={10} stroke="var(--color-rule-2)" strokeWidth={3} strokeLinecap="round" strokeDasharray="0.01 7" />
              {[C.origin, C.spf, C.dkim].map((x) => (
                <circle key={x} cx={at(x)} cy={10} r={5} fill="var(--color-paper)" stroke="var(--color-rule-2)" strokeWidth={2.5} />
              ))}
              <circle cx={at(C.end)} cy={10} r={7} fill="var(--color-paper)" stroke="var(--color-rule-2)" strokeWidth={3} />
            </svg>
            <StripNotes spf="not measured" dkim="not measured" end="" />
          </li>
        ) : (
          drawn.map((line) => (
            <li key={line.key} className="border-b border-rule py-2.5">
              <p className="flex min-w-0 items-baseline gap-1.5">
                <span className={clsx("min-w-0 shrink truncate text-ui font-bold", line.mono && "data", line.forged ? "text-fail" : "text-fg")}>
                  {line.name}
                </span>
                <span className="min-w-0 shrink-[2] truncate text-meta text-fg-3">{line.kind}</span>
              </p>
              <p className="tnum truncate text-meta text-fg-3">
                {fmt(line.total)} message{line.total === 1 ? "" : "s"}
                {line.failed > 0 ? (
                  <span className="font-semibold text-fail">
                    {" · "}
                    {line.forged ? "all failed DMARC" : `${fmt(line.failed)} failed DMARC`}
                  </span>
                ) : null}
              </p>
              <svg aria-hidden width="100%" height={20} className="mt-1.5 block overflow-visible">
                <line
                  x1={at(C.origin)}
                  x2={at(line.forged ? C.bar : C.end)}
                  y1={10}
                  y2={10}
                  stroke={line.colour}
                  strokeWidth={5}
                  strokeLinecap={line.forged ? "butt" : "round"}
                  strokeDasharray={line.forged ? "8 5" : undefined}
                />
                <circle cx={at(C.origin)} cy={10} r={5} fill="var(--color-paper)" stroke={line.forged ? "var(--color-route-red)" : "var(--color-fg)"} strokeWidth={2.5} />
                <circle cx={at(C.spf)} cy={10} r={5.5} fill="var(--color-paper)" stroke="var(--color-fg)" strokeWidth={3} />
                <circle cx={at(C.dkim)} cy={10} r={5.5} fill="var(--color-paper)" stroke="var(--color-fg)" strokeWidth={3} />
                {line.forged ? (
                  <line x1={at(C.bar)} x2={at(C.bar)} y1={2} y2={18} stroke="var(--color-fail)" strokeWidth={5} strokeLinecap="round" />
                ) : (
                  <circle cx={at(C.end)} cy={10} r={7.5} fill="var(--color-paper)" stroke="var(--color-fg)" strokeWidth={3} />
                )}
                {line.failed > 0 ? <CrossAt x={C.dkim} /> : null}
              </svg>
              <StripNotes
                spf={share(line.spfPass, line.total)}
                dkim={share(line.dkimPass, line.total)}
                end={line.forged ? "" : fmt(Math.max(0, line.total - line.failed))}
              />
            </li>
          ))
        )}
        {drawn.length > 0 && failed > 0 ? (
          <li className="py-2.5">
            <p className="text-ui font-bold text-fail">{`${fmt(failed)} failed DMARC`}</p>
            <p className="text-meta text-fg-3">{outcomeKind(policy, testing, outcome)}</p>
            <svg aria-hidden width="100%" height={20} className="mt-1.5 block overflow-visible">
              <line
                x1={at(C.dkim)}
                x2={at(outcome === "deliver" ? C.end : C.bar)}
                y1={10}
                y2={10}
                stroke="var(--color-route-red)"
                strokeWidth={5}
                strokeDasharray="8 5"
              />
              {outcome === "deliver" ? (
                <circle cx={at(C.end)} cy={10} r={7.5} fill="var(--color-paper)" stroke="var(--color-fg)" strokeWidth={3} />
              ) : outcome === "unknown" ? (
                <circle cx={at(C.bar)} cy={10} r={6} fill="var(--color-paper)" stroke="var(--color-rule-2)" strokeWidth={3} />
              ) : (
                <line x1={at(C.bar)} x2={at(C.bar)} y1={2} y2={18} stroke="var(--color-fail)" strokeWidth={5} strokeLinecap="round" />
              )}
              <circle cx={at(C.dkim)} cy={10} r={5.5} fill="var(--color-paper)" stroke="var(--color-fg)" strokeWidth={3} />
              <CrossAt x={C.dkim} />
            </svg>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

function CrossAt({ x }: { x: number }) {
  // Percent positions cannot be offset in SVG, so the cross is two short
  // lines nudged by a nested, translated svg at the station.
  return (
    <svg x={at(x)} y={10} overflow="visible">
      <path d="M-3.5 -3.5 L3.5 3.5 M3.5 -3.5 L-3.5 3.5" stroke="var(--color-fail)" strokeWidth={2.25} strokeLinecap="round" fill="none" />
    </svg>
  );
}

function StripNotes({ spf, dkim, end }: { spf: string; dkim: string; end: string }) {
  return (
    <div aria-hidden className="tnum relative mt-0.5 h-4 text-meta text-fg-3">
      <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: at(C.spf) }}>
        {spf}
      </span>
      <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: at(C.dkim) }}>
        {dkim}
      </span>
      {/* The last note is set against the right edge, so a long figure can
          never push the page sideways. */}
      {end ? <span className="absolute right-0 whitespace-nowrap">{end}</span> : null}
    </div>
  );
}
