import { describe, expect, it } from "vitest";
import { lostFeatures } from "../lib/plan-features";
import { transferPlanSummary } from "../lib/ownership-transfer";
import type { OwnershipTransferPreview, PlanDefinition } from "../lib/types";

const price = { monthlyMinor: 0, annualMinor: 0 };

function plan(tier: string, label: string, features: string[], limits: Partial<PlanDefinition> = {}): PlanDefinition {
  return {
    tier,
    label,
    descriptor: "",
    prices: { USD: price, INR: price },
    pricing: "flat",
    intervals: ["monthly", "annual"],
    minimumQuantity: null,
    maxClients: 1,
    maxActiveDomains: 2,
    maxMembers: 2,
    maxWorkspaces: 1,
    activeDomainWindowDays: 30,
    features: Object.fromEntries(features.map((k) => [k, true])) as PlanDefinition["features"],
    ...limits,
  };
}

const mooring = plan("MOORING", "Mooring", ["reports.aggregate", "audit.trail"]);
const harbor = plan("HARBOR", "Harbor", ["reports.aggregate", "audit.trail", "digests", "portal.client", "integrations.webhooks"], {
  maxClients: 20,
  maxActiveDomains: 80,
  maxMembers: 25,
  maxWorkspaces: 3,
});
const plans = [mooring, harbor];

function preview(current: string, next: string, refusal: OwnershipTransferPreview["refusal"] = null): OwnershipTransferPreview {
  const label = (tier: string) => plans.find((p) => p.tier === tier)?.label ?? tier;
  return {
    newOwner: { memberId: "m1", name: "Ada Admin", email: "ada@wistholm.example" },
    currentPlan: current,
    currentPlanLabel: label(current),
    plan: next,
    planLabel: label(next),
    refusal,
  };
}

describe("transferPlanSummary", () => {
  it("names the lower plan and lists what stops, the same features a downgrade lists", () => {
    const summary = transferPlanSummary(preview("HARBOR", "MOORING"), plans);
    expect(summary.lower).toBe(true);
    expect(summary.sentence).toBe("The workspace moves from Harbor down to Mooring, the plan on Ada Admin's account. This stops:");
    // In the Billing page's reading order and with its words.
    expect(summary.stops).toEqual(["Webhooks", "Scheduled report digests", "Client portal and client approvals"]);
    expect(lostFeatures(harbor, mooring)).toEqual(["integrations.webhooks", "digests", "portal.client"]);
    expect(summary.limits).toEqual(["Clients: 20 → 1", "Active domains: 80 → 2", "Team members: 25 → 2", "Workspaces: 3 → 1"]);
  });

  it("says the plan stays when it is the same", () => {
    const summary = transferPlanSummary(preview("HARBOR", "HARBOR"), plans);
    expect(summary).toMatchObject({ lower: false, stops: [], limits: [] });
    expect(summary.sentence).toBe("The workspace stays on Harbor, the plan on Ada Admin's account.");
  });

  it("says nothing stops when the plan is higher", () => {
    const summary = transferPlanSummary(preview("MOORING", "HARBOR"), plans);
    expect(summary.lower).toBe(false);
    expect(summary.sentence).toContain("moves from Mooring to Harbor");
    expect(summary.sentence).toContain("Nothing it uses now stops.");
  });

  it("claims nothing about features when the catalog could not be read", () => {
    const summary = transferPlanSummary(preview("HARBOR", "MOORING"), null);
    expect(summary).toMatchObject({ lower: false, stops: [] });
    expect(summary.sentence).toContain("Compare the two on the Pricing page");
  });
});
