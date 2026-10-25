import { describe, expect, it } from "vitest";
import {
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
    expect(above).toEqual({ quantity: 120, totalMinor: 24_000, atMinimum: false });

    const below = fleetQuote(fleet, "INR", { activeDomains: 10, quantity: 75 });
    expect(below).toEqual({ quantity: 75, totalMinor: 1_267_500, atMinimum: true });
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
