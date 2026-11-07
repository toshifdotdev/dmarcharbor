/**
 * tools.ts — the free lookup tools, once: their paths, names and the words
 * search results and the llms.txt index use. The pages, the footer, the
 * sitemap allowlist and llms.txt all read this list, so a tool added here is
 * added everywhere on the same edit.
 *
 * Every lookup runs through the public scanner (POST /api/scan): no account,
 * nothing stored about the domain. The generator runs in the browser alone.
 */

export interface FreeTool {
  slug: "dmarc" | "spf" | "dkim" | "bimi" | "dmarc-generator";
  path: string;
  /** Bold name, as a station label. */
  name: string;
  /** The lighter kind beside it. */
  kind: string;
  /** The page title and its search description. */
  title: string;
  description: string;
}

export const FREE_TOOLS: FreeTool[] = [
  {
    slug: "dmarc",
    path: "/tools/dmarc",
    name: "DMARC lookup",
    kind: "a policy, read tag by tag",
    title: "DMARC record lookup",
    description:
      "Read any domain's DMARC record from public DNS, tag by tag: the policy, where reports go, alignment and testing mode, with what each makes a receiving server do. Free, no account.",
  },
  {
    slug: "spf",
    path: "/tools/spf",
    name: "SPF lookup",
    kind: "every include, counted",
    title: "SPF record lookup and DNS lookup counter",
    description:
      "Read a domain's SPF record and count its DNS lookups the way receivers do, through every include, against the limit of 10. Free, no account.",
  },
  {
    slug: "dkim",
    path: "/tools/dkim",
    name: "DKIM lookup",
    kind: "a selector's public key",
    title: "DKIM record lookup",
    description:
      "Look up a DKIM selector's public key, or let the scanner find the selectors a domain's mail services use. Shows key type, size and revoked keys. Free, no account.",
  },
  {
    slug: "bimi",
    path: "/tools/bimi",
    name: "BIMI lookup",
    kind: "the logo record and its checks",
    title: "BIMI record lookup",
    description:
      "Check a domain's BIMI record, its logo file against the SVG Tiny PS rules, its certificate link, and whether its DMARC policy lets the logo show. Free, no account.",
  },
  {
    slug: "dmarc-generator",
    path: "/tools/dmarc-generator",
    name: "DMARC generator",
    kind: "a record to publish",
    title: "DMARC record generator",
    description:
      "Write a DMARC record to publish: choose the policy, report addresses, alignment and testing mode, and copy the TXT record with what each tag will do. Free, no account.",
  },
];

/** The index page, then each tool. */
export const TOOL_PATHS: string[] = ["/tools", ...FREE_TOOLS.map((t) => t.path)];

export function toolBySlug(slug: FreeTool["slug"]): FreeTool {
  const tool = FREE_TOOLS.find((t) => t.slug === slug);
  if (!tool) throw new Error(`No free tool ${slug}`);
  return tool;
}
