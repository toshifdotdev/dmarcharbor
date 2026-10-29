import type { PerDomainBand, PlanDefinition } from "./types";

/**
 * The arithmetic behind the Fleet card and the billing screen's Fleet quote.
 *
 * Kept out of the components so the numbers a customer reads can be unit
 * tested. Fleet is priced in volume bands: the band is the first one whose
 * `upTo` holds the active-domain count, and the bill is
 * max(count, band minimum) × the band's unit price. Everything is integer minor
 * units, and Fleet is monthly only by contract.
 *
 * A catalog without `bands` (an older API) is read as one band at the plan's
 * own unit price and minimum, so the page still says something true.
 */
export function fleetBands(plan: PlanDefinition): PerDomainBand[] {
  if (plan.bands && plan.bands.length > 0) return plan.bands;
  return [
    {
      upTo: plan.maxActiveDomains,
      minimumQuantity: Math.max(1, plan.minimumQuantity ?? 1),
      unitMinor: { USD: plan.prices.USD.monthlyMinor, INR: plan.prices.INR.monthlyMinor },
    },
  ];
}

/** The band index a count bills in. Above the top band, the top band. */
export function fleetBandIndex(plan: PlanDefinition, count: number): number {
  const bands = fleetBands(plan);
  const n = Math.max(0, Math.trunc(count));
  const index = bands.findIndex((band) => n <= band.upTo);
  return index === -1 ? bands.length - 1 : index;
}

/** The lowest count a band covers. */
export function fleetBandFrom(plan: PlanDefinition, index: number): number {
  const bands = fleetBands(plan);
  return index === 0 ? 1 : (bands[index - 1]?.upTo ?? 0) + 1;
}

/** The first band's unit price: the "from" figure. */
export function fleetUnitMinor(plan: PlanDefinition, currency: "USD" | "INR"): number {
  return fleetBands(plan)[0]!.unitMinor[currency];
}

/** The least any Fleet bill is for: the first band's minimum. */
export function fleetMinimumQuantity(plan: PlanDefinition): number {
  return Math.max(1, fleetBands(plan)[0]!.minimumQuantity);
}

/** The bill for a measured count: band, billed quantity, unit and total. */
export function fleetBill(
  plan: PlanDefinition,
  currency: "USD" | "INR",
  count?: number | null,
): { band: number; quantity: number; minimum: number; unitMinor: number; totalMinor: number } {
  const band = fleetBandIndex(plan, count ?? 0);
  const entry = fleetBands(plan)[band]!;
  const minimum = Math.max(1, entry.minimumQuantity);
  const quantity = Math.max(minimum, Math.trunc(count ?? 0));
  const unitMinor = entry.unitMinor[currency];
  return { band, quantity, minimum, unitMinor, totalMinor: unitMinor * quantity };
}

/** The total for a measured count, with its band's minimum as the floor. */
export function fleetTotalMinor(plan: PlanDefinition, currency: "USD" | "INR", quantity?: number | null): number {
  return fleetBill(plan, currency, quantity).totalMinor;
}

/** The total at the minimum, which is the smallest bill a Fleet customer sees. */
export function fleetMinimumTotalMinor(plan: PlanDefinition, currency: "USD" | "INR"): number {
  return fleetTotalMinor(plan, currency, fleetMinimumQuantity(plan));
}

export interface FleetQuote {
  quantity: number;
  totalMinor: number;
  unitMinor: number;
  /** True when the measured count is below its band's minimum, so the minimum applies. */
  atMinimum: boolean;
}

/** The quote for a measured active-domain count. */
export function fleetQuote(
  plan: PlanDefinition,
  currency: "USD" | "INR",
  measured: { activeDomains: number; quantity: number } | null,
): FleetQuote {
  const activeDomains = measured?.activeDomains ?? measured?.quantity ?? 0;
  const bill = fleetBill(plan, currency, Math.max(activeDomains, measured?.quantity ?? 0));
  return {
    quantity: bill.quantity,
    totalMinor: bill.totalMinor,
    unitMinor: bill.unitMinor,
    atMinimum: activeDomains < bill.minimum,
  };
}

/** One row per band, as the pricing card lists them. */
export function fleetBandRows(
  plan: PlanDefinition,
  currency: "USD" | "INR",
): Array<{ from: number; upTo: number; unitMinor: number; minimum: number; minimumTotalMinor: number }> {
  return fleetBands(plan).map((band, index) => ({
    from: fleetBandFrom(plan, index),
    upTo: band.upTo,
    unitMinor: band.unitMinor[currency],
    minimum: band.minimumQuantity,
    minimumTotalMinor: band.unitMinor[currency] * band.minimumQuantity,
  }));
}

/** Fleet is sold on one interval; the card and the decision must not imply another. */
export function fleetIsMonthlyOnly(plan: PlanDefinition): boolean {
  return plan.intervals.length === 1 && plan.intervals[0] === "monthly";
}
