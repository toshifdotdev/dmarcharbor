/**
 * setup-rail.tsx — where a new operator is on the way from "no account" to
 * "reports arriving", drawn as one line with six stations.
 *
 * Always the same six, so the person sees the whole route on the first screen
 * and never wonders what is left: account, verified email, workspace, first
 * domain, records published, first report. The last two are honest about
 * time: publishing is something done at the domain's DNS, and the first
 * report is something receivers do, usually within 24 to 48 hours.
 *
 * The line is built (solid) up to the station you are at, dashed for the next
 * step (ready, not yet taken) and unbuilt after it. Closed stations are grey.
 * Two drawings of the same route:
 *
 *   horizontal  a strip above the content, labels under the stations (the
 *               default; the first-domain screens use it inside the app).
 *   vertical    the route beside a form, with what each stop involves.
 *
 * `SetupLayout` puts a form beside the vertical route from 900px up and the
 * strip above it below that; only one is ever displayed, so assistive tech
 * hears one "Setup progress".
 */

import { clsx } from "clsx";
import type { CSSProperties, ReactNode } from "react";
import { DrawOnView } from "./draw-on-view";
import s from "./setup-rail.module.css";

export const SETUP_STOPS = [
  { id: "account", label: "Account", kind: "Your name, your email and a password." },
  { id: "email", label: "Verify email", kind: "Open the link we send. It signs you in." },
  { id: "workspace", label: "Workspace", kind: "Your agency or MSP, and the terms it runs under." },
  { id: "domain", label: "First domain", kind: "A client, and one domain that sends its mail." },
  { id: "records", label: "Publish records", kind: "TXT records at that domain's DNS, by you or the client's IT." },
  { id: "report", label: "First report", kind: "Receivers send it, usually within 24 to 48 hours." },
] as const;

export type SetupStop = (typeof SETUP_STOPS)[number]["id"];

const N = SETUP_STOPS.length;
const STEP_MS = 90;

type Seg = "built" | "planned" | "unbuilt";

/** The segment from stop i to stop i + 1, with the current stop at `at`. */
function segment(i: number, at: number): Seg {
  if (i + 1 <= at) return "built";
  if (i === at) return "planned";
  return "unbuilt";
}

function StopMark({ i, at, vertical }: { i: number; at: number; vertical?: boolean }) {
  const state = i < at ? s.done : i === at ? s.here : s.ahead;
  const terminus = i === N - 1;
  return (
    <span
      aria-hidden
      className={clsx(s.stop, state, terminus && (vertical ? s.termV : s.termH))}
      style={i === at ? ({ "--d": `${Math.max(0, at) * STEP_MS + 120}ms` } as CSSProperties) : undefined}
    />
  );
}

export function SetupRail({
  current,
  className,
  orientation = "horizontal",
}: {
  current: SetupStop;
  className?: string;
  orientation?: "horizontal" | "vertical";
}) {
  const at = Math.max(0, SETUP_STOPS.findIndex((stop) => stop.id === current));
  return orientation === "vertical" ? (
    <VerticalRail at={at} className={className} />
  ) : (
    <HorizontalRail at={at} className={className} />
  );
}

function HorizontalRail({ at, className }: { at: number; className?: string }) {
  return (
    <nav aria-label="Setup progress" data-draw className={clsx("w-full", className)}>
      <DrawOnView />
      <p className="sr-only">
        Step {at + 1} of {N}: {SETUP_STOPS[at].label}.
      </p>
      {/* Stations sit at the left of each column, labels hang under them the
          way the map labels a line; the terminus column is as wide as its label. */}
      <ol className="grid" style={{ gridTemplateColumns: `repeat(${N - 1}, minmax(0, 1fr)) auto` }}>
        {SETUP_STOPS.map((stop, i) => {
          const done = i < at;
          const here = i === at;
          const seg = i < N - 1 ? segment(i, at) : null;
          return (
            <li key={stop.id} aria-current={here ? "step" : undefined} className="relative min-w-0">
              {seg ? (
                <span
                  aria-hidden
                  className={clsx(s.segH, s[seg], "left-[9px] -right-[9px] top-[9.5px]")}
                  style={{ "--d": `${i * STEP_MS}ms` } as CSSProperties}
                />
              ) : null}
              <span aria-hidden className="relative z-[1] flex h-6 w-[18px] items-center justify-center">
                <StopMark i={i} at={at} />
              </span>
              <span
                className={clsx(
                  "mt-2 hidden pr-3 text-meta font-semibold leading-[1.3] sm:block",
                  here ? "text-fg" : done ? "text-fg-2" : "text-fg-4",
                )}
              >
                {stop.label}
                {done ? <span className="sr-only"> (done)</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      <p aria-hidden className="mt-2 text-meta text-fg-4 sm:hidden">
        <span className="font-semibold text-fg">{SETUP_STOPS[at].label}</span>
        <span className="tnum">
          {" "}
          step {at + 1} of {N}
        </span>
      </p>
    </nav>
  );
}

function VerticalRail({ at, className }: { at: number; className?: string }) {
  return (
    <nav aria-label="Setup progress" data-draw className={clsx("w-full", className)}>
      <DrawOnView />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-rule pb-3">
        <p className="text-[15px] font-bold tracking-[-0.005em] text-fg">Your route</p>
        <p className="text-ui text-fg-4">from sign-up to the first report</p>
      </div>
      <p className="sr-only">
        Step {at + 1} of {N}: {SETUP_STOPS[at].label}.
      </p>
      <ol className="mt-6">
        {SETUP_STOPS.map((stop, i) => {
          const done = i < at;
          const here = i === at;
          const seg = i < N - 1 ? segment(i, at) : null;
          return (
            <li
              key={stop.id}
              aria-current={here ? "step" : undefined}
              className="relative grid grid-cols-[24px_minmax(0,1fr)] gap-x-4 pb-7 last:pb-0"
            >
              {seg ? (
                <span
                  aria-hidden
                  className={clsx(s.segV, s[seg], "left-[9.5px] top-[9px] h-full")}
                  style={{ "--d": `${i * STEP_MS}ms` } as CSSProperties}
                />
              ) : null}
              <span aria-hidden className="relative z-[1] flex h-[18px] items-center justify-center">
                <StopMark i={i} at={at} vertical />
              </span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-baseline gap-x-2.5 leading-[18px]">
                  <span className={clsx("text-body font-bold", here ? "text-fg" : done ? "text-fg-2" : "text-fg-3")}>
                    {stop.label}
                  </span>
                  {here ? <span className="text-meta font-semibold text-fg">You are here</span> : null}
                  {done ? <span className="text-meta font-semibold text-ok">Done</span> : null}
                </p>
                <p className={clsx("mt-1 max-w-[30rem] text-ui", here ? "text-fg-2" : "text-fg-4")}>{stop.kind}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * A first-run form beside its route: the vertical route on the right from
 * 900px, the strip above the form below that. The form column keeps the
 * sign-in column's width so the fields read the same on every auth screen.
 */
export function SetupLayout({ current, children }: { current: SetupStop; children: ReactNode }) {
  return (
    <div className="grid gap-x-16 min-[900px]:grid-cols-[minmax(0,440px)_minmax(0,1fr)] min-[1100px]:gap-x-24">
      <div className="mx-auto w-full min-w-0 max-w-[440px] min-[900px]:mx-0 min-[900px]:max-w-none">
        <SetupRail current={current} className="mb-10 min-[900px]:hidden" />
        {children}
      </div>
      <div className="hidden min-w-0 pt-1 min-[900px]:block">
        <SetupRail current={current} orientation="vertical" />
      </div>
    </div>
  );
}
