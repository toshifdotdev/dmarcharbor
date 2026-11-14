import { describe, expect, it } from "vitest";
import { safeNext } from "../lib/safe-next";

describe("the sign-in return path", () => {
  it("keeps a same-site path, with its query and fragment", () => {
    expect(safeNext("/domains/x")).toBe("/domains/x");
    expect(safeNext("/clients?tab=all#top")).toBe("/clients?tab=all#top");
  });

  it("refuses another site in every spelling a browser would follow", () => {
    // Browsers drop tab, CR and LF and read a backslash as a slash, so each of
    // these resolves to evil.example.
    for (const raw of [
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/\t\\evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "",
    ]) {
      expect(safeNext(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("refuses a path back to the sign-in or sign-up page", () => {
    expect(safeNext("/sign-in?next=/x")).toBeNull();
    expect(safeNext("/sign-up")).toBeNull();
  });

  it("refuses an overlong path", () => {
    expect(safeNext(`/${"a".repeat(600)}`)).toBeNull();
  });
});
