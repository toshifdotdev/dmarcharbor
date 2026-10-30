"use client";

/**
 * states.tsx — every screen's other states, designed as carefully as the data.
 *
 *   loading     a message riding a short line (ui/tide.tsx). A waiting state
 *               that looks like waiting, sized to where the content will be.
 *   empty       loaded, nothing here, and the next action. A first run is a
 *               starting point, so it teaches: what this place will hold and
 *               the one thing to do to fill it.
 *   error       what failed, that it is not the same as empty, and a retry.
 *               "You have no domains" when we could not ask is the lie that
 *               costs someone an afternoon.
 *   partial     some of it loaded. Say which part did not, keep the rest.
 *   permission  you are signed in and this is not yours to see or change.
 *   upgrade     the plan does not carry it. The words come from the API's 402.
 *
 * The test ids (state-loading, state-empty, state-error, state-retry) are read
 * by the clickthrough suite and are kept from the Monolith components.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import type { ReactNode } from "react";
import { Button, ButtonLink } from "./button";
import { Lock, Refresh } from "./icons";
import { TideMark } from "./tide";
import { planRefusalText } from "@/lib/plan-features";

/**
 * Waiting, shown as the riding mark alone, centred. No visible word: the mark
 * already says it. The label is for screen readers. `rows` lays faint rules
 * beneath, so a table screen keeps its height while it loads.
 */
export function LoadingState({
  label = "Loading",
  rows = 0,
  className,
}: {
  label?: string;
  /** Placeholder rule lines beneath the mark, to hold the content's height. */
  rows?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-live="polite" data-testid="state-loading" className={clsx("py-8", className)}>
      <span className="sr-only">{label}</span>
      <div className="flex justify-center" aria-hidden>
        <TideMark size={44} />
      </div>
      {rows > 0 ? (
        <div className="mt-5 flex flex-col" aria-hidden>
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="h-9 border-b border-rule" style={{ opacity: 1 - i * (0.8 / rows) }} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  secondary,
  steps,
  className,
}: {
  title: string;
  description: ReactNode;
  action?: { label: string; href?: string; onClick?: () => void; busy?: boolean };
  secondary?: { label: string; href: string };
  /** The path from empty to full, when there is more than one step. */
  steps?: Array<{ title: string; body: string }>;
  className?: string;
}) {
  return (
    <section
      role="status"
      data-testid="state-empty"
      className={clsx("rounded-sheet border border-rule bg-paper px-6 py-6", className)}
    >
      <h3 className="text-h3 font-bold tracking-[-0.01em] text-fg">{title}</h3>
      <p className="mt-1.5 max-w-[68ch] text-body text-fg-2">{description}</p>
      {steps && steps.length > 0 ? (
        // The steps are stations on one line: the first is where you are.
        <ol className="mt-7 grid max-w-[880px] gap-y-6 sm:grid-cols-3">
          {steps.map((s, i) => (
            <li
              key={s.title}
              className={clsx(
                "relative border-t-[3px] pr-6 pt-4",
                i === 0 ? "border-fg" : "border-rule-2",
                "before:absolute before:-top-[8.5px] before:left-0 before:size-[14px] before:rounded-full before:border-[3px] before:bg-paper before:content-['']",
                i === 0 ? "before:border-fg" : "before:border-rule-2",
              )}
            >
              <p className="text-ui font-bold text-fg">{s.title}</p>
              <p className="mt-1 text-meta text-fg-2">{s.body}</p>
            </li>
          ))}
        </ol>
      ) : null}
      {action || secondary ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          {action ? (
            action.href ? (
              <ButtonLink href={action.href} variant="primary">
                {action.label}
              </ButtonLink>
            ) : (
              <Button variant="primary" onClick={action.onClick} busy={action.busy} busyLabel={action.label}>
                {action.label}
              </Button>
            )
          ) : null}
          {secondary ? (
            <Link href={secondary.href} className="link text-ui">
              {secondary.label}
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function ErrorState({
  what,
  detail,
  className,
  onRetry,
}: {
  /** The thing that did not load, as a noun phrase: "the portfolio". */
  what: string;
  detail?: ReactNode;
  className?: string;
  /** Defaults to re-running the server render of this route. */
  onRetry?: () => void;
}) {
  const router = useRouter();
  return (
    <section
      role="alert"
      data-testid="state-error"
      className={clsx("rounded-sheet border border-fail/30 bg-fail-wash px-6 py-5", className)}
    >
      <p className="legend text-fail!">Could not load</p>
      <p className="mt-1.5 text-body font-semibold text-fg">
        {capitalise(what)} did not load: the measurement API did not answer.
      </p>
      {detail ? <p className="mt-1 max-w-[72ch] text-ui text-fg-2">{detail}</p> : null}
      <p className="mt-1 max-w-[72ch] text-meta text-fg-3">
        This is not the same as having no data. Nothing was deleted or hidden; the request failed.
      </p>
      <Button
        className="mt-4"
        variant="secondary"
        onClick={onRetry ?? (() => router.refresh())}
        data-testid="state-retry"
      >
        <Refresh size={14} />
        Try again
      </Button>
    </section>
  );
}

/** Some of the screen loaded. Names the missing part; never hides the rest. */
export function PartialNotice({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      data-testid="state-partial"
      className="flex items-baseline gap-2 rounded-r-[10px] border-l-[3px] border-warn-mark bg-warn-wash px-3.5 py-2.5 text-ui text-fg-2"
    >
      <span className="legend shrink-0 text-warn!">Partial</span>
      <span>{children}</span>
    </p>
  );
}

export function PermissionState({
  what,
  detail,
  back = { label: "Back to portfolio", href: "/" },
}: {
  what: string;
  detail?: ReactNode;
  back?: { label: string; href: string };
}) {
  return (
    <section role="status" data-testid="state-permission" className="rounded-sheet border border-rule bg-paper px-6 py-6">
      <p className="legend flex items-center gap-1.5">
        <Lock size={12} /> No access
      </p>
      <p className="mt-1.5 text-body font-semibold text-fg">Your role in this workspace cannot open {what}.</p>
      <p className="mt-1 max-w-[68ch] text-ui text-fg-2">
        {detail ?? "An owner or admin of this workspace can change your role, or do this for you."}
      </p>
      <ButtonLink href={back.href} className="mt-4">
        {back.label}
      </ButtonLink>
    </section>
  );
}

/**
 * A 402. The sentence is the API's own (it names the plan that carries the
 * feature); nothing here knows what a plan is called. The entitlement key rides
 * on a data attribute for tests, never on screen.
 */
export function UpgradeNotice({
  message,
  feature,
  context,
}: {
  message: string | null | undefined;
  feature?: string | null;
  context?: string;
}) {
  return (
    <section
      role="status"
      data-feature={feature ?? "unknown"}
      className="rounded-sheet border border-rule bg-paper px-6 py-6"
    >
      <p className="legend text-fg!">Not on this workspace&rsquo;s plan</p>
      <p className="mt-1.5 text-body font-semibold text-fg">
        {planRefusalText(message, feature) ?? "This capability is not included in the current plan."}
      </p>
      {context ? <p className="mt-1 max-w-[68ch] text-ui text-fg-2">{context}</p> : null}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <ButtonLink href="/billing" variant="primary">
          See plan options
        </ButtonLink>
        <Link href="/" className="link text-ui">
          Back to portfolio
        </Link>
      </div>
    </section>
  );
}

function capitalise(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
