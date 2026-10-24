import { describe, expect, it } from "vitest";
import { cleanDomainInput, splitDomainList } from "../lib/domain-list";

describe("splitting a pasted domain list", () => {
  it("accepts one per line, commas and spaces", () => {
    const parsed = splitDomainList("one.example\ntwo.example, three.example four.example");

    expect(parsed.names).toEqual(["one.example", "two.example", "three.example", "four.example"]);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.duplicates).toBe(0);
  });

  it("cleans URLs, email addresses, www and a trailing dot", () => {
    expect(cleanDomainInput("https://www.Example.COM/mail")).toBe("example.com");
    expect(cleanDomainInput("dmarc@mail.example.com")).toBe("mail.example.com");
    expect(cleanDomainInput("example.com.")).toBe("example.com");
  });

  it("counts duplicates after cleaning and keeps the first", () => {
    const parsed = splitDomainList("example.com\nExample.com.\nother.example");

    expect(parsed.names).toEqual(["example.com", "other.example"]);
    expect(parsed.duplicates).toBe(1);
  });

  it("keeps invalid rows aside instead of dropping them silently", () => {
    const parsed = splitDomainList("good.example\nlocalhost\nnot_a_domain");

    expect(parsed.names).toEqual(["good.example"]);
    expect(parsed.invalid).toEqual(["localhost", "not_a_domain"]);
  });

  it("returns nothing for blank input", () => {
    expect(splitDomainList("  \n \t ")).toEqual({ names: [], invalid: [], duplicates: 0 });
  });
});
