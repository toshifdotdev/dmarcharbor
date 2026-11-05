import { describe, expect, it } from "vitest";
import { domainsFromCsv } from "../lib/domain-csv";

/** The Add domains list's CSV import (lib/domain-csv.ts). */
describe("domainsFromCsv", () => {
  it("takes the column headed domain, wherever it is", () => {
    expect(domainsFromCsv("client,domain,notes\nPellowyn,pellowyn-dental.example,main\nCorriwick,corriwick-cafe.example,")).toEqual([
      "pellowyn-dental.example",
      "corriwick-cafe.example",
    ]);
    expect(domainsFromCsv('"Domain Name";"Owner"\n"haskerley-law.example";"Ana"')).toEqual(["haskerley-law.example"]);
  });

  it("uses the first column, and keeps a first row that is already a domain", () => {
    expect(domainsFromCsv("ollerbeck-vets.example,x\nthrandle-build.example,y")).toEqual([
      "ollerbeck-vets.example",
      "thrandle-build.example",
    ]);
    expect(domainsFromCsv("Website,Owner\nollerbeck-vets.example,Ana")).toEqual(["ollerbeck-vets.example"]);
  });

  it("skips blank lines, a byte-order mark and Windows line ends", () => {
    expect(domainsFromCsv("\uFEFFdomain\r\n\r\na.example\r\n,\r\nb.example\r\n")).toEqual(["a.example", "b.example"]);
    expect(domainsFromCsv("")).toEqual([]);
  });
});
