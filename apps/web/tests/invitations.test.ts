import { describe, expect, it } from "vitest";
import { invitationExpired, splitInvitations } from "../lib/invitations";

const now = Date.parse("2026-11-04T12:00:00Z");
const row = (id: string, expiresAt: string | null, status = "pending") => ({ id, email: `${id}@pellowyn-dental.example`, role: "analyst", status, expiresAt });

describe("splitInvitations", () => {
  it("lists an expired invitation apart from the ones still waiting", () => {
    const { waiting, expired } = splitInvitations(
      [row("open", "2026-11-05T12:00:00Z"), row("lapsed", "2026-11-03T12:00:00Z"), row("undated", null)],
      now,
    );
    expect(waiting.map((r) => r.id)).toEqual(["open", "undated"]);
    expect(expired.map((r) => r.id)).toEqual(["lapsed"]);
  });

  it("drops invitations that were accepted, declined or withdrawn", () => {
    const { waiting, expired } = splitInvitations(
      [row("a", "2026-11-05T12:00:00Z", "accepted"), row("b", "2026-11-03T12:00:00Z", "canceled"), row("c", "2026-11-05T12:00:00Z")],
      now,
    );
    expect(waiting.map((r) => r.id)).toEqual(["c"]);
    expect(expired).toEqual([]);
  });

  it("treats the expiry instant itself as expired, as the API does", () => {
    expect(invitationExpired({ expiresAt: "2026-11-04T12:00:00Z" }, now)).toBe(true);
    expect(invitationExpired({ expiresAt: "2026-11-04T12:00:01Z" }, now)).toBe(false);
    expect(invitationExpired({ expiresAt: "not a date" }, now)).toBe(false);
  });
});
