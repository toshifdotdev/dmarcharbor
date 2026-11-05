import { describe, expect, it } from "vitest";
import { auditSubject, buildAuditTimeline } from "../lib/audit-display";
import type { AuditEventRow } from "../lib/types";

function row(action: string, detail: AuditEventRow["detail"], domain: AuditEventRow["domain"] = null): AuditEventRow {
  return {
    id: `e-${action}`,
    action: action as AuditEventRow["action"],
    outcome: "SUCCESS",
    targetType: "member",
    targetId: "t1",
    detail,
    requestId: null,
    createdAt: "2026-11-04T12:00:00Z",
    domain,
    actorUser: { id: "u1", name: "Test One", email: "one@wistholm.example" },
  } as AuditEventRow;
}

describe("auditSubject", () => {
  it("names the person whose role changed, with the roles", () => {
    expect(auditSubject(row("MEMBER_ROLE_CHANGED", { email: "alex@wistholm.example", role: "viewer", previousRole: "analyst" }))).toEqual({
      join: " for ",
      text: "alex@wistholm.example (analyst to viewer)",
    });
  });

  it("names the new owner of a transferred workspace", () => {
    expect(
      auditSubject(row("OWNERSHIP_TRANSFERRED", { from: { email: "one@wistholm.example" }, to: { email: "ada@wistholm.example" } })),
    ).toEqual({ join: " to ", text: "ada@wistholm.example" });
  });

  it("names the invited address and role on every invitation row", () => {
    for (const action of ["MEMBER_INVITED", "INVITATION_RESENT", "INVITATION_CANCELED", "INVITATION_ACCEPTED", "INVITATION_REJECTED"]) {
      expect(auditSubject(row(action, { email: "vic@wistholm.example", role: "viewer" })), action).toEqual({
        join: " for ",
        text: "vic@wistholm.example as viewer",
      });
    }
  });

  it("names the person removed, the client added, the domain verified and the currency chosen", () => {
    expect(auditSubject(row("MEMBER_REMOVED", { email: "alex@wistholm.example", role: "analyst" }))?.text).toBe("alex@wistholm.example");
    expect(auditSubject(row("CLIENT_CREATED", { name: "Pellowyn Dental", slug: "pellowyn" }))?.text).toBe("Pellowyn Dental");
    expect(auditSubject(row("DOMAIN_VERIFIED", { name: "pellowyn-dental.example", method: "txt" }))?.text).toBe("pellowyn-dental.example");
    expect(auditSubject(row("BILLING_CURRENCY_SET", { from: "INR", to: "USD" }))?.text).toBe("INR to USD");
  });

  it("falls back to the domain the row is filed under", () => {
    expect(auditSubject(row("FORENSIC_PURGE_DOMAIN", { deleted: 4 }, { id: "d1", name: "corriwick.example" }))).toEqual({
      join: ": ",
      text: "corriwick.example",
    });
  });

  it("names nothing for a row about the workspace itself", () => {
    expect(auditSubject(row("DPA_ACCEPTED", { version: "1.0" }))).toBeNull();
    expect(auditSubject(row("PASSWORD_CHANGED", { revokedOtherSessions: true }))).toBeNull();
  });

  it("is carried on every timeline entry", () => {
    const timeline = buildAuditTimeline([row("MEMBER_LEFT", { email: "vic@wistholm.example" })], new Date("2026-11-04T13:00:00Z"));
    expect(timeline.days[0]!.entries[0]!.subject).toEqual({ join: ": ", text: "vic@wistholm.example" });
  });
});
