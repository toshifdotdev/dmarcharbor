/**
 * policy-timeline.tsx — a domain's road to p=reject, as stations with dates.
 *
 * Each station is a change in the policy receivers saw published, read from
 * the reports themselves, oldest first. The line between stations is green
 * where the policy rose towards reject, amber where it fell back; the station
 * the domain is at now is the accent. With a single step it says "since" that
 * date. At most the last six changes are drawn; the caption says how many
 * earlier ones are not.
 *
 * Across the page from 640px when there are up to four stations; down the page
 * on a phone or with more, so a label like "p=quarantine" never runs into its
 * neighbour. Plain elements: it renders on the server, in the app and in the
 * client portal.
 */

import { clsx } from "clsx";
import type { CSSProperties } from "react";
import type { PolicyStep } from "@/lib/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RANK: Record<string, number> = { none: 0, quarantine: 1, reject: 2 };
const SHOWN = 6;

function dateLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

export function PolicyTimeline({ steps, className }: { steps: PolicyStep[]; className?: string }) {
  if (steps.length === 0) return null;
  const shown = steps.slice(-SHOWN);
  const hidden = steps.length - shown.length;
  const across = shown.length <= 4;
  const label = shown.map((s) => `p=${s.policy} from ${dateLabel(s.date)}`).join(", then ");

  return (
    <div className={clsx("flex flex-col gap-2", className)}>
      <ol
        aria-label={`Policy over time: ${label}`}
        className={clsx("flex flex-col", across && "sm:grid")}
        style={across ? ({ "--n": Math.max(shown.length, 2), gridTemplateColumns: "repeat(var(--n), minmax(0, 1fr))" } as CSSProperties) : undefined}
      >
        {shown.map((s, i) => {
          const next = shown[i + 1];
          const now = i === shown.length - 1;
          const rose = next ? (RANK[next.policy] ?? 0) >= (RANK[s.policy] ?? 0) : false;
          return (
            <li
              key={`${s.date}-${s.policy}`}
              className={clsx("relative flex min-w-0 gap-3 pb-4 last:pb-0", across && "sm:flex-col sm:gap-0 sm:pb-0")}
            >
              {next ? (
                <span
                  aria-hidden
                  className={clsx(
                    // Down the page: from this station to the next, under it.
                    "absolute bottom-0 left-[6px] top-[8px] w-[5px] rounded-full",
                    // Across the page: from this station to the next, beside it.
                    across && "sm:bottom-auto sm:left-[8px] sm:top-[6px] sm:h-[5px] sm:w-full",
                    rose ? "bg-done" : "bg-warn-mark",
                  )}
                />
              ) : null}
              <span
                aria-hidden
                className={clsx(
                  "relative z-[1] mt-0.5 block size-[17px] shrink-0 rounded-full bg-paper",
                  across && "sm:mt-0",
                  now ? "border-[3.5px] border-act" : "border-[3px] border-fg",
                )}
              />
              <span className={clsx("flex min-w-0 flex-col", across && "sm:mt-1.5")}>
                <span className={clsx("data break-words text-meta", now ? "font-semibold text-act" : "text-fg")}>p={s.policy}</span>
                <span className="tnum text-meta text-fg-3">{shown.length === 1 ? `since ${dateLabel(s.date)}` : dateLabel(s.date)}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {hidden > 0 ? (
        <p className="text-meta text-fg-3">
          {hidden} earlier change{hidden === 1 ? "" : "s"} not drawn.
        </p>
      ) : null}
    </div>
  );
}
