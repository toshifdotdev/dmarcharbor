import { headers } from "next/headers";
import type { Metadata } from "next";
import { brandName } from "@/components/harbor/public-frame";
import { LEGAL_DOCS } from "./legal-docs";
import { readHostBrand } from "./host-brand";
import { canonicalOrigin } from "./site-origin";

/**
 * seo.ts — how this product wants to be read by a crawler.
 *
 * Three decisions live here and in lib/crawl-policy.ts, and each one is a
 * decision rather than a default:
 *
 * 1. WHICH ROUTES ARE INDEXED. An allowlist: marketing, the legal set and the
 *    developer documents, by exact path. Everything else is noindex, so a new
 *    signed-in screen is private without anyone remembering to say so.
 *
 * 2. WHICH HOST IS CANONICAL. Our public pages have one address, SITE_URL
 *    (lib/site-origin.ts), whichever of our hosts served them; an agency's
 *    verified domain is canonical for its own pages. A host that is neither
 *    is noindex throughout.
 *
 * 3. WHOSE NAME IS ON THE CARD. The social card and its site name follow the
 *    host's brand: an agency's own name on its verified domain, ours
 *    everywhere else (brandName in components/harbor/public-frame.tsx).
 *
 * There is deliberately no canonical in the root layout. A canonical on a
 * layout is inherited by every route under it, so `/clients` and `/alerts` were
 * each declaring themselves the homepage.
 */

export {
  INDEXABLE_ROUTES,
  LEGAL_ROUTE_PRIORITY,
  NOINDEX_PREFIXES,
  PUBLIC_PATHS,
  isIndexablePath,
  isNoindexPath,
  robotsFor,
  robotsForRequest,
} from "./crawl-policy";

export const SITE_NAME = "DMARC Harbor";

/** The fallback description: used wherever a page has nothing more specific. */
export const SITE_DESCRIPTION =
  "DMARC email-authentication monitoring for MSPs and IT agencies: posture per client domain, evidence you can hand over, and a client portal in your brand. Measurement first; DNS changes only when you ask.";

/** The product's own social summary: shorter than SITE_DESCRIPTION because a
 *  card is read at a glance and a listing at length. */
export const SITE_OG_DESCRIPTION =
  "Per-domain DMARC posture, compliance packs with a published fingerprint, and a client portal in your brand. It measures and proves, and changes DNS only when you ask.";

/**
 * The one social card for every public page, captioned in the host's name.
 *
 * A single card rather than a per-page one: the card's job is to say what
 * product a link belongs to. It has to be named here rather than left to the
 * file convention because `opengraph-image.tsx` is segment-scoped: the one in
 * app/ is applied to `/` and to nothing under it.
 */
export function ogImageFor(siteName: string) {
  return {
    url: "/opengraph-image",
    width: 1200,
    height: 630,
    alt: `${siteName}: every sender, mapped. DMARC monitoring for MSPs and agencies.`,
  } as const;
}

/** The social-object fields a public route shares, image included. Pure, so
 *  the brand and origin are the caller's to supply. */
export function openGraphFor(input: {
  title: string;
  description: string;
  path: string;
  origin: string;
  siteName: string;
  type: "website" | "article";
}) {
  return {
    siteName: input.siteName,
    title: `${input.title} · ${input.siteName}`,
    description: input.description,
    type: input.type,
    url: absoluteUrl(input.origin, input.path),
    images: [ogImageFor(input.siteName)],
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

/** The absolute URL of a route on an origin. */
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

/** A legal document's one-sentence summary, as its description tag says it. */
export function legalSummary(slug: string, title: string): string {
  return LEGAL_SUMMARIES[slug] ?? `${title} for ${SITE_NAME}.`;
}

/** The canonical origin and the host's display name, for a page's metadata. */
async function pageContext(): Promise<{ origin: string; siteName: string }> {
  const [origin, brand] = await Promise.all([canonicalOrigin(), readHostBrand()]);
  return { origin, siteName: brandName(brand) };
}

/**
 * Metadata for a legal document, derived from its entry in LEGAL_DOCS.
 *
 * The origin is the canonical one (lib/site-origin.ts), whatever the caller
 * passes: the second argument is accepted so existing pages keep compiling,
 * and is ignored, because the request's own host is exactly the address a
 * duplicate host must not claim.
 */
export async function legalMetadata(slug: string, requestOrigin?: string): Promise<Metadata> {
  void requestOrigin;
  const { origin, siteName } = await pageContext();
  const doc = LEGAL_DOCS.find((d) => d.slug === slug);
  const path = `/${slug}`;
  const title = doc?.title ?? slug;
  const description = legalSummary(slug, title);
  return {
    title,
    description,
    // Relative, against metadataBase, which the root layout sets to the same
    // canonical origin.
    alternates: { canonical: path },
    openGraph: openGraphFor({ title, description, path, origin, siteName, type: "article" }),
  };
}

/** Metadata for a plain public page. `origin` is ignored for the same reason
 *  as legalMetadata's second argument. */
export async function publicMetadata(input: {
  title: string;
  description: string;
  path: string;
  origin?: string;
}): Promise<Metadata> {
  const { origin, siteName } = await pageContext();
  return {
    title: input.title,
    description: input.description,
    alternates: { canonical: input.path },
    openGraph: openGraphFor({
      title: input.title,
      description: input.description,
      path: input.path,
      origin,
      siteName,
      type: "website",
    }),
  };
}
