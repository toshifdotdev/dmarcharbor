import { describe, expect, it } from "vitest";
import { assertPathStaysPut } from "../lib/api-fetch";

describe("an API path built from page ids", () => {
  it("lets ordinary paths and queries through", () => {
    expect(() => assertPathStaysPut("http://localhost:4000/api/portal/domains/cm123abc?organizationId=org_1")).not.toThrow();
    expect(() => assertPathStaysPut("https://api.example/api/v1/domains/example.com")).not.toThrow();
    // A slash inside the query is not a path.
    expect(() => assertPathStaysPut("http://localhost:4000/api/x?next=/a/b")).not.toThrow();
  });

  it("refuses an id that would climb to another route", () => {
    for (const url of [
      "http://localhost:4000/api/portal/domains/../../me/sessions",
      "http://localhost:4000/api/portal/domains/..%2F..%2Fme%2Fsessions",
      "http://localhost:4000/api/portal/domains/%2e%2e/me",
      "http://localhost:4000/api/workspaces/a%5Cb/clients",
    ]) {
      expect(() => assertPathStaysPut(url), url).toThrow();
    }
  });
});
