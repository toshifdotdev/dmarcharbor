/**
 * plan-refusal.tsx — how a refused action is said, beside the control that was
 * refused.
 *
 *   ActionRefusal  a mutation's error. A 402 (FEATURE_NOT_IN_PLAN or
 *                  PLAN_LIMIT_REACHED) is the API's own sentence with the way
 *                  to Billing; the entitlement or quota key rides on a data
 *                  attribute for tests, never on screen. A 401 is a session
 *                  that ended mid-use, with the way to sign in and come
 *                  back; a 429 is a wait (how long, when the limiter said),
 *                  never a red failure. Anything else is the message as a
 *                  failure.
 *   PlanUnknown    the entitlements read failed: whether a feature is on the
 *                  plan is unknown, which is not the same as "not included".
 */

import { planRefusalText } from "@/lib/plan-features";
import { retryAfterText } from "@/lib/retry-after";
import { ButtonLink } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SessionEndedNotice } from "./session-ended";

export interface ActionError {
  code?: string;
  message?: string;
  feature?: string;
  quota?: string;
  /** Seconds a 429 asked to wait (lib/ops-client.ts reads Retry-After). */
  retryAfterSeconds?: number;
}

export function isPlanRefusal(e: ActionError | null | undefined): boolean {
  return Boolean(e && (e.code === "FEATURE_NOT_IN_PLAN" || e.code === "PLAN_LIMIT_REACHED" || e.code === "402"));
}

/** The API's 401 carries no code, so the call layer files it under "401". */
export function isSessionEnded(e: ActionError | null | undefined): boolean {
  return Boolean(e && (e.code === "401" || e.code === "UNAUTHORIZED" || e.code === "UNAUTHENTICATED"));
}

export function isRateLimited(e: ActionError | null | undefined): boolean {
  return Boolean(e && (e.code === "RATE_LIMITED" || e.code === "429"));
}

export function ActionRefusal({ error, className }: { error: ActionError | null; className?: string }) {
  if (!error) return null;
  if (isSessionEnded(error)) return <SessionEndedNotice className={className} />;
  if (isRateLimited(error)) {
    // A wait, not a failure: warn, never red. The API's sentence already says
    // what limit was met; the figure is added only when it says more than
    // "a minute", so the two never repeat each other.
    const long = (error.retryAfterSeconds ?? 0) > 90;
    const words = [
      error.message,
      !error.message || long ? retryAfterText(error.retryAfterSeconds) : null,
      "Nothing was changed.",
    ].filter(Boolean);
    return (
      <Notice tone="warn" title="Too many requests just now" testId="action-rate-limited" className={className}>
        {words.join(" ")}
      </Notice>
    );
  }
  if (isPlanRefusal(error)) {
    return (
      <div data-feature={error.feature ?? error.quota ?? "unknown"} className={className}>
        <Notice
          tone="warn"
          title={error.code === "PLAN_LIMIT_REACHED" ? "The plan's limit is reached" : "Not on this workspace's plan"}
          action={
            <ButtonLink href="/billing" size="sm">
              See plan options
            </ButtonLink>
          }
        >
          {planRefusalText(error.message, error.feature)}
        </Notice>
      </div>
    );
  }
  return <Notice tone="fail" title={error.message ?? "That did not go through."} className={className} />;
}

/**
 * A quota that is used up, said before anyone fills in a form the API would
 * refuse: the count against the limit, what frees a place, and the way to
 * Billing. The quota key rides on a data attribute for tests, never on screen.
 * The words come from the caller, who has the plan's own numbers.
 */
export function PlanLimitNotice({
  quota,
  message,
  context,
  className,
}: {
  /** The API's quota key: client, activeDomain, member, workspace, prospect. */
  quota: string;
  message: string;
  context?: string;
  className?: string;
}) {
  return (
    <section
      role="status"
      data-testid="plan-limit"
      data-quota={quota}
      className={`rounded-sheet border border-rule bg-paper px-6 py-6${className ? ` ${className}` : ""}`}
    >
      <p className="legend text-fg!">The plan&rsquo;s limit is reached</p>
      <p className="mt-1.5 text-body font-semibold text-fg">{message}</p>
      {context ? <p className="mt-1 max-w-[68ch] text-ui text-fg-2">{context}</p> : null}
      <div className="mt-4">
        <ButtonLink href="/billing" variant="primary">
          See plan options
        </ButtonLink>
      </div>
    </section>
  );
}

/**
 * A count against a plan's limit, as one line: "3 of 5 team members", or
 * "3 team members, no limit on this plan". Rendered wherever a quota is spent,
 * so the limit is known before it is met.
 */
export function UsageLine({
  quota,
  used,
  limit,
  noun,
  nounOne,
  suffix,
  className,
}: {
  quota: string;
  used: number;
  limit: number | null;
  /** Plural noun: "team members". */
  noun: string;
  /** Singular, when the plural is not noun minus an s. */
  nounOne?: string;
  /** Said after the count: ", open invitations included". */
  suffix?: string;
  className?: string;
}) {
  const unlimited = limit === null || !Number.isFinite(limit);
  const one = nounOne ?? noun.replace(/s$/, "");
  return (
    <span data-testid={`usage-${quota}`} data-quota={quota} className={`tnum${className ? ` ${className}` : ""}`}>
      {unlimited ? (
        <>
          <span className="font-semibold text-fg-2">{used}</span> {used === 1 ? one : noun}
          {suffix ?? ""}; no limit on this plan
        </>
      ) : (
        <>
          <span className="font-semibold text-fg-2">{used}</span> of {limit} {limit === 1 ? one : noun}
          {suffix ?? ""}
        </>
      )}
    </span>
  );
}

export function PlanUnknown({ what }: { what: string }) {
  return (
    <Notice tone="warn" title="The plan could not be read" testId="plan-unknown">
      Whether {what} is on this workspace&rsquo;s plan is unknown just now. That is an API problem, not a missing
      feature: nothing has been removed. Reload to try again.
    </Notice>
  );
}
