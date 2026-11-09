import { describe, expect, it } from "vitest";
import { signInErrorMessage } from "../lib/sign-in-errors.js";

describe("sign-in error codes", () => {
  it("says nothing when there is no code", () => {
    expect(signInErrorMessage(undefined)).toBeNull();
    expect(signInErrorMessage("")).toBeNull();
  });

  it("explains an OAuth state that could not be used, never showing the code", () => {
    for (const code of ["state_mismatch", "state_not_found", "please_restart_the_process", "invalid_callback_request"]) {
      const message = signInErrorMessage(code);
      expect(message, code).toMatch(/sign-in|provider/i);
      expect(message, code).not.toContain(code);
      expect(message, code).toContain("Try again, or sign in with email.");
    }
  });

  it("tells an unverified provider account to confirm its email", () => {
    expect(signInErrorMessage("email_not_verified")).toMatch(/^Confirm your email address first/);
  });

  it("reads the last of several codes, as Better Auth appends its own", () => {
    expect(signInErrorMessage(["social", "access_denied"])).toMatch(/cancelled the sign-in/);
    expect(signInErrorMessage(["social", "something_new"])).toMatch(/did not complete with the provider/);
  });

  it("keeps the codes that existed before", () => {
    expect(signInErrorMessage("INVALID_TOKEN")).toMatch(/reset link/);
    expect(signInErrorMessage("unable_to_create_session")).toMatch(/two-step verification/);
    expect(signInErrorMessage("verify_expired")).toMatch(/expired/);
  });

  it("explains a single sign-on refusal in words (session 14)", () => {
    expect(signInErrorMessage("sso_domain_not_permitted")).toMatch(/not at a domain this workspace lets in/);
    expect(signInErrorMessage("sso_not_found")).toMatch(/switched off or removed/);
    for (const code of ["sso_domain_not_permitted", "sso_not_found", "sso_error", "sso_response_invalid"]) {
      expect(signInErrorMessage(code), code).not.toContain(code);
    }
  });

  it("falls back to a plain sentence for an unknown code", () => {
    expect(signInErrorMessage("something_new")).toBe("That did not work. Try again.");
  });
});
