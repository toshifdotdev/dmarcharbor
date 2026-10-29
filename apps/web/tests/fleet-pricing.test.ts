import { describe, expect, it } from "vitest";
import {
  fleetBandRows,
  fleetBill,
  fleetIsMonthlyOnly,
  fleetMinimumQuantity,
  fleetMinimumTotalMinor,
  fleetQuote,
  fleetTotalMinor,
  fleetUnitMinor,
} from "../lib/fleet-pricing";
import { catalogMonthsSaved } from "../lib/plan-features";
import type { PlanDefinition } from "../lib/types";

const fleet = {
  tier: "FLEET",
  label: "Fleet",
  descriptor: "Harbor's features for larger portfolios, billed per active domain.",
  prices: {
    USD: { monthlyMinor: 200, annualMinor: 0 },
    INR: { monthlyMinor: 16900, annualMinor: 0 },
  },
  pricing: "per_domain",
  intervals: ["monthly"],
  minimumQuantity: 75,
  maxClients: 1000,
  maxActiveDomains: 5000,
  maxMembers: 25,
  maxWorkspaces: 5,
  activeDomainWindowDays: 30,
  features: {} as PlanDefinition["features"],
} satisfies PlanDefinition;

const harbor = {
  ...fleet,
  tier: "HARBOR",
  label: "Harbor",
  prices: {
    USD: { monthlyMinor: 14900, annualMinor: 149000 },
    INR: { monthlyMinor: 1249900, annualMinor: 12499000 },
  },
  pricing: "flat",
  intervals: ["monthly", "annual"],
  minimumQuantity: null,
} satisfies PlanDefinition;

describe("Fleet price lines", () => {
  it("shows the unit, and the minimum as a monthly total", () => {
    expect(fleetUnitMinor(fleet, "USD")).toBe(200);
    expect(fleetUnitMinor(fleet, "INR")).toBe(16900);
    expect(fleetMinimumQuantity(fleet)).toBe(75);
    expect(fleetMinimumTotalMinor(fleet, "USD")).toBe(15_000);
    expect(fleetMinimumTotalMinor(fleet, "INR")).toBe(1_267_500);
  });

  it("totals the measured quantity and never goes below the minimum", () => {
    expect(fleetTotalMinor(fleet, "USD", 120)).toBe(24_000);
    expect(fleetTotalMinor(fleet, "USD", 10)).toBe(15_000);
    expect(fleetTotalMinor(fleet, "INR", 140)).toBe(2_366_000);
  });

  it("quotes at the current count, or says the minimum applies below it", () => {
    const above = fleetQuote(fleet, "USD", { activeDomains: 120, quantity: 120 });
    expect(above).toEqual({ quantity: 120, totalMinor: 24_000, unitMinor: 200, atMinimum: false });

    const below = fleetQuote(fleet, "INR", { activeDomains: 10, quantity: 75 });
    expect(below).toEqual({ quantity: 75, totalMinor: 1_267_500, unitMinor: 16900, atMinimum: true });
  });

  it("prices each band at its own unit and minimum, and never lowers the bill", () => {
    const banded = {
      ...fleet,
      maxMembers: null,
      bands: [
        { upTo: 200, minimumQuantity: 75, unitMinor: { USD: 200, INR: 16900 } },
        { upTo: 500, minimumQuantity: 320, unitMinor: { USD: 125, INR: 10600 } },
        { upTo: 2000, minimumQuantity: 625, unitMinor: { USD: 100, INR: 8500 } },
        { upTo: 5000, minimumQuantity: 2667, unitMinor: { USD: 75, INR: 6400 } },
      ],
    } satisfies PlanDefinition;

    expect(fleetBill(banded, "USD", 250)).toMatchObject({ band: 1, quantity: 320, unitMinor: 125, totalMinor: 40_000 });
    expect(fleetBill(banded, "USD", 1000)).toMatchObject({ band: 2, quantity: 1000, totalMinor: 100_000 });
    expect(fleetQuote(banded, "INR", { activeDomains: 250, quantity: 320 })).toEqual({
      quantity: 320,
      totalMinor: 3_392_000,
      unitMinor: 10600,
      atMinimum: true,
    });
    expect(fleetBandRows(banded, "USD").map((row) => [row.from, row.upTo, row.minimumTotalMinor])).toEqual([
      [1, 200, 15_000],
      [201, 500, 40_000],
      [501, 2000, 62_500],
      [2001, 5000, 200_025],
    ]);

    for (const currency of ["USD", "INR"] as const) {
      let previous = 0;
      for (let count = 1; count <= 5000; count += 1) {
        const total = fleetTotalMinor(banded, currency, count);
        expect(total).toBeGreaterThanOrEqual(previous);
        previous = total;
      }
    }
  });

  it("is monthly only", () => {
    expect(fleetIsMonthlyOnly(fleet)).toBe(true);
    expect(fleetIsMonthlyOnly(harbor)).toBe(false);
  });

  it("does not distort the annual saving shown for the ladder", () => {
    // Harbor saves two months; Fleet's zero annual placeholder must not make
    // the "save N months" figure disappear or become twelve.
    expect(catalogMonthsSaved([harbor])).toBe(2);
    expect(catalogMonthsSaved([harbor, fleet])).toBe(2);
  });
});
