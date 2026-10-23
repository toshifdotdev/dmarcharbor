/**
 * setup-rail.tsx — where a new operator is on the way from "no account" to
 * "reports arriving", shown on every screen of that path.
 *
 * Six stops, always the same six, so the person can see the whole route on the
 * first screen and never wonders what is left: account, verified email,
 * workspace, first domain, records published, first report. The last two are
 * honest about time: publishing is something they do in their DNS, and the
 * first report is something receivers do, usually within 24 to 48 hours.
 *
 * The rule between stops fills as they advance. On arrival it grows from the
 * previous stop to this one (a short, one-off motion that says "you moved
 * forward"), and rests under reduced motion.
 */

import { clsx } from "clsx";
import type { CSSProperties } from "react";

export const SETUP_STOPS = [
  { id: "account", label: "Account" },
  { id: "email", label: "Verify email" },
  { id: "workspace", label: "Workspace" },
  { id: "domain", label: "First domain" },
  { id: "records", label: "Publish records" },
  { id: "report", label: "First report" },
] as const;

export type SetupStop = (typeof SETUP_STOPS)[number]["id"];

export function SetupRail({ current, className }: { current: SetupStop; className?: string }) {
  const at = SETUP_STOPS.findIndex((s) => s.id === current);
  const pct = (i: number) => (i / (SETUP_STOPS.length - 1)) * 100;
  return (
    <nav aria-label="Setup progress" className={clsx("w-full", className)}>
      <p className="sr-only">
        Step {at + 1} of {SETUP_STOPS.length}: {SETUP_STOPS[at].label}.
      </p>
      <div className="relative">
        {/* The rule, and its filled part up to the current stop. */}
        <div aria-hidden className="absolute left-[5px] right-[5px] top-[5px] h-px bg-rule-2">
          <div
            className="hb-rail-fill h-full bg-act"
            style={{ "--from": `${pct(Math.max(0, at - 1))}%`, "--to": `${pct(at)}%`, width: `${pct(at)}%` } as CSSProperties}
          />
        </div>
        <ol className="relative grid" style={{ gridTemplateColumns: `repeat(${SETUP_STOPS.length}, minmax(0, 1fr))` }}>
          {SETUP_STOPS.map((s, i) => {
            const done = i < at;
            const here = i === at;
            return (
              <li
                key={s.id}
                aria-current={here ? "step" : undefined}
                className={clsx("flex flex-col gap-2", i === 0 ? "items-start" : i === SETUP_STOPS.length - 1 ? "items-end text-right" : "items-center text-center")}
              >
                <span
                  aria-hidden
                  className={clsx(
                    "grid size-[11px] place-items-center rounded-full border-[1.5px] bg-paper",
                    done && "border-act bg-act",
                    here && "border-act [animation:hb-pulse-ring_1.8s_ease-out_1]",
                    !done && !here && "border-rule-2",
                  )}
                >
                  {here ? <span className="block size-[5px] rounded-full bg-act" /> : null}
                </span>
                <span
                  className={clsx(
                    "hidden text-meta font-semibold sm:block",
                    here ? "text-fg" : done ? "text-fg-2" : "text-fg-3",
                  )}
                >
                  {s.label}
                  {done ? <span className="sr-only"> (done)</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="mt-2 text-meta font-semibold text-fg sm:hidden" aria-hidden>
        Step {at + 1} of {SETUP_STOPS.length} · {SETUP_STOPS[at].label}
      </p>
    </nav>
  );
}
