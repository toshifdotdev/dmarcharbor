import { describe, expect, it } from "vitest";
import { faqEntries, parseBlocks, PENDING_TOKEN, questionIds, questionText, uniqueIds } from "../components/harbor/legal-markdown";
import { DEVELOPER_DOCS, developerDocBody } from "../lib/docs-registry";
import { LEGAL_BY_SLUG, legalBody } from "../lib/legal-docs";
import { llmsFullTxt, llmsTxt, money, planLine, publishableMarkdown } from "../lib/llms";
import {
  breadcrumbJsonLd,
  faqPageJsonLd,
  jsonLdString,
  nodeId,
  planOffersJsonLd,
  siteGraphJsonLd,
  techArticleJsonLd,
} from "../lib/structured-data";
import type { PlanDefinition } from "../lib/types";

/**
 * What answer engines read: the FAQ's questions and their anchors, the
 * JSON-LD graph, and /llms.txt and /llms-full.txt.
 */

const SITE = "https://dmarcharbor.com";
const faq = legalBody(LEGAL_BY_SLUG.get("faq")!);

describe("faqEntries on docs/FAQ.md", () => {
  const entries = faqEntries(faq.text);

  it("finds every question the page renders as a heading, with the same ids", () => {
    const blocks = parseBlocks(faq.text);
    const questions = blocks.map(questionText).filter((q): q is string => q !== null);
    expect(questions.length).toBeGreaterThan(40);
    expect(entries.map((e) => e.question)).toEqual(questions);
    const h2Ids = uniqueIds(blocks.filter((b) => b.type === "h2").map((b) => b.lines[0]!));
    expect(entries.map((e) => e.id)).toEqual(questionIds(blocks, h2Ids));
    // Ids are unique and never take a section's address.
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    for (const entry of entries) expect(h2Ids).not.toContain(entry.id);
  });

  it("gives every question an answer in plain text, under its section", () => {
    for (const entry of entries) {
      expect(entry.answer.trim(), entry.question).not.toBe("");
      expect(entry.answer, entry.question).not.toMatch(/\*\*|`/);
      expect(entry.section, entry.question).not.toBeNull();
      expect(entry.id).toMatch(/^[a-z0-9-]+$/);
      expect(entry.id.endsWith("-")).toBe(false);
    }
    expect(entries.find((e) => e.question === "What is DMARC?")?.id).toBe("what-is-dmarc");
  });

  it("marks an answer that carries an unsupplied fact as pending", () => {
    const pending = entries.filter((e) => e.pending);
    for (const entry of pending) expect(PENDING_TOKEN.test(entry.answer)).toBe(true);
    for (const entry of entries.filter((e) => !e.pending)) expect(PENDING_TOKEN.test(entry.answer), entry.question).toBe(false);
  });
});

describe("structured data", () => {
  it("ties the company, the site and the product together by stable ids", () => {
    const g = siteGraphJsonLd(SITE) as { "@graph": Array<Record<string, unknown>> };
    expect(g["@graph"].map((n) => n["@type"])).toEqual(["Organization", "WebSite", "SoftwareApplication"]);
    expect(g["@graph"].map((n) => n["@id"])).toEqual([
      `${SITE}/#organization`,
      `${SITE}/#website`,
      `${SITE}/#software`,
    ]);
    const org = g["@graph"][0]!;
    expect((org.logo as { url: string }).url).toBe(`${SITE}/icons/icon-512.png`);
    const text = JSON.stringify(g);
    expect(text).not.toMatch(/aggregateRating|review|supplied by the business/);
  });

  it("publishes only answered questions, each at its anchor on /faq", () => {
    const entries = faqEntries(faq.text);
    const page = faqPageJsonLd(SITE, "/faq", entries) as { mainEntity: Array<{ name: string; url: string; acceptedAnswer: { text: string } }> };
    const answered = entries.filter((e) => !e.pending);
    expect(page.mainEntity).toHaveLength(answered.length);
    for (const q of page.mainEntity) {
      expect(q.url.startsWith(`${SITE}/faq#`)).toBe(true);
      expect(PENDING_TOKEN.test(q.acceptedAnswer.text)).toBe(false);
    }
    expect(faqPageJsonLd(SITE, "/faq", [])).toBeNull();
  });

  it("prices flat plans on the product node and leaves the per-domain plan out", () => {
    const data = planOffersJsonLd(SITE, [
      { name: "Mooring", monthlyMinor: 0, pricing: "flat" },
      { name: "Fairway", monthlyMinor: 4900, pricing: "flat" },
      { name: "Fleet", monthlyMinor: 200, pricing: "per_domain" },
    ]) as { "@graph": Array<Record<string, unknown>> };
    const product = data["@graph"][0] as { "@id": string; offers: Array<{ name: string; price: string }> };
    expect(product["@id"]).toBe(nodeId(SITE, "software"));
    expect(product.offers.map((o) => [o.name, o.price])).toEqual([
      ["Mooring", "0.00"],
      ["Fairway", "49.00"],
    ]);
  });

  it("builds breadcrumbs from home and articles on the canonical origin", () => {
    const crumbs = breadcrumbJsonLd(SITE, [{ name: "API reference", path: "/docs/api" }]) as {
      itemListElement: Array<{ position: number; item: string }>;
    };
    expect(crumbs.itemListElement.map((i) => [i.position, i.item])).toEqual([
      [1, `${SITE}/`],
      [2, `${SITE}/docs/api`],
    ]);
    const article = techArticleJsonLd(SITE, { title: "API reference", description: "x", path: "/docs/api", version: "v1" });
    expect(article.url).toBe(`${SITE}/docs/api`);
    expect(article.version).toBe("v1");
  });

  it("cannot close its script element early", () => {
    expect(jsonLdString({ a: "</script><b>&" })).not.toMatch(/[<>&]/);
  });
});

function plan(over: Partial<PlanDefinition>): PlanDefinition {
  return {
    tier: "fairway",
    label: "Fairway",
    descriptor: "For a small client book.",
    prices: { USD: { monthlyMinor: 4900, annualMinor: 49000 }, INR: { monthlyMinor: 399900, annualMinor: 3999000 } },
    pricing: "flat",
    intervals: ["monthly", "annual"],
    minimumQuantity: null,
    maxClients: 10,
    maxActiveDomains: 25,
    maxMembers: 5,
    maxWorkspaces: 1,
    activeDomainWindowDays: 30,
    features: {} as PlanDefinition["features"],
    ...over,
  };
}

describe("llms.txt", () => {
  it("states plans as the catalogue does", () => {
    expect(money("USD", 4900)).toBe("USD 49");
    expect(money("USD", 450)).toBe("USD 4.50");
    expect(money("INR", 399900)).toBe("INR 3,999");
    expect(planLine(plan({}))).toBe(
      "- **Fairway**: For a small client book. USD 49 a month, or USD 490 a year (INR 3,999 a month in India). Up to 10 clients, 25 active domains, 5 team members, 1 workspace.",
    );
    expect(planLine(plan({ label: "Mooring", prices: { USD: { monthlyMinor: 0, annualMinor: 0 }, INR: { monthlyMinor: 0, annualMinor: 0 } } }))).toContain(
      "Free, no card.",
    );
    const fleet = planLine(
      plan({
        label: "Fleet",
        pricing: "per_domain",
        intervals: ["monthly"],
        minimumQuantity: 50,
        maxMembers: null,
        bands: [
          { upTo: 100, minimumQuantity: 50, unitMinor: { USD: 200, INR: 16000 } },
          { upTo: 1000, minimumQuantity: 101, unitMinor: { USD: 150, INR: 12000 } },
        ],
      }),
    );
    expect(fleet).toContain("Priced per active domain a month, USD 2 down to USD 1.50 a domain");
    expect(fleet).toContain("billed for at least 50 domains");
    expect(fleet).toContain("no team-size limit");
  });

  it("is an llmstxt.org index on the canonical origin", () => {
    const text = llmsTxt({ origin: SITE, plans: [plan({})] });
    expect(text.startsWith("# DMARC Harbor\n\n> DMARC Harbor is DMARC monitoring for MSPs and IT agencies.")).toBe(true);
    for (const path of ["/guide", "/faq", "/docs/api", "/pricing", "/verify", "/terms", "/privacy", "/llms-full.txt"]) {
      expect(text).toContain(`](${SITE}${path})`);
    }
    for (const url of text.match(/\]\(([^)]+)\)/g) ?? []) expect(url.startsWith(`](${SITE}/`)).toBe(true);
    expect(text).toContain("## Optional");
  });

  it("points at /pricing when the catalogue cannot be read", () => {
    const text = llmsTxt({ origin: SITE, plans: null });
    expect(text).toContain(`Current plans and prices: ${SITE}/pricing`);
    expect(text).not.toContain("**");
  });
});

describe("llms-full.txt", () => {
  it("leaves out every passage with an unsupplied fact, and keeps code whole", () => {
    const md = ["# T", "", "**Effective date:** to be set at launch", "", "Real text with a [link](/faq).", "", "```", "[NOT A TOKEN] stays", "", "in code", "```", "", "Email `[SECURITY EMAIL]`."].join("\n");
    const out = publishableMarkdown(md, SITE);
    expect(out).not.toContain("to be set at launch");
    expect(out).not.toContain("SECURITY EMAIL");
    expect(out).toContain(`[link](${SITE}/faq)`);
    expect(out).toContain("```\n[NOT A TOKEN] stays\n\nin code\n```");
  });

  it("carries the guide, the FAQ and the API reference with no pending fact outside code", () => {
    const docs = [
      { title: "Setup guide", path: "/guide", markdown: legalBody(LEGAL_BY_SLUG.get("guide")!).text },
      { title: "FAQ", path: "/faq", markdown: faq.text },
      ...DEVELOPER_DOCS.map((d) => ({ title: d.title, path: d.path, markdown: developerDocBody(d).text })),
    ];
    const text = llmsFullTxt({ origin: SITE, documents: docs });
    expect(text).toContain(`Address: ${SITE}/docs/api`);
    expect(text).toContain("**What is DMARC?**");
    const prose = text.replace(/```[\s\S]*?```/g, "");
    expect(PENDING_TOKEN.test(prose)).toBe(false);
  });
});
