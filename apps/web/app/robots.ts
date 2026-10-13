import type { MetadataRoute } from "next";
import { requestOrigin } from "@/lib/metadata-origin";
import { NOINDEX_PREFIXES } from "@/lib/seo";

/**
 * robots.ts — what a crawler may read.
 *
 * Disallowing a prefix is a courtesy, not a control: the authoritative signal
 * is the `noindex` in each page's metadata (lib/seo.ts). Both are set because
 * they do different jobs — this one keeps a crawler from spending effort on
 * forty-odd private screens, and that one is what actually keeps a URL out of
 * an index once it has been fetched.
 *
 * The tenant artefacts are listed explicitly even though they carry noindex,
 * because they are reachable without a session and nothing else stops a bot
 * from walking every one of them.
 *
 * The word `Crawl-delay` is absent on purpose: Google ignores it, and Googlebot
 * has its own console setting for the crawl rate.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  // Against the request's host, not a constant, because this deployment serves
  // dmarcharbor.com and every agency's custom domain from one build.
  const origin = await requestOrigin();
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", ...NOINDEX_PREFIXES],
      },
    ],
    sitemap: new URL("/sitemap.xml", origin).toString(),
  };
}
