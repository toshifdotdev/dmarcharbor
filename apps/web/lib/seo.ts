import { headers } from "next/headers";
import type { Metadata } from "next";
import { LEGAL_DOCS } from "./legal-docs";

/**
 * seo.ts — how this product wants to be read by a crawler.
 *
 * Three decisions live here, and each one is a decision rather than a default:
 *
 * 1. WHICH ROUTES ARE PUBLIC. Only marketing and the legal set exist to be read
 *    by a stranger. Everything else is behind a session, or is one agency's
 *    artefact.
 *
 * 2. WHICH ROUTES MUST NOT BE INDEXED. A tenant artefact (`/share/:token`,
 *    `/portal/...`, `/trust/:slug`) is the same document twice over: once under
 *    the agency's own custom domain and once under ours. Indexing the second
 *    copy makes it a duplicate of the first, and the agency's brand is ours in
 *    the meantime. The auth screens are a login wall with no content behind it.
 *
 * 3. WHERE A CANONICAL POINTS. It points at the host the request arrived on,
 *    because this build serves dmarcharbor.com AND every agency's custom domain
 *    from one deployment. See lib/metadata-origin.ts.
 *
 * There is deliberately no canonical in the root layout. A canonical on a
 * layout is inherited by every route under it, so `/clients` and `/alerts` were
 * each declaring themselves the homepage. That is a soft duplicate-content
 * signal, and it applied to forty-odd pages nobody ever meant to point there.
 */

export const SITE_NAME = "DMARC Harbor";

/** The fallback description: used wherever a page has nothing more specific. */
export const SITE_DESCRIPTION =
  "DMARC email-authentication monitoring for MSPs and IT agencies: posture per client domain, evidence you can hand over, and a client portal in your brand. Measurement first; DNS changes only when you ask.";

/** The product's own social summary: shorter than SITE_DESCRIPTION because a
 *  card is read at a glance and a listing at length. */
export const SITE_OG_DESCRIPTION =
  "Per-domain DMARC posture, compliance packs with a published fingerprint, and a client portal in your brand. It measures and proves, and changes DNS only when you ask.";

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

/**
 * The one social card for every public page.
 *
 * A single card rather than a per-page one: the card's job is to say what
 * product a link belongs to, and eleven variants of the same sentence buy
 * nothing. A route that genuinely needs its own card declares it in its own
 * segment, which is how app/opengraph-image.tsx works for `/`.
 *
 * It has to be named here rather than left to the file convention because
 * `opengraph-image.tsx` is segment-scoped: the one in app/ is applied to `/`
 * and to nothing under it. `/pricing` was reaching a card-less social preview
 * until it said so.
 */
const OG_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "DMARC Harbor — measurement first, changes only when you ask",
} as const;

/** The social-object fields a public route shares, image included. */
function openGraphFor(input: {
  title: string;
  description: string;
  path: string;
  origin: string;
  type: "website" | "article";
}) {
  return {
    siteName: SITE_NAME,
    title: `${input.title} · ${SITE_NAME}`,
    description: input.description,
    type: input.type,
    url: absoluteUrl(input.origin, input.path),
    images: [OG_IMAGE],
  };
}

/** How much each indexable route is worth a crawl, in Google's own 0.0–1.0.
 *  A hint, and a weak one: Google has said repeatedly it treats priority as
 *  advisory. It is here because the alternative is leaving it off and letting
 *  the sitemap imply that the complaint policy matters as much as pricing. */
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

/** Path prefixes that must never be indexed. Matched on the route segment, not
 *  a full-path equality, so `/settings/api-keys` is caught by `/settings`. */
export const NOINDEX_PREFIXES: string[] = [
  // Auth screens: a wall, with nothing behind it for a crawler.
  "/sign-in",
  "/sign-up",
  "/welcome",
  // Tenant artefacts. Same content as an agency's own domain: the second copy
  // is a duplicate, and it carries our brand instead of theirs.
  "/portal",
  "/share",
  "/trust",
  "/prospect",
  // The operator's app. Behind a session, and useless to anyone else.
  "/clients",
  "/alerts",
  "/billing",
  "/digests",
  "/notifications",
  "/prospects",
  "/domains",
  "/onboarding",
  "/settings",
];

/** True when this path is inside one of the no-index prefixes. */
export function isNoindexPath(pathname: string): boolean {
  return NOINDEX_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * The robots directive for one route. Page-level metadata overrides the root's,
 * so this is what keeps the forty-odd protected screens out of an index while
 * the marketing and legal set stays in.
 */
export function robotsFor(pathname: string): Metadata["robots"] {
  if (!isNoindexPath(pathname)) {
    return { index: true, follow: true };
  }
  // `follow` still true: an indexed page may legitimately link to these, and a
  // nofollow here would throw away the signal those links carry.
  return {
    index: false,
    follow: true,
    nocache: true,
    googleBot: { index: false, follow: true, nocache: true, noimageindex: true },
  };
}

/**
 * The path of the request being served.
 *
 * The proxy stamps it (it already runs on every request for branding and the
 * CSP nonce), because a layout's `generateMetadata` has no other way to know
 * which route it is rendering and must therefore decide indexability for all of
 * them at once.
 */
export async function currentPathname(): Promise<string> {
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    return "/";
  }
  return h.get("x-harbor-path") ?? "/";
}

/** The absolute URL of a route on the host that served it. */
export function absoluteUrl(origin: string, path: string): string {
  return new URL(path, origin).toString();
}

/** The one-sentence summary of a legal document, for a description tag. */
const LEGAL_SUMMARIES: Record<string, string> = {
  privacy: "What we collect, why, how long we keep it, and who we share it with.",
  terms: "The agreement between DMARC Harbor and you: order process, merchant of record, and the parties.",
  dpa: "What we do with personal data on your behalf when you use DMARC Harbor.",
  refunds: "How refunds work, and who the merchant of record is for each payment route.",
  "acceptable-use": "What you may and may not do with DMARC Harbor.",
  security: "How DMARC Harbor is built and run: controls, reporting and disclosure.",
  "sub-processors": "Every third party that handles data on our behalf, and what each one does.",
  faq: "What the product does, what it costs, and how the measurements are derived.",
  guide: "Every step from a new account to a client domain at p=reject, and the plan each step needs.",
  complaints: "How to raise a complaint, and the answers you can expect.",
  cookies: "Which cookies we set and why. There is no advertising or analytics cookie.",
};

/** Metadata for a legal document, derived from its entry in LEGAL_DOCS. */
export function legalMetadata(slug: string, origin: string): Metadata {
  const doc = LEGAL_DOCS.find((d) => d.slug === slug);
  const path = `/${slug}`;
  const title = doc?.title ?? slug;
  const description =
    LEGAL_SUMMARIES[slug] ?? `${title} for DMARC Harbor.`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: openGraphFor({
      title,
      description,
      path,
      origin,
      type: "article",
    }),
  };
}

/** Metadata for a plain public page. */
export function publicMetadata(input: {
  title: string;
  description: string;
  path: string;
  origin: string;
}): Metadata {
  return {
    title: input.title,
    description: input.description,
    alternates: { canonical: input.path },
    openGraph: openGraphFor({ ...input, type: "website" }),
  };
}
