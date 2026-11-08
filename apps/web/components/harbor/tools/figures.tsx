/**
 * figures.tsx — the drawings the free tools share, in the Routes language.
 *
 *   PolicyLine    p=none to p=reject as a strip map: green up to the policy
 *                 a record publishes, that station an accent capsule, ahead
 *                 grey; dotted with closed stations when there is no policy.
 *   StationList   a vertical line with one station per item: open (ink) when
 *                 the item is there, closed (hollow grey) when it is not, a
 *                 green filled station for a check passed, a red bar for one
 *                 failed.
 *   Findings      the scanner's own findings, each a state word with its mark.
 *
 * HTML, not SVG, so the labels keep their size on a phone. No station sits at
 * a negative offset: every mark is inside the box that draws it.
 */

import { clsx } from "clsx";
import type { ReactNode } from "react";
import { StateWord } from "../ops-parts";
import type { ToolIssue } from "./scan";

const STOPS = [
  { tag: "p=none", kind: "watch only" },
  { tag: "p=quarantine", kind: "failing mail to spam" },
  { tag: "p=reject", kind: "failing mail refused" },
] as const;

export function policyStage(policy: string | null | undefined): 0 | 1 | 2 | null {
  const p = (policy ?? "").trim().toLowerCase();
  return p === "none" ? 0 : p === "quarantine" ? 1 : p === "reject" ? 2 : null;
}

export function PolicyLine({ policy, note }: { policy: string | null; note?: ReactNode }) {
  const stage = policyStage(policy);
  return (
    <figure className="m-0" data-testid="tool-policy-line" data-stage={stage ?? "none"}>
      <div
        role="img"
        aria-label={stage === null ? "No policy published." : `Published policy: ${STOPS[stage].tag}, ${STOPS[stage].kind}.`}
        className="relative h-[19px]"
      >
        {stage === null ? (
          <span aria-hidden className="absolute left-[9px] right-[9px] top-[8px] border-t-[3px] border-dotted border-rule-2" />
        ) : (
          <>
            <span aria-hidden className="absolute left-[9px] right-[9px] top-[7px] h-[5px] rounded-full bg-rule" />
            {stage > 0 ? (
              <span
                aria-hidden
                className="absolute left-[9px] top-[7px] h-[5px] rounded-full bg-done"
                style={{ width: stage === 1 ? "calc(50% - 9px)" : "calc(100% - 18px)" }}
              />
            ) : null}
          </>
        )}
        {STOPS.map((stop, i) => {
          const here = stage === i;
          const passed = stage !== null && i < stage;
          const width = here ? 30 : 19;
          const position = i === 0 ? { left: 0 } : i === 1 ? { left: `calc(50% - ${width / 2}px)` } : { right: 0 };
          return (
            <span
              key={stop.tag}
              aria-hidden
              style={{ ...position, width }}
              className={clsx(
                "absolute top-0 h-[19px] rounded-full border-[3px]",
                here ? "border-act bg-paper" : passed ? "border-done bg-done" : "border-rule-2 bg-paper",
              )}
            />
          );
        })}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {STOPS.map((stop, i) => (
          <p key={stop.tag} className={clsx("min-w-0", i === 1 && "text-center", i === 2 && "text-right")}>
            <span className={clsx("data block text-[13.5px] font-semibold sm:text-[14.5px]", stage === i ? "text-act" : "text-fg")}>
              {stop.tag}
            </span>
            <span className="mt-0.5 block text-[13px] leading-[1.35] text-fg-4 sm:text-[14px]">{stage === i ? "published" : stop.kind}</span>
          </p>
        ))}
      </div>
      {note ? <figcaption className="mt-3 text-[14px] leading-[1.5] text-fg-2">{note}</figcaption> : null}
    </figure>
  );
}

export type StationState = "open" | "closed" | "passed" | "failed";

export interface StationItem {
  key: string;
  state: StationState;
  name: ReactNode;
  /** The lighter kind or value beside the name. */
  meta?: ReactNode;
  children?: ReactNode;
}

export function StationList({ items, label, className }: { items: StationItem[]; label: string; className?: string }) {
  return (
    <ol aria-label={label} className={clsx("m-0 list-none p-0", className)}>
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <li key={item.key} data-station={item.state} className={clsx("relative pl-9", last ? "pb-0" : "pb-6")}>
            {last ? null : <span aria-hidden className="absolute bottom-0 left-[7px] top-[10px] w-[5px] bg-fg" />}
            {item.state === "failed" ? (
              // The refused terminus: a short red bar across the line.
              <span aria-hidden className="absolute left-0 top-[7px] h-[5px] w-[19px] rounded-[1.5px] bg-fail" />
            ) : (
              <span
                aria-hidden
                className={clsx(
                  "absolute left-0 top-0 size-[19px] rounded-full border-[3px]",
                  item.state === "open" && "border-fg bg-paper",
                  item.state === "closed" && "border-rule-2 bg-paper",
                  item.state === "passed" && "border-done bg-done",
                )}
              />
            )}
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 leading-[19px]">
              <span className={clsx("text-[15.5px] font-bold", item.state === "closed" ? "text-fg-2" : "text-fg")}>{item.name}</span>
              {item.meta ? <span className="min-w-0 break-all text-[14px] text-fg-4">{item.meta}</span> : null}
            </p>
            {item.children ? <div className="mt-1.5 text-[14.5px] leading-[1.5] text-fg-2">{item.children}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}

const SEVERITY = {
  error: { shape: "diamond", tone: "fail", word: "Fix" },
  warning: { shape: "ring", tone: "warn", word: "Check" },
  info: { shape: "dot", tone: "ink", word: "Note" },
} as const;

/** The scanner's findings for one record, most serious first. Empty says so. */
export function Findings({ issues, none }: { issues: ToolIssue[]; none: ReactNode }) {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  const sorted = issues.slice().sort((a, b) => rank[a.severity] - rank[b.severity]);
  if (sorted.length === 0) return <p className="text-[15px] text-fg-2">{none}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-4 p-0" data-testid="tool-findings">
      {sorted.map((issue) => {
        const s = SEVERITY[issue.severity];
        return (
          <li key={issue.code} data-severity={issue.severity}>
            <p className="flex flex-wrap items-baseline gap-x-2.5">
              <StateWord shape={s.shape} tone={s.tone} className="text-[14px]!">
                {s.word}
              </StateWord>
              <span className="text-[15.5px] font-bold text-fg">{issue.title}</span>
            </p>
            <p className="mt-1 max-w-[64ch] text-[14.5px] leading-[1.5] text-fg-2">{issue.message}</p>
            {issue.recommendation ? (
              <p className="mt-1 max-w-[64ch] text-[14.5px] leading-[1.5] text-fg-2">
                <span className="font-semibold text-fg">What to do:</span> {issue.recommendation}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Findings for one record, without the duplicates a notice and an issue can share. */
export function issuesFor(prefix: string, ...lists: Array<ToolIssue[] | undefined>): ToolIssue[] {
  const seen = new Set<string>();
  const out: ToolIssue[] = [];
  for (const list of lists) {
    for (const issue of list ?? []) {
      if (!issue.code.startsWith(prefix) || seen.has(issue.code)) continue;
      seen.add(issue.code);
      out.push(issue);
    }
  }
  return out;
}

/**
 * A record set large, allowed to wrap after each ";" and space rather than
 * inside a tag, so "aspf=s" never splits as "aspf / =s". A single term longer
 * than the line still wraps (overflow-wrap: anywhere on the caller).
 *
 * `at` changes where it may wrap: a domain name wraps after its dots, so
 * "oracle.com" never splits as "oracle.co / m".
 */
export function Breakable({ text, at = /(?<=[;\s,])/ }: { text: string; at?: RegExp }) {
  const parts = text.split(at);
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 ? <wbr /> : null}
        </span>
      ))}
    </>
  );
}
