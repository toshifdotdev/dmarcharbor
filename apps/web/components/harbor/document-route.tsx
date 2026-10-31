/**
 * document-route.tsx — the drawings in the documents that leave the product:
 * the shared report, the client portal and the prospect check.
 *
 *   MailRoute    how one domain's mail was handled, as a strip map with a row
 *                per source. Each source's line runs from its origin through
 *                the DMARC check and the domain's policy to the inbox. Mail
 *                that failed is the dashed red line, and it ends where the
 *                published policy sends it: a red bar (refused), the spam
 *                folder, or the inbox anyway when nothing stops it.
 *   PolicyStrip  where a domain stands on the way to blocking forgeries:
 *                monitor, spam, block. A step that is asked for but not taken
 *                (an open approval) is drawn dashed.
 *   StateMark    the shape that travels with every state word, so nothing is
 *                said in colour alone.
 *
 * Measured figures only: every number on a row is a count the payload carries.
 * The drawing is schematic (lines are not drawn to scale), and the caller's
 * caption says so. The colour of a line names its source, the same colour in
 * the list below the figure, and never decorates anything else.
 *
 * Server components with no state: the HTML is the final, still drawing, and
 * it prints exactly as it looks.
 */

import type { CSSProperties, ReactNode } from "react";
import s from "./document-route.module.css";

const n = (v: number) => v.toLocaleString("en-GB");
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** The five sender lines, in the order sources are given them. */
const LINE = [
  "var(--color-route-blue)",
  "var(--color-route-orange)",
  "var(--color-route-green)",
  "var(--color-route-yellow)",
  "var(--color-route-purple)",
] as const;
/** Several small sources drawn as one line: ink, so it is never read as a sender colour. */
const OTHERS = "var(--color-fg-4)";
export const FAILED_LINE = "var(--color-fail)";

/** Where mail that fails ends, decided by the domain's published policy. */
export type PolicyOutcome = "reject" | "quarantine" | "none" | "missing" | "unknown";

/** One source of mail sent as the domain, with its measured counts. */
export interface Flow {
  key: string;
  name: string;
  /** The name is an identifier (an IP address, a domain): set in the data face. */
  mono?: boolean;
  passed: number;
  failed: number;
}

export interface RouteRow {
  key: string;
  name: ReactNode;
  mono?: boolean;
  kind: string;
  colour: string;
  failing?: boolean;
}

/**
 * Rows for the figure, and the colour each source was given, so a list or a
 * table below the figure can mark its rows with the same line.
 *
 * Passing mail gets one line per source, largest first; past `max` lines the
 * smallest are drawn together. Every failed message, whichever source sent
 * it, rides the one dashed red line: that is the mail the policy acts on.
 */
export function routeModel(
  flows: Flow[],
  noun: [string, string] = ["source", "sources"],
  max = 5,
): { rows: RouteRow[]; colourOf: Map<string, string> } {
  const passing = flows
    .filter((f) => f.passed > 0)
    .sort((a, b) => b.passed - a.passed || a.name.localeCompare(b.name));
  const keep = passing.length > max ? passing.slice(0, max - 1) : passing;
  const rest = passing.length > max ? passing.slice(max - 1) : [];
  const colourOf = new Map<string, string>();
  const rows: RouteRow[] = keep.map((f, i) => {
    colourOf.set(f.key, LINE[i]!);
    return {
      key: f.key,
      name: f.name,
      mono: f.mono,
      kind: `${n(f.passed)} ${plural(f.passed, "message", "messages")} passed`,
      colour: LINE[i]!,
    };
  });
  if (rest.length > 0) {
    const total = rest.reduce((sum, f) => sum + f.passed, 0);
    for (const f of rest) colourOf.set(f.key, OTHERS);
    rows.push({
      key: "others",
      name: `${rest.length} other ${noun[1]}`,
      kind: `${n(total)} ${plural(total, "message", "messages")} passed`,
      colour: OTHERS,
    });
  }
  const failing = flows.filter((f) => f.failed > 0);
  const failed = failing.reduce((sum, f) => sum + f.failed, 0);
  for (const f of failing) if (f.passed === 0) colourOf.set(f.key, FAILED_LINE);
  if (failed > 0) {
    rows.push({
      key: "failed",
      name: "Failed DMARC",
      kind: `${n(failed)} ${plural(failed, "message", "messages")} from ${failing.length} ${plural(failing.length, noun[0], noun[1])}`,
      colour: FAILED_LINE,
      failing: true,
    });
  }
  return { rows, colourOf };
}

// Where the stops sit along a track, as fractions of its length.
const A = 0.4; // the DMARC check
const B = 0.7; // the domain's policy
const R = 0.86; // refused or spam, just past the policy
const END = 1; // the inbox

const POLICY_KIND: Record<PolicyOutcome, string> = {
  reject: "p=reject",
  quarantine: "p=quarantine",
  none: "p=none",
  missing: "none published",
  unknown: "not read yet",
};

const FAIL_OUT: Record<PolicyOutcome, string> = {
  reject: "refused",
  quarantine: "sent to spam",
  none: "delivered anyway",
  missing: "delivered anyway",
  unknown: "policy not read",
};

export function MailRoute({
  rows,
  outcome,
  name,
  meta,
  caption,
  testId,
}: {
  rows: RouteRow[];
  outcome: PolicyOutcome;
  /** The figure head: bold name (the domain) and a lighter line (the period). */
  name: ReactNode;
  meta?: ReactNode;
  caption: ReactNode;
  testId?: string;
}) {
  const closed = outcome === "missing" || outcome === "unknown";
  return (
    <figure className={`${s.figure} ${s.route}`} data-testid={testId}>
      <div className={s.figHead}>
        <span className={s.figName}>{name}</span>
        {meta ? <span className={s.figMeta}>{meta}</span> : null}
      </div>
      <div className={s.scale} aria-hidden>
        <div className={s.scaleTrack}>
          <span className={s.stop} style={at(A)}>
            <b>DMARC check</b>
            <span>SPF or DKIM, aligned</span>
          </span>
          <span className={s.stop} style={at(B)} data-closed={closed ? "" : undefined}>
            <b>Your policy</b>
            <span>{POLICY_KIND[outcome]}</span>
          </span>
          <span className={s.stop} data-end="">
            <b>Inbox</b>
            <span>delivered</span>
          </span>
        </div>
      </div>
      <ol className={s.rows}>
        {rows.map((row) => (
          <li
            key={row.key}
            className={s.row}
            data-failing={row.failing ? "" : undefined}
            style={{ "--line": row.colour } as CSSProperties}
          >
            <p className={s.who}>
              <span className={s.name} data-mono={row.mono ? "" : undefined}>
                {row.name}
              </span>
              <span className={s.kind}>{row.kind}</span>
            </p>
            <Track failing={Boolean(row.failing)} outcome={outcome} />
            <p className={s.out} data-tone={row.failing ? "fail" : "ok"}>
              <b>{row.failing ? "Failed" : "Passed"}</b>
              {row.failing ? <span>{FAIL_OUT[outcome]}</span> : null}
            </p>
          </li>
        ))}
      </ol>
      <figcaption className={s.caption}>{caption}</figcaption>
    </figure>
  );
}

function at(p: number): CSSProperties {
  return { "--p": p } as CSSProperties;
}

function Seg({ from, to }: { from: number; to: number }) {
  return <span className={s.seg} style={{ "--from": from, "--to": to } as CSSProperties} />;
}

function Track({ failing, outcome }: { failing: boolean; outcome: PolicyOutcome }) {
  const closed = outcome === "missing" || outcome === "unknown";
  // Failed mail goes on to the inbox only when nothing in the policy stops it.
  const delivered = !failing || outcome === "none" || outcome === "missing";
  const turned = failing && (outcome === "reject" || outcome === "quarantine");
  return (
    <div className={s.track} aria-hidden>
      <Seg from={0} to={A} />
      <Seg from={A} to={B} />
      {delivered ? <Seg from={B} to={END} /> : turned ? <Seg from={B} to={R} /> : null}
      <span className={`${s.at} ${s.origin}`} style={at(0)} />
      <span className={`${s.at} ${s.station}`} style={at(A)}>
        {failing ? (
          <svg viewBox="0 0 8 8" className={s.cross}>
            <path d="M1 1 7 7M7 1 1 7" stroke="var(--color-fail)" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        ) : null}
      </span>
      <span className={`${s.at} ${s.station}`} style={at(B)} data-closed={closed ? "" : undefined} />
      {delivered ? <span className={`${s.at} ${s.terminus}`} style={at(END)} /> : null}
      {turned && outcome === "reject" ? <span className={`${s.at} ${s.bar}`} style={at(R)} /> : null}
      {turned && outcome === "quarantine" ? <span className={`${s.at} ${s.spam}`} style={at(R)} /> : null}
    </div>
  );
}

/** A short length of a source's line, so a row in a list or table points at its line in the drawing. */
export function LineKey({ colour }: { colour: string | undefined }) {
  if (!colour) return <span aria-hidden className="inline-block w-5 shrink-0" />;
  const failed = colour === FAILED_LINE;
  return (
    <span
      aria-hidden
      className="inline-block h-[5px] w-5 shrink-0 print:[print-color-adjust:exact]"
      style={
        failed
          ? { background: `repeating-linear-gradient(90deg, ${colour} 0 6px, transparent 6px 10px)` }
          : { background: colour, borderRadius: 3 }
      }
    />
  );
}

/* ── Policy strip ─────────────────────────────────────────────────────── */

/** 0 monitor only (p=none), 1 send to spam (p=quarantine), 2 block (p=reject); null when not read. */
export type Stage = 0 | 1 | 2 | null;

export function policyStage(policy: string | null | undefined): Stage {
  const p = (policy ?? "").toLowerCase();
  return p === "none" ? 0 : p === "quarantine" ? 1 : p === "reject" ? 2 : null;
}

/** The p= tag of a DMARC record, as a stage. */
export function recordStage(record: string | null | undefined): Stage {
  const m = /(?:^|;)\s*p\s*=\s*([a-z]+)/i.exec(record ?? "");
  return policyStage(m?.[1] ?? null);
}

const STAGE_WORDS = ["Monitor", "Spam", "Block"] as const;

/** The three station names, set over a column of strips. */
export function PolicyScale({ at: stage = null, className }: { at?: Stage; className?: string }) {
  return (
    <div className={`${s.pScale} ${className ?? ""}`} aria-hidden>
      {STAGE_WORDS.map((word, i) => (
        <span key={word} data-here={stage === i ? "" : undefined}>
          {word}
        </span>
      ))}
    </div>
  );
}

/**
 * `at` is where the domain is; `to`, when given, is a step asked for and not
 * yet taken, drawn dashed. `scale` sets the three station names above.
 */
export function PolicyStrip({ at: stage, to, scale, className }: { at: Stage; to?: Stage; scale?: boolean; className?: string }) {
  const here = stage ?? 0;
  const plan = stage !== null && to !== null && to !== undefined && to > stage ? to : null;
  return (
    <div className={className} aria-hidden>
      {scale ? <PolicyScale at={stage} className="mb-1.5" /> : null}
      <div
        className={s.policy}
        data-void={stage === null ? "" : undefined}
        style={{ "--at": stage === null ? 0 : here / 2, "--to": plan === null ? 0 : plan / 2 } as CSSProperties}
      >
        {stage ? <span className={s.travel} /> : null}
        {plan !== null ? <span className={s.plan} /> : null}
        {[0, 1, 2].map((p) => (
          <span
            key={p}
            className={s.pStop}
            style={{ "--p": p / 2 } as CSSProperties}
            data-reached={stage !== null && p <= stage ? "" : undefined}
            data-here={stage === p ? "" : undefined}
          />
        ))}
      </div>
    </div>
  );
}

/* ── State marks ──────────────────────────────────────────────────────── */

export type MarkTone = "ok" | "warn" | "fail" | "void";
/** square aligned, diamond blocking, ring unverified, half stale, hatch not measured. */
export type MarkShape = "square" | "diamond" | "ring" | "half" | "hatch";

const MARK_FILL: Record<MarkTone, string> = {
  ok: "var(--color-ok)",
  warn: "var(--color-warn-mark)",
  fail: "var(--color-fail)",
  void: "var(--color-void)",
};

export function StateMark({ shape, tone, size = 10 }: { shape: MarkShape; tone: MarkTone; size?: number }) {
  const c = MARK_FILL[tone];
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden className="shrink-0">
      {shape === "square" ? <rect x="0.5" y="0.5" width="9" height="9" fill={c} /> : null}
      {shape === "diamond" ? <path d="M5 0 10 5 5 10 0 5Z" fill={c} /> : null}
      {shape === "ring" ? <circle cx="5" cy="5" r="3.9" fill="none" stroke={c} strokeWidth="2" /> : null}
      {shape === "half" ? (
        <>
          <rect x="1" y="1" width="8" height="8" fill="none" stroke={c} strokeWidth="1.5" />
          <rect x="1" y="5" width="8" height="4" fill={c} />
        </>
      ) : null}
      {shape === "hatch" ? (
        <>
          <rect x="1" y="1" width="8" height="8" fill="none" stroke={c} strokeWidth="1.2" />
          <path d="M1 5 5 1M1 9 9 1M5 9 9 5" stroke={c} strokeWidth="1.2" />
        </>
      ) : null}
    </svg>
  );
}

const WORD_TONE: Record<MarkTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  fail: "text-fail",
  void: "text-void",
};

/** A state word with its shape, e.g. a verdict. */
export function StateWord({
  shape,
  tone,
  children,
  size = "md",
  className,
}: {
  shape: MarkShape;
  tone: MarkTone;
  children: ReactNode;
  size?: "md" | "lg";
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center font-semibold ${WORD_TONE[tone]} ${size === "lg" ? "gap-2.5 text-[17px] leading-[22px]" : "gap-2 text-ui"} ${className ?? ""}`}
    >
      <StateMark shape={shape} tone={tone} size={size === "lg" ? 12 : 10} />
      <span>{children}</span>
    </span>
  );
}
