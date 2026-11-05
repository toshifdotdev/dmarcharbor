/**
 * ownership-transfer.ts — what the transfer confirmation says about the plan.
 *
 * The workspace follows the plan on the new owner's account. The confirmation
 * names that plan, and when it is lower than the plan the workspace is on now
 * it lists what stops: the same "No longer included" features the Billing page
 * lists before a downgrade (lostFeatures), and the limits that shrink.
 */

import { isLowerPlan, limitLabel, loweredLimits, lostFeatures, planFeatureLabel } from "./plan-features";
import type { OwnershipTransferPreview, PlanDefinition } from "./types";

export interface TransferPlanSummary {
  /** One sentence naming the plan after the transfer. */
  sentence: string;
  lower: boolean;
  /** Feature labels that stop, in reading order. Empty unless lower. */
  stops: string[];
  /** "Clients: 20 → 1", for each limit that shrinks. Empty unless lower. */
  limits: string[];
}

export function transferPlanSummary(preview: OwnershipTransferPreview, plans: PlanDefinition[] | null): TransferPlanSummary {
  const name = preview.newOwner.name;
  const from = plans?.find((p) => p.tier === preview.currentPlan) ?? null;
  const to = plans?.find((p) => p.tier === preview.plan) ?? null;

  if (preview.plan === preview.currentPlan) {
    return {
      sentence: `The workspace stays on ${preview.planLabel}, the plan on ${name}'s account.`,
      lower: false,
      stops: [],
      limits: [],
    };
  }

  if (!from || !to) {
    // The catalog could not be read: name the plans, claim nothing about features.
    return {
      sentence: `The workspace moves from ${preview.currentPlanLabel} to ${preview.planLabel}, the plan on ${name}'s account. Compare the two on the Pricing page before you confirm.`,
      lower: false,
      stops: [],
      limits: [],
    };
  }

  if (!isLowerPlan(from, to)) {
    return {
      sentence: `The workspace moves from ${preview.currentPlanLabel} to ${preview.planLabel}, the plan on ${name}'s account. Nothing it uses now stops.`,
      lower: false,
      stops: [],
      limits: [],
    };
  }

  return {
    sentence: `The workspace moves from ${preview.currentPlanLabel} down to ${preview.planLabel}, the plan on ${name}'s account. This stops:`,
    lower: true,
    stops: lostFeatures(from, to).map(planFeatureLabel),
    limits: loweredLimits(from, to).map((row) => `${row.label}: ${limitLabel(row.before)} → ${limitLabel(row.after)}`),
  };
}
