import type { PlanDefinition } from "./types";

/**
 * The arithmetic behind the Fleet card and the billing screen's Fleet quote.
 *
 * Kept out of the components so the numbers a customer reads can be unit
 * tested: the unit price, the minimum, and the total for a measured quantity.
 * Everything is integer minor units, and Fleet is monthly only by contract.
 */
export function fleetUnitMinor(plan: PlanDefinition, currency: "USD" | "INR"): number {
  return plan.prices[currency].monthlyMinor;
}

export function fleetMinimumQuantity(plan: PlanDefinition): number {
  return Math.max(1, plan.minimumQuantity ?? 1);
}

/** Unit × quantity, with the published minimum as the floor. */
export function fleetTotalMinor(
  plan: PlanDefinition,
  currency: "USD" | "INR",
  quantity?: number | null,
): number {
  const units = Math.max(fleetMinimumQuantity(plan), Math.trunc(quantity ?? 0));
  return fleetUnitMinor(plan, currency) * units;
}

/** The total at the minimum, which is the smallest bill a Fleet customer sees. */
export function fleetMinimumTotalMinor(plan: PlanDefinition, currency: "USD" | "INR"): number {
  return fleetTotalMinor(plan, currency, fleetMinimumQuantity(plan));
}

export interface FleetQuote {
  quantity: number;
  totalMinor: number;
  /** True when the measured count is below the floor, so the minimum applies. */
  atMinimum: boolean;
}

/** The quote for a measured active-domain count. */
export function fleetQuote(
  plan: PlanDefinition,
  currency: "USD" | "INR",
  measured: { activeDomains: number; quantity: number } | null,
): FleetQuote {
  const minimum = fleetMinimumQuantity(plan);
  const activeDomains = measured?.activeDomains ?? measured?.quantity ?? 0;
  const quantity = measured?.quantity ?? Math.max(minimum, activeDomains);
  return {
    quantity: Math.max(minimum, quantity),
    totalMinor: fleetUnitMinor(plan, currency) * Math.max(minimum, quantity),
    atMinimum: activeDomains < minimum,
  };
}

/** Fleet is sold on one interval; the card and the decision must not imply another. */
export function fleetIsMonthlyOnly(plan: PlanDefinition): boolean {
  return plan.intervals.length === 1 && plan.intervals[0] === "monthly";
}
