import { describe, expect, it } from "vitest";
import { groupSecret, totpSecretFromUri } from "../lib/mfa";

describe("two-factor setup key", () => {
  it("reads the base32 secret from an otpauth URI", () => {
    const uri =
      "otpauth://totp/DMARC%20Harbor:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=DMARC%20Harbor&digits=6&period=30";
    expect(totpSecretFromUri(uri)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("refuses anything that is not an otpauth URI with a base32 secret", () => {
    expect(totpSecretFromUri("https://example.com/?secret=JBSWY3DPEHPK3PXP")).toBeNull();
    expect(totpSecretFromUri("not a url")).toBeNull();
    expect(totpSecretFromUri("otpauth://totp/x?secret=0189")).toBeNull();
  });

  it("groups the key in fours", () => {
    expect(groupSecret("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
    expect(groupSecret("ABCDE")).toBe("ABCD E");
  });
});
