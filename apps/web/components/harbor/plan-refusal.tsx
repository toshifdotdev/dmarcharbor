/**
 * plan-refusal.tsx — how a refused action is said, beside the control that was
 * refused.
 *
 *   ActionRefusal  a mutation's error. A 402 (FEATURE_NOT_IN_PLAN or
 *                  PLAN_LIMIT_REACHED) is the API's own sentence with the way
 *                  to Billing; the entitlement or quota key rides on a data
 *                  attribute for tests, never on screen. Anything else is the
 *                  message as a failure.
 *   PlanUnknown    the entitlements read failed: whether a feature is on the
 *                  plan is unknown, which is not the same as "not included".
 */

import { planRefusalText } from "@/lib/plan-features";
import { ButtonLink } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

export interface ActionError {
  code?: string;
  message?: string;
  feature?: string;
  quota?: string;
}

export function isPlanRefusal(e: ActionError | null | undefined): boolean {
  return Boolean(e && (e.code === "FEATURE_NOT_IN_PLAN" || e.code === "PLAN_LIMIT_REACHED" || e.code === "402"));
}

export function ActionRefusal({ error, className }: { error: ActionError | null; className?: string }) {
  if (!error) return null;
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

export function PlanUnknown({ what }: { what: string }) {
  return (
    <Notice tone="warn" title="The plan could not be read" testId="plan-unknown">
      Whether {what} is on this workspace&rsquo;s plan is unknown just now. That is an API problem, not a missing
      feature: nothing has been removed. Reload to try again.
    </Notice>
  );
}
