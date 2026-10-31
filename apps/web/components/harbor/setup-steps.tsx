/**
 * setup-steps.tsx — a domain's setup steps, as stations on one line.
 *
 * The steps, their titles, statuses and detail are the API's progress model
 * (GET onboarding), rendered verbatim; this file only draws them. The line is
 * built between steps that are done, dashed into the next step (ready, not
 * taken) and unbuilt elsewhere. Every station carries its state as a word:
 *
 *   done      Done       a station the line has reached
 *   next      Next       the first step still to do, with the message dot
 *   pending   To do      to do, after the next one
 *   blocked   Waiting    waits on a step before it (DNS, or reports)
 *   optional  Optional   a smaller, dashed station off the critical path
 *
 * `data-step` and `data-step-status` are the clickthrough suite's hooks.
 */

import Link from "next/link";
import { clsx } from "clsx";
import { Fragment, type CSSProperties } from "react";
import type { OnboardingState } from "@/lib/types";
import { DrawOnView } from "./draw-on-view";
import s from "./setup-rail.module.css";

type Step = OnboardingState["steps"][number];

const STEP_MS = 90;

const WORD: Record<Step["status"], string> = {
  done: "Done",
  pending: "To do",
  blocked: "Waiting",
  optional: "Optional",
};

function segment(from: Step, to: Step, nextId: string | null): "built" | "planned" | "unbuilt" {
  if (from.status === "done" && to.status === "done") return "built";
  if (to.id === nextId) return "planned";
  return "unbuilt";
}

const STATION: Record<Step["status"], string | undefined> = {
  done: s.done,
  pending: s.todo,
  blocked: s.closed,
  optional: s.optional,
};

function Station({ step, isNext, delay }: { step: Step; isNext: boolean; delay?: number }) {
  return (
    <span
      aria-hidden
      className={clsx(s.stop, isNext ? s.here : STATION[step.status])}
      style={isNext && delay !== undefined ? ({ "--d": `${delay}ms` } as CSSProperties) : undefined}
    />
  );
}

/** Delays so the built line extends in order, then the planned segment. */
function delays(steps: Step[], nextId: string | null): number[] {
  let k = 0;
  return steps.map((step, i) => {
    const after = steps[i + 1];
    if (!after) return 0;
    const seg = segment(step, after, nextId);
    if (seg === "unbuilt") return 0;
    return k++ * STEP_MS;
  });
}

/** The vertical list, with each step's title, state word and the API's detail. */
export function SetupSteps({ steps, nextId }: { steps: Step[]; nextId: string | null }) {
  const d = delays(steps, nextId);
  const lastDelay = Math.max(0, ...d) + 160;
  return (
    <div data-draw>
      <DrawOnView />
      <ol className="border-t border-rule pt-5">
        {steps.map((step, i) => {
          const isNext = step.id === nextId;
          const after = steps[i + 1];
          const seg = after ? segment(step, after, nextId) : null;
          return (
            <li
              key={step.id}
              data-step={step.id}
              data-step-status={step.status}
              aria-current={isNext ? "step" : undefined}
              className="relative grid grid-cols-[22px_minmax(0,1fr)] gap-x-3.5 pb-6 last:pb-1"
            >
              {seg ? (
                <span
                  aria-hidden
                  className={clsx(s.segV, s[seg], "left-[8.5px] top-[9px] h-full")}
                  style={{ "--d": `${d[i]}ms` } as CSSProperties}
                />
              ) : null}
              <span aria-hidden className="relative z-[1] flex h-[18px] items-center justify-center">
                <Station step={step} isNext={isNext} delay={lastDelay} />
              </span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-baseline justify-between gap-x-3 leading-[18px]">
                  <span
                    className={clsx(
                      "text-ui font-bold",
                      step.status === "blocked" || step.status === "optional" ? "text-fg-3" : "text-fg",
                    )}
                  >
                    {step.title}
                  </span>
                  <span
                    className={clsx(
                      "text-meta font-semibold",
                      isNext ? "text-fg" : step.status === "done" ? "text-ok" : step.status === "pending" ? "text-fg-2" : "text-fg-4",
                    )}
                  >
                    {isNext ? "Next" : WORD[step.status]}
                  </span>
                </p>
                <p className={clsx("mt-1 text-meta leading-[1.5]", isNext ? "text-fg-2" : "text-fg-3")}>
                  {step.detail}
                  {step.id === "aggregate_reporting" && step.status !== "done" && step.detail.includes("web endpoint") ? (
                    <>
                      {" "}
                      <Link href="/settings/mailbox" className="link font-semibold" data-testid="rua-mailbox-link">
                        Set up the report mailbox
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The same steps as a short strip, for the page header: how far along, at a
 * glance. Decorative; the words beside it and the list carry the meaning.
 */
export function StepStrip({ steps, nextId, className }: { steps: Step[]; nextId: string | null; className?: string }) {
  const d = delays(steps, nextId);
  const lastDelay = Math.max(0, ...d) + 160;
  return (
    <div data-draw aria-hidden className={clsx("w-full max-w-[520px]", className)}>
      <DrawOnView />
      <div className="flex h-[18px] items-center">
        {steps.map((step, i) => {
          const before = steps[i - 1];
          const seg = before ? segment(before, step, nextId) : null;
          return (
            <Fragment key={step.id}>
              {seg ? (
                <span
                  className={clsx(s.segH, s[seg], "relative! -mx-px min-w-3 flex-1")}
                  style={{ "--d": `${d[i - 1]}ms` } as CSSProperties}
                />
              ) : null}
              <span className="relative z-[1] flex w-[18px] shrink-0 items-center justify-center">
                <Station step={step} isNext={step.id === nextId} delay={lastDelay} />
              </span>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
