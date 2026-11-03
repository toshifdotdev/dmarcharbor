import type { Metadata, Viewport } from "next";
import { Albert_Sans, Atkinson_Hyperlegible_Mono } from "next/font/google";
import { BrandApplier } from "@/components/brand-applier";
import { brandName } from "@/components/harbor/public-frame";
import { StructuredData } from "@/components/structured-data-view";
import { readHostBrand } from "@/lib/host-brand";
import { currentPathname, ogImageFor, robotsForRequest, SITE_DESCRIPTION } from "@/lib/seo";
import { verificationToken } from "@/lib/site-config";
import { canonicalOrigin, currentHostKind } from "@/lib/site-origin";
import { siteGraphJsonLd } from "@/lib/structured-data";
import "./globals.css";

/**
 * The Routes design's two faces (.kiro/steering/design-system.md).
 *
 * Albert Sans is the one family for everything a person reads, headings to
 * table cells, as a variable font (400 to 760). Atkinson Hyperlegible Mono is
 * the data face for literal DNS and identifiers, chosen because it is drawn to
 * keep 0/O, 1/l/I and 5/S apart.
 */
const routes = Albert_Sans({
  subsets: ["latin"],
  variable: "--font-routes",
  display: "swap",
});

const hyperMono = Atkinson_Hyperlegible_Mono({
  subsets: ["latin"],
  variable: "--font-hyper-mono",
  display: "swap",
  // Next has no fallback metrics for this family; without this it warns and
  // falls back to the platform monospace unadjusted anyway.
  adjustFontFallback: false,
});

/**
 * The viewport, as its own export (the `viewport` metadata field is deprecated
 * since Next 14: node_modules/next/dist/docs/01-app/03-api-reference/
 * 04-functions/generate-viewport.md). Width and scale are Next's own defaults,
 * stated so the theme colour does not drop them; the theme colour is the
 * page's white ground.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

/** Search-console ownership tags, from the environment, for our own host only. */
function searchConsoleVerification(): Metadata["verification"] | undefined {
  // A pasted whole tag is reduced to its token; anything else is dropped
  // (lib/site-config.ts verificationToken).
  const google = verificationToken(process.env.GOOGLE_SITE_VERIFICATION);
  const bing = verificationToken(process.env.BING_SITE_VERIFICATION);
  if (!google && !bing) return undefined;
  return {
    ...(google ? { google } : {}),
    ...(bing ? { other: { "msvalidate.01": bing } } : {}),
  };
}

export async function generateMetadata(): Promise<Metadata> {
  // metadataBase is the CANONICAL origin (lib/site-origin.ts): SITE_URL for our
  // pages on any of our hosts, the agency's own origin on its verified domain.
  // Every relative canonical and og:url under it resolves there, so a www. or
  // unknown host never claims to be the original of our pages, and an agency's
  // page never points at ours.
  const [origin, kind, pathname, brand] = await Promise.all([
    canonicalOrigin(),
    currentHostKind(),
    // Which route this is, so the indexability below is right for it. Without
    // this the root metadata is inherited verbatim by every page.
    currentPathname(),
    readHostBrand(),
  ]);
  // The tab title names the host's brand: an agency's own name on its verified
  // domain (its portal, its error pages), ours everywhere else, and never an
  // unverified agency name.
  const name = brandName(brand);
  const verification = kind === "own" ? searchConsoleVerification() : undefined;
  return {
    metadataBase: new URL(origin),
    title: {
      default: name,
      template: `%s · ${name}`,
    },
    description: SITE_DESCRIPTION,
    // No `alternates.canonical` here: a canonical on a layout applies to every
    // route under it. Each public page declares its own in lib/seo.ts.
    applicationName: name,
    // The public allowlist on our host and an agency's; noindex throughout on
    // any other host. proxy.ts sends the same rule as X-Robots-Tag.
    robots: robotsForRequest(pathname, kind),
    ...(verification ? { verification } : {}),
    // A crawler must not be told to revisit on a timer it may not honour.
    // Cache headers come from the response, not from here.
    openGraph: {
      siteName: name,
      title: name,
      description: SITE_DESCRIPTION,
      type: "website",
      images: [ogImageFor(name)],
    },
    twitter: {
      // No title or description here on purpose: both fall back to the page's
      // own `title` and `description`, and naming them on the root pinned every
      // card in the product to the same sentence no matter which page was
      // shared.
      card: "summary_large_image",
    },
  };
}

// Every route in this app renders per request: the session cookie picks the
// workspace and the custom-Host header picks the brand. There is nothing to
// prerender, and forcing that is what made Next's synthetic error pages crash
// (the root layout's headers() has no request store in a static export).
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [origin, kind] = await Promise.all([canonicalOrigin(), currentHostKind()]);
  return (
    <html lang="en" className={`${routes.variable} ${hyperMono.variable}`}>
      <body>
        {/* Both of these emit a raw element - a <style> and a <script> - and
            they live INSIDE <body> on purpose.

            They used to sit as direct children of <html>, which is not valid
            HTML: <html> may only contain <head> and <body>. React rejected it
            three ways on every page ("<script> cannot be a child of <html>",
            "<html> cannot contain a nested <script>", and "cannot render a sync
            or defer <script> outside the main document without knowing its
            order"), because a script that is neither in the head nor in the body
            has no document position to be hoisted into.

            Inside <body> both are ordinary flow content: the <style> applies
            before the page paints, and the JSON-LD block is read by crawlers
            from the body exactly as they read it from the head. Order matters
            here - the brand tokens have to land before anything paints, and the
            entity graph wants to precede the markup it describes. */}
        {/* BrandApplier: on a custom domain this is the agency's palette
            replacing ours at the token level — every screen, not just the chrome.
            Nothing renders unless the record is verified. */}
        <BrandApplier />
        {/* The company and the product, in the machine-readable copy a crawler
            builds an entity card from. Only the facts that are settled: the legal
            entity name, phone and address are placeholders until supplied, so
            they are absent rather than invented. Never on an agency's verified
            domain: every page there is the agency's, and our entity graph
            would name us as its publisher. */}
        {kind === "agency" ? null : <StructuredData data={siteGraphJsonLd(origin)} />}
        {children}
      </body>
    </html>
  );
}
