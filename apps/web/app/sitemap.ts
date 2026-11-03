import type { MetadataRoute } from "next";
import { sitemapEntries } from "@/lib/crawl-policy";
import { canonicalOrigin, currentHostKind } from "@/lib/site-origin";

/**
 * sitemap.ts — every URL our own host offers a crawler.
 *
 * The list is the public allowlist (lib/crawl-policy.ts PUBLIC_PATHS: the
 * marketing pages, the legal set and the developer documents), so the sitemap
 * and the robots meta cannot disagree. Every URL is on the canonical origin
 * (SITE_URL), whichever of our hosts served the file.
 *
 * `lastModified` is set only where a real date exists: the legal set's
 * effective date, once lib/legal-docs.ts carries one instead of "to be set at
 * launch". It used to be the moment of the request on every entry.
 *
 * Empty on every host that is not our own public host: an agency's verified
 * domain (our pages redirect to its portal there) and any duplicate or unknown
 * host (noindex throughout).
 */
// Per request, for the same reason as app/robots.ts: the answer depends on the Host.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if ((await currentHostKind()) !== "own") return [];
  return sitemapEntries(await canonicalOrigin());
}
