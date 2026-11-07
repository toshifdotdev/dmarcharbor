/**
 * llms.ts — /llms.txt and /llms-full.txt, the plain-text map of this site for
 * AI assistants and answer engines (the llmstxt.org convention: a title, a
 * one-paragraph summary, then sections of links with a line on each).
 *
 *   /llms.txt       what the product is, where each public document lives,
 *                   and the plans as GET /api/plans states them.
 *   /llms-full.txt  the setup guide, the FAQ and the API reference in full,
 *                   from the same files the pages render (docs/).
 *
 * Every claim here is either a constant that the home page also makes, a
 * document's own text, or the plan catalogue. A passage that still carries a
 * fact the business has not supplied (legal-markdown.ts PENDING_TOKEN) is
 * left out rather than repeated as a fact: a machine quoting
 * "[legal entity name: supplied by the business before launch]" as our name
 * is worse than one that never read the line.
 *
 * Pure, with no "@/" imports, so tests/llms.test.ts can load it. The routes
 * (app/llms.txt, app/llms-full.txt) supply the origin and the catalogue.
 */

import { PENDING_TOKEN } from "../components/harbor/legal-markdown";
import { DEVELOPER_DOCS } from "./docs-registry";
import { LEGAL_DOCS } from "./legal-docs";
import { FREE_TOOLS } from "./tools";
import type { PlanDefinition } from "./types";

export const LLMS_NAME = "DMARC Harbor";

/** The one-sentence definition, also said on the home page. */
export const LLMS_SUMMARY =
  "DMARC Harbor is DMARC monitoring for MSPs and IT agencies. It reads the DMARC reports that receiving mail servers send about each client domain, shows every service sending as that domain, and says when each domain is ready to move to p=quarantine and then p=reject.";

const LLMS_DETAIL = [
  "It measures and proves. It never sends mail as anyone, and it changes DNS only when you ask, through a Cloudflare connection you add or a record it hosts for you.",
  "Each client domain reads as exactly one of pass, block, unverified, stale or unmeasured, from report data; a domain that has never reported is never called passing.",
  "Agencies can hand clients compliance packs with a published SHA-256 fingerprint that anyone can check on the verify page, revocable report share links, and a client portal in the agency's own brand.",
  "Free tools at /tools read any domain's DMARC, SPF, DKIM and BIMI records from public DNS with no account: the DMARC record tag by tag, SPF lookups counted through every include against the limit of 10, a DKIM selector's key with its size, the BIMI record and logo rules, and a DMARC record generator.",
].join(" ");

/** The documents an answer engine is most likely to need, with what each answers. */
const DOCUMENTATION: Array<{ path: string; title: string; note: string }> = [
  { path: "/guide", title: "Setup guide", note: "every step from a new account to a client domain at p=reject, and the plan each step needs" },
  { path: "/faq", title: "Frequently asked questions", note: "what the product does, what each plan includes and costs, limits, billing, monitoring and alerts" },
  ...DEVELOPER_DOCS.map((d) => ({ path: d.path, title: d.title, note: d.summary })),
];

const PRODUCT_PAGES: Array<{ path: string; title: string; note: string }> = [
  { path: "/pricing", title: "Pricing", note: "every plan's price in USD and INR, monthly and annual, its limits and its features" },
  { path: "/verify", title: "Document fingerprint verifier", note: "check that a compliance pack or monthly report is the one issued, by its SHA-256 fingerprint; no account needed" },
  { path: "/tools", title: "Free DNS tools", note: "free DMARC, SPF, DKIM and BIMI lookups and a DMARC record generator; no account needed" },
  ...FREE_TOOLS.map((t) => {
    const note = t.description.replace(/ Free, no account\.$/, "").replace(/\.$/, "");
    return { path: t.path, title: t.title, note: `${note.charAt(0).toLowerCase()}${note.slice(1)}; no account needed` };
  }),
  { path: "/support", title: "Support and contact", note: "how to reach support" },
];

/** The legal set, minus the two documents already listed as documentation. */
const LEGAL_PAGES = LEGAL_DOCS.filter((d) => d.slug !== "faq" && d.slug !== "guide").map((d) => ({
  path: `/${d.slug}`,
  title: d.title,
}));

function link(origin: string, path: string, title: string, note?: string): string {
  const url = new URL(path, origin).toString();
  return `- [${title}](${url})${note ? `: ${note}` : ""}`;
}

/** An amount in minor units as people write it: "USD 49", "USD 4.50", "INR 3,999". */
export function money(currency: "USD" | "INR", minor: number): string {
  const major = minor / 100;
  const text = major.toLocaleString(currency === "INR" ? "en-IN" : "en-US", {
    minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${currency} ${text}`;
}

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

/** One plan as a line: its name and descriptor, its price, its limits. */
export function planLine(plan: PlanDefinition): string {
  let price: string;
  if (plan.pricing === "per_domain") {
    const bands = plan.bands ?? [];
    const lowest = bands.length > 0 ? Math.min(...bands.map((b) => b.unitMinor.USD)) : plan.prices.USD.monthlyMinor;
    const highest = bands.length > 0 ? Math.max(...bands.map((b) => b.unitMinor.USD)) : plan.prices.USD.monthlyMinor;
    const range = lowest === highest ? money("USD", lowest) : `${money("USD", highest)} down to ${money("USD", lowest)}`;
    price = `priced per active domain a month, ${range} a domain as the count grows${
      plan.minimumQuantity ? `, billed for at least ${plural(plan.minimumQuantity, "domain", "domains")}` : ""
    }`;
  } else if (plan.prices.USD.monthlyMinor === 0) {
    price = "free, no card";
  } else {
    const annual = plan.intervals.includes("annual") ? `, or ${money("USD", plan.prices.USD.annualMinor)} a year` : "";
    price = `${money("USD", plan.prices.USD.monthlyMinor)} a month${annual} (${money("INR", plan.prices.INR.monthlyMinor)} a month in India)`;
  }
  const limits = [
    plural(plan.maxClients, "client", "clients"),
    plural(plan.maxActiveDomains, "active domain", "active domains"),
    plan.maxMembers === null ? "no team-size limit" : plural(plan.maxMembers, "team member", "team members"),
    plural(plan.maxWorkspaces, "workspace", "workspaces"),
  ].join(", ");
  const descriptor = plan.descriptor ? `: ${plan.descriptor.replace(/\.$/, "")}` : "";
  return `- **${plan.label}**${descriptor}. ${price[0]!.toUpperCase()}${price.slice(1)}. Up to ${limits}.`;
}

/** /llms.txt. `plans` is null when the catalogue could not be read. */
export function llmsTxt(input: { origin: string; plans: PlanDefinition[] | null }): string {
  const { origin } = input;
  const lines: string[] = [
    `# ${LLMS_NAME}`,
    "",
    `> ${LLMS_SUMMARY}`,
    "",
    LLMS_DETAIL,
    "",
    "## Documentation",
    "",
    ...DOCUMENTATION.map((d) => link(origin, d.path, d.title, d.note)),
    "",
    "## Product",
    "",
    ...PRODUCT_PAGES.map((d) => link(origin, d.path, d.title, d.note)),
    "",
    "## Plans",
    "",
  ];
  if (input.plans && input.plans.length > 0) {
    lines.push(
      ...input.plans.map(planLine),
      "",
      `Limits count clients and active domains across every workspace an account owns. The pricing page is the current source: ${new URL("/pricing", origin).toString()}`,
    );
  } else {
    lines.push(`The plan catalogue could not be read just now. Current plans and prices: ${new URL("/pricing", origin).toString()}`);
  }
  lines.push(
    "",
    "## Legal",
    "",
    ...LEGAL_PAGES.map((d) => link(origin, d.path, d.title)),
    "",
    "## Optional",
    "",
    link(origin, "/llms-full.txt", "Full text", "the setup guide, the FAQ and the API reference in one plain-text file"),
    "",
  );
  return lines.join("\n");
}

/**
 * A document's markdown with every passage that carries a pending fact left
 * out, and site-relative links made absolute. A passage is a run of non-blank
 * lines; a fenced code block is kept whole, whatever it contains, because an
 * example is copied exactly.
 */
export function publishableMarkdown(markdown: string, origin: string): string {
  const out: string[] = [];
  let chunk: string[] = [];
  let fence: string[] | null = null;
  const flush = () => {
    if (chunk.length > 0 && !PENDING_TOKEN.test(chunk.join("\n"))) out.push(chunk.join("\n"));
    chunk = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      fence.push(line);
      if (/^```\s*$/.test(line)) {
        out.push(fence.join("\n"));
        fence = null;
      }
      continue;
    }
    if (/^```/.test(line)) {
      flush();
      fence = [line];
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    chunk.push(line.replace(/\]\(\/(?!\/)/g, `](${new URL("/", origin).toString()}`));
  }
  flush();
  if (fence) out.push(fence.join("\n"));
  return out.join("\n\n");
}

export interface FullTextDocument {
  title: string;
  path: string;
  markdown: string;
}

/** /llms-full.txt: each document under its title and address. */
export function llmsFullTxt(input: { origin: string; documents: FullTextDocument[] }): string {
  const parts = [
    `# ${LLMS_NAME}: full text`,
    "",
    `> ${LLMS_SUMMARY}`,
    "",
    `The documents below are the same text as the pages they name. The index is ${new URL("/llms.txt", input.origin).toString()}.`,
  ];
  for (const doc of input.documents) {
    parts.push(
      "",
      "---",
      "",
      `Document: ${doc.title}`,
      `Address: ${new URL(doc.path, input.origin).toString()}`,
      "",
      publishableMarkdown(doc.markdown, input.origin),
    );
  }
  parts.push("");
  return parts.join("\n");
}
