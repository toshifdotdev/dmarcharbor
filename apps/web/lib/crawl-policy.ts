import type { Metadata, MetadataRoute } from "next";
import { DEVELOPER_DOCS } from "./docs-registry";
import { LEGAL_DOCS, LEGAL_EFFECTIVE_DATE, SECURITY_EMAIL } from "./legal-docs";
import { ARTEFACT_PREFIXES, underPrefix, type HostKind } from "./site-host";

/**
 * crawl-policy.ts — what a crawler may index, crawl and be told, as pure
 * functions over a path, a host kind and an origin.
 *
 * The request-reading wrappers live in lib/seo.ts, app/robots.ts,
 * app/sitemap.ts and app/.well-known/security.txt/route.ts; the decisions live
 * here so tests/crawl-policy.test.ts can check them without a request.
 *
 * Indexing is an ALLOWLIST. A route is indexable only when it is one of the
 * public pages below, by exact path; everything else (the signed-in app, auth,
 * downloads, icons, a path nobody planned) is noindex. The old rule was the
 * reverse, a list of prefixes to hide, and every new screen that nobody added
 * to it was indexable by default: /account, /exports and /reports were.
 */

/**
 * Routes a crawler should read. The legal set is derived rather than repeated
 * so adding a document to LEGAL_DOCS adds it to the sitemap on the same edit.
 */
export const INDEXABLE_ROUTES: string[] = [
  "/",
  "/pricing",
  "/verify",
  // /support is its own route rather than a LEGAL_DOCS entry, because it is a
  // contact page and not a document with a version and an effective date.
  "/support",
  ...LEGAL_DOCS.map((d) => `/${d.slug}`),
];

/** Every public path, once: the pages above and the developer documents. */
export const PUBLIC_PATHS: string[] = [...new Set([...INDEXABLE_ROUTES, ...DEVELOPER_DOCS.map((d) => d.path)])];

/** How much each indexable route is worth a crawl, in the sitemap's 0.0–1.0.
 *  Advisory at best (Google ignores it); kept so the sitemap does not imply the
 *  complaint policy matters as much as pricing. */
export const LEGAL_ROUTE_PRIORITY: Record<string, number> = {
  "/": 1.0,
  "/pricing": 0.9,
  "/verify": 0.6,
  "/support": 0.5,
  "/faq": 0.7,
  "/guide": 0.7,
  "/terms": 0.5,
  "/privacy": 0.5,
  "/dpa": 0.4,
  "/refunds": 0.4,
  "/acceptable-use": 0.3,
  "/security": 0.4,
  "/sub-processors": 0.3,
  "/complaints": 0.3,
  "/cookies": 0.3,
};

/** Auth screens: a wall with nothing behind it for a crawler. */
export const AUTH_PREFIXES = ["/sign-in", "/sign-up", "/welcome"] as const;

/** The operator's app: behind a session and useless to anyone else. */
export const APP_PREFIXES = [
  "/account",
  "/alerts",
  "/billing",
  "/clients",
  "/digests",
  "/domains",
  "/exports",
  "/notifications",
  "/onboarding",
  "/prospects",
  "/reports",
  "/settings",
] as const;

/**
 * Every prefix that is never indexed, artefacts included. Kept for code that
 * asks "is this private"; indexing itself is decided by the allowlist.
 */
export const NOINDEX_PREFIXES: string[] = [...AUTH_PREFIXES, ...ARTEFACT_PREFIXES, ...APP_PREFIXES];

/** True when this path is inside one of the no-index prefixes. */
export function isNoindexPath(pathname: string): boolean {
  return underPrefix(pathname, NOINDEX_PREFIXES);
}

/** True when this exact path is a public page. */
export function isIndexablePath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname);
}

const INDEX: Metadata["robots"] = { index: true, follow: true };

// `follow` stays true: an indexed page may link here, and nofollow would
// throw away what those links say about the pages they point at.
const NOINDEX_FOLLOW: Metadata["robots"] = {
  index: false,
  follow: true,
  nocache: true,
  googleBot: { index: false, follow: true, nocache: true, noimageindex: true },
};

// For the tenant artefacts and the verifier on an agency's domain: the links
// on them lead to one agency's other documents, which are not ours to offer.
const NOINDEX_NOFOLLOW: Metadata["robots"] = {
  index: false,
  follow: false,
  nocache: true,
  googleBot: { index: false, follow: false, nocache: true, noimageindex: true },
};

/** The robots directive for one route on our own host: index only the public
 *  allowlist, by exact path. */
export function robotsFor(pathname: string): Metadata["robots"] {
  if (isIndexablePath(pathname)) return INDEX;
  if (underPrefix(pathname, ARTEFACT_PREFIXES)) return NOINDEX_NOFOLLOW;
  return NOINDEX_FOLLOW;
}

/**
 * The robots directive for a route on a given kind of host. Mirrors
 * robotsHeaderFor in lib/site-host.ts, which sends the same rule as a header.
 *
 *   own     the allowlist (robotsFor).
 *   agency  the same per-route rules, with the verifier noindex, nofollow.
 *   other   noindex everywhere: a duplicate of our pages or a host we do not
 *           know, whose canonical already names our own.
 */
export function robotsForRequest(pathname: string, kind: HostKind): Metadata["robots"] {
  if (kind === "other") return underPrefix(pathname, ARTEFACT_PREFIXES) ? NOINDEX_NOFOLLOW : NOINDEX_FOLLOW;
  if (kind === "agency" && pathname === "/verify") return NOINDEX_NOFOLLOW;
  return robotsFor(pathname);
}

/**
 * Crawlers named in robots.txt with the same rules as `*`.
 *
 * Decision: our public marketing and documentation pages exist to be found
 * and quoted, by search engines and by AI assistants alike, so every one of
 * these is allowed what `*` is allowed. Naming them makes the policy visible
 * and deliberate rather than an accident of the wildcard. Nothing private is
 * reachable without a session or a token, whichever crawler asks.
 */
export const NAMED_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "Bingbot",
  "Googlebot",
] as const;

/**
 * What robots.txt disallows on a host whose pages are served normally: the API
 * and the signed-in app and auth screens. The tenant artefacts are NOT listed:
 * they carry noindex (page metadata and X-Robots-Tag), and a crawler can only
 * read that if it may fetch them.
 */
export const ROBOTS_DISALLOW: string[] = ["/api/", ...AUTH_PREFIXES, ...APP_PREFIXES];

/**
 * robots.txt for one kind of host.
 *
 *   own     `*` and the named crawlers: allow /, disallow ROBOTS_DISALLOW, and
 *           the sitemap on the canonical origin.
 *   agency  the same rules and no sitemap (it would be empty).
 *   other   Disallow: / for everyone, and no sitemap.
 */
export function robotsFile(input: { kind: HostKind; origin: string }): MetadataRoute.Robots {
  if (input.kind === "other") return { rules: [{ userAgent: "*", disallow: "/" }] };
  const rule = { allow: "/", disallow: ROBOTS_DISALLOW };
  const rules = [
    { userAgent: "*", ...rule },
    { userAgent: [...NAMED_CRAWLERS], ...rule },
  ];
  if (input.kind === "agency") return { rules };
  return { rules, sitemap: new URL("/sitemap.xml", input.origin).toString() };
}

/** A YYYY-MM-DD string that is a real calendar date, or null. The legal set's
 *  effective date is "to be set at launch" until the business confirms it, and
 *  a placeholder must never become a <lastmod>. */
export function realDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

/** The legal documents proper. The FAQ and the setup guide sit in LEGAL_DOCS
 *  for their rendering, but the legal set's effective date says nothing about
 *  when they last changed. */
const DATED_LEGAL_PATHS = new Set(
  LEGAL_DOCS.filter((d) => d.slug !== "faq" && d.slug !== "guide").map((d) => `/${d.slug}`),
);

/**
 * The sitemap for our own host: every public path on the canonical origin.
 *
 * `lastModified` only where a real date exists (the legal set's effective date,
 * once it is one). It used to be the moment the sitemap was rendered, on every
 * entry, which tells a crawler every page changed on every fetch.
 */
export function sitemapEntries(origin: string, effectiveDate: string = LEGAL_EFFECTIVE_DATE): MetadataRoute.Sitemap {
  const legalDate = realDate(effectiveDate);
  return PUBLIC_PATHS.map((route) => ({
    url: new URL(route, origin).toString(),
    ...(legalDate && DATED_LEGAL_PATHS.has(route) ? { lastModified: legalDate } : {}),
    changeFrequency: route === "/" ? ("weekly" as const) : ("monthly" as const),
    priority: LEGAL_ROUTE_PRIORITY[route] ?? 0.7,
  }));
}

/** How long a security.txt stays valid. RFC 9116 asks for less than a year. */
export const SECURITY_TXT_VALID_DAYS = 180;

/**
 * /.well-known/security.txt (RFC 9116). The contact is the security address
 * (lib/legal-docs.ts SECURITY_EMAIL), the same one docs/SECURITY.md names.
 * Expires is recomputed on each request, so the file never lapses while the
 * site is up.
 */
export function securityTxt(input: { origin: string; now: Date }): string {
  const expires = new Date(input.now.getTime() + SECURITY_TXT_VALID_DAYS * 24 * 60 * 60 * 1000);
  return [
    `Contact: mailto:${SECURITY_EMAIL}`,
    `Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    "Preferred-Languages: en",
    `Canonical: ${new URL("/.well-known/security.txt", input.origin).toString()}`,
    `Policy: ${new URL("/security", input.origin).toString()}`,
    "",
  ].join("\n");
}
