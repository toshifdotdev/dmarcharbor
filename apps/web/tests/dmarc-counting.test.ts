import { describe, expect, it } from "vitest";
import { dmarcFailedMessages, passesDmarc } from "../lib/dmarc";
import { resolvePosture, type ResolvedPosture } from "../lib/posture";
import { summaryText, verdictFor } from "../lib/portal-verdict";
import type { DomainSignals, PortalDomainDetail } from "../lib/types";

function signals(overrides: Partial<DomainSignals> = {}): DomainSignals {
  return {
    reportCount: 1,
    messageCount: 1_000,
    failedMessages: 0,
    unattributedMessages: 0,
    spfPassRate: 0,
    dkimPassRate: 100,
    lastReportAt: new Date().toISOString(),
    reportedPolicy: "reject",
    ...overrides,
  };
}

function portal(overrides: Partial<NonNullable<PortalDomainDetail["aggregate"]>> = {}): PortalDomainDetail {
  return {
    domain: {
      id: "d1",
      name: "example.com",
      status: "VERIFIED",
      score: 82,
      dmarcPolicy: "reject",
      dmarcRecord: "v=DMARC1; p=reject",
      verifiedAt: new Date().toISOString(),
      lastScanAt: null,
      client: { id: "c1", name: "Acme" },
    },
    aggregate: {
      reportCount: 1,
      recordCount: 1,
      messageCount: 1_000,
      failedMessages: 0,
      spfPassRate: 0,
      dkimPassRate: 100,
      lastReportAt: new Date().toISOString(),
      messageWindow: { begin: new Date().toISOString(), end: new Date().toISOString() },
      ...overrides,
    },
    senders: [],
    possibleSpoofingSources: [],
  };
}

describe("DMARC failure counting on the web", () => {
  it("uses either aligned check as the DMARC pass rule", () => {
    expect(passesDmarc({ dkimResult: "pass", spfResult: "fail" })).toBe(true);
    expect(passesDmarc({ dkimResult: "fail", spfResult: "pass" })).toBe(true);
    expect(passesDmarc({ dkimResult: "fail", spfResult: "fail" })).toBe(false);
    expect(dmarcFailedMessages([{ messageCount: 100, dkimResult: "pass", spfResult: "fail" }])).toBe(0);
  });

  it("does not block a domain whose mail passed DMARC on one check", () => {
    const posture: ResolvedPosture = resolvePosture(signals());

    expect(posture.posture).toBe("pass");
    expect(posture.reason).not.toContain("failed");
  });

  it("blocks only on DMARC failures and names them", () => {
    const posture = resolvePosture(signals({ failedMessages: 10 }));

    expect(posture.posture).toBe("block");
    expect(posture.reason).toContain("10 messages failed DMARC");
  });

  it("does not tell the portal owner that partially aligned mail did not come from them", () => {
    const detail = portal();
    const verdict = verdictFor(detail, "Acme", Date.now());

    expect(verdict.kind).toBe("protected");
    expect(verdict.meaning).not.toContain("did not prove");
    expect(summaryText(detail, verdict, "Acme")).not.toContain("Failed the checks");
  });

  it("counts DMARC failures in the portal verdict and summary", () => {
    const detail = portal({ failedMessages: 20 });
    const verdict = verdictFor(detail, "Acme", Date.now());
    const summary = summaryText(detail, verdict, "Acme");

    expect(verdict.kind).toBe("attention");
    expect(verdict.meaning).toContain("failed DMARC");
    expect(summary).toContain("Failed DMARC: 20");
  });
});
