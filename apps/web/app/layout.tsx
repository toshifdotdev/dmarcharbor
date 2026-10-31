import type { Metadata } from "next";
import { Albert_Sans, Atkinson_Hyperlegible_Mono } from "next/font/google";
import { BrandApplier } from "@/components/brand-applier";
import { StructuredData } from "@/components/structured-data-view";
import { requestOrigin } from "@/lib/metadata-origin";
import { currentPathname, robotsFor, SITE_DESCRIPTION, SITE_NAME } from "@/lib/seo";
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

export async function generateMetadata(): Promise<Metadata> {
  // metadataBase against the REQUEST's own origin: this build serves the
  // product domain and branded custom domains at once, so a hardcoded base
  // would claim the wrong host on every agency's site. openGraph rides the
  // same origin so shared links resolve.
  const origin = await requestOrigin();
  // Which route this is, so the indexability below is right for it. Without
  // this the root metadata is inherited verbatim by every page, and a
  // canonical on the root named the homepage for all of them.
  const pathname = await currentPathname();
  return {
    metadataBase: new URL(origin),
    title: {
      default: SITE_NAME,
      template: `%s · ${SITE_NAME}`,
    },
    description: SITE_DESCRIPTION,
    // No `alternates.canonical` here: a canonical on a layout applies to every
    // route under it. Each public page declares its own in lib/seo.ts.
    applicationName: SITE_NAME,
    robots: robotsFor(pathname),
    // A crawler must not be told to revisit on a timer it may not honour.
    // Cache headers come from the response, not from here.
    openGraph: {
      siteName: SITE_NAME,
      title: SITE_NAME,
      description: SITE_DESCRIPTION,
      type: "website",
      images: [
        {
          url: "/opengraph-image",
          width: 1200,
          height: 630,
          alt: "DMARC Harbor: every sender, mapped. DMARC monitoring for MSPs and agencies.",
        },
      ],
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
  const origin = await requestOrigin();
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
            they are absent rather than invented. */}
        <StructuredData data={siteGraphJsonLd(origin)} />
        {children}
      </body>
    </html>
  );
}
