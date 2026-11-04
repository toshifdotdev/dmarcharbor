import { describe, expect, it } from "vitest";
import {
  MIN_PASSWORD,
  changePasswordProblem,
  passwordLength,
  passwordLengthHint,
  signInProviderList,
} from "../lib/password-rules.js";

describe("the new-password length rule", () => {
  it("is the API's minimum of 8", () => {
    expect(MIN_PASSWORD).toBe(8);
  });

  it("counts as you type, the same on sign-up and on change", () => {
    expect(passwordLengthHint("")).toBe("At least 8 characters.");
    expect(passwordLengthHint("short1")).toBe("At least 8 characters · 6 so far.");
    expect(passwordLengthHint("12345678")).toBe("Long enough.");
    expect(passwordLength("")).toBe("empty");
    expect(passwordLength("1234567")).toBe("short");
    expect(passwordLength("12345678")).toBe("ok");
  });
});

describe("the change-password form", () => {
  it("asks for the current password first", () => {
    expect(changePasswordProblem("", "a-new-password")).toBe("Enter your current password.");
  });

  it("refuses a short, an overlong or an unchanged new password before sending", () => {
    expect(changePasswordProblem("current-pass", "short")).toMatch(/at least 8 characters/);
    expect(changePasswordProblem("current-pass", "x".repeat(129))).toMatch(/at most 128 characters/);
    expect(changePasswordProblem("same-password", "same-password")).toBe(
      "The new password must be different from the current password.",
    );
  });

  it("lets a valid change through", () => {
    expect(changePasswordProblem("current-pass", "a-different-password")).toBeNull();
  });
});

describe("how an account without a password signs in", () => {
  it("names the providers in plain words", () => {
    expect(signInProviderList(["google"])).toBe("Google");
    expect(signInProviderList(["microsoft"])).toBe("Microsoft");
    expect(signInProviderList(["google", "microsoft"])).toBe("Google or Microsoft");
    expect(signInProviderList(["google", "microsoft", "sso"])).toBe(
      "Google, Microsoft or your company's single sign-on",
    );
    expect(signInProviderList(["google", "google"])).toBe("Google");
  });

  it("falls back to both social providers when none is reported", () => {
    expect(signInProviderList([])).toBe("Google or Microsoft");
  });
});
