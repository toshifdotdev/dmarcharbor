import type { MetadataRoute } from "next";
import { robotsFile } from "@/lib/crawl-policy";
import { canonicalOrigin, currentHostKind } from "@/lib/site-origin";

/**
 * robots.ts — what a crawler may fetch, per host (lib/crawl-policy.ts
 * robotsFile holds the rules and their tests).
 *
 *   our host       `*` and the named search and AI crawlers, each with the same
 *                  rules: allow /, disallow the API, the signed-in app and the
 *                  auth screens; the sitemap on the canonical origin.
 *   agency domain  the same rules, no sitemap (it is empty there).
 *   any other host Disallow: / and no sitemap. It is a duplicate of our pages
 *                  or a host we do not know.
 *
 * Disallowing is a crawl rule, not an index rule. The tenant artefacts
 * (/share, /trust, /prospect, /portal) are deliberately left crawlable: a
 * disallowed URL can still be indexed from a link, without its noindex ever
 * being read. They say noindex in their metadata and in an X-Robots-Tag header
 * from proxy.ts.
 *
 * No `Crawl-delay`: Google ignores it, and Googlebot's crawl rate has its own
 * console setting.
 */
// Per request: the answer depends on the Host. A metadata route is cached by
// default unless it reads request data, and the host helpers catch the
// headers() error a build-time render throws, so it is said outright.
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  return robotsFile({ kind: await currentHostKind(), origin: await canonicalOrigin() });
}
