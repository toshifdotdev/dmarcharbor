import { describe, expect, it } from "vitest";
import { appHostProblem, siteConfigWarnings, siteUrlProblem, verificationToken, wwwTwinRedirect } from "../lib/site-config";

/** The production settings that decide the site's address (lib/site-config.ts). */

describe("siteUrlProblem", () => {
  it("accepts the production origin, with or without a trailing slash", () => {
    expect(siteUrlProblem("https://dmarcharbor.com", true)).toBeNull();
    expect(siteUrlProblem("https://dmarcharbor.com/", true)).toBeNull();
    expect(siteUrlProblem(undefined, true)).toBeNull();
    expect(siteUrlProblem("  ", true)).toBeNull();
  });

  it("refuses what would silently misaddress every page", () => {
    expect(siteUrlProblem("dmarcharbor.com", true)).toMatch(/not a URL/);
    expect(siteUrlProblem("http://dmarcharbor.com", true)).toMatch(/https in production/);
    expect(siteUrlProblem("http://localhost:3200", false)).toBeNull();
    expect(siteUrlProblem("https://dmarcharbor.com/app", true)).toMatch(/origin only/);
    expect(siteUrlProblem("https://dmarcharbor.com?x=1", true)).toMatch(/origin only/);
    expect(siteUrlProblem("ftp://dmarcharbor.com", false)).toMatch(/http or https/);
  });
});

describe("appHostProblem", () => {
  it("accepts a bare hostname only", () => {
    expect(appHostProblem("dmarcharbor.com")).toBeNull();
    expect(appHostProblem(undefined)).toBeNull();
    for (const bad of ["https://dmarcharbor.com", "dmarcharbor.com:443", "dmarcharbor.com/", "DMARCHARBOR.COM", ".dmarcharbor.com"]) {
      expect(appHostProblem(bad), bad).not.toBeNull();
    }
  });
});

describe("siteConfigWarnings", () => {
  it("is silent for the production values", () => {
    expect(
      siteConfigWarnings({
        SITE_URL: "https://dmarcharbor.com",
        NEXT_PUBLIC_APP_HOST: "dmarcharbor.com",
        GOOGLE_SITE_VERIFICATION: "AbC123_def-456",
      }),
    ).toEqual([]);
  });

  it("names what is missing or disagrees", () => {
    expect(siteConfigWarnings({}).join(" ")).toMatch(/SITE_URL is not set.*NEXT_PUBLIC_APP_HOST was not set/);
    expect(siteConfigWarnings({ SITE_URL: "https://dmarcharbor.com", NEXT_PUBLIC_APP_HOST: "app.dmarcharbor.com" })[0]).toMatch(
      /not SITE_URL's hostname/,
    );
    expect(
      siteConfigWarnings({ SITE_URL: "https://dmarcharbor.com", NEXT_PUBLIC_APP_HOST: "dmarcharbor.com", BING_SITE_VERIFICATION: "<b>" })[0],
    ).toMatch(/BING_SITE_VERIFICATION/);
  });
});

describe("verificationToken", () => {
  it("takes the token, or the content of a pasted tag", () => {
    expect(verificationToken("AbC123_def-456")).toBe("AbC123_def-456");
    expect(verificationToken('<meta name="google-site-verification" content="AbC123_def-456" />')).toBe("AbC123_def-456");
    expect(verificationToken("<meta name='msvalidate.01' content='0123456789ABCDEF0123456789ABCDEF'>")).toBe(
      "0123456789ABCDEF0123456789ABCDEF",
    );
  });

  it("drops anything that is not a token", () => {
    expect(verificationToken(undefined)).toBeNull();
    expect(verificationToken("short")).toBeNull();
    expect(verificationToken('abc"><script>')).toBeNull();
    expect(verificationToken("two words here")).toBeNull();
  });
});

describe("wwwTwinRedirect", () => {
  const site = "https://dmarcharbor.com";
  it("sends the www twin to the one address", () => {
    expect(wwwTwinRedirect({ hostname: "www.dmarcharbor.com", siteOrigin: site })).toBe(site);
    expect(wwwTwinRedirect({ hostname: "dmarcharbor.com", siteOrigin: "https://www.dmarcharbor.com" })).toBe(
      "https://www.dmarcharbor.com",
    );
  });

  it("leaves every other host alone, and does nothing without SITE_URL", () => {
    expect(wwwTwinRedirect({ hostname: "dmarcharbor.com", siteOrigin: site })).toBeNull();
    expect(wwwTwinRedirect({ hostname: "app.dmarcharbor.com", siteOrigin: site })).toBeNull();
    expect(wwwTwinRedirect({ hostname: "www.wistholm.example", siteOrigin: site })).toBeNull();
    expect(wwwTwinRedirect({ hostname: "www.dmarcharbor.com", siteOrigin: null })).toBeNull();
    expect(wwwTwinRedirect({ hostname: null, siteOrigin: site })).toBeNull();
  });
});
