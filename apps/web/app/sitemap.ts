import type { MetadataRoute } from "next";
import { requestOrigin } from "@/lib/metadata-origin";
import { INDEXABLE_ROUTES, LEGAL_ROUTE_PRIORITY } from "@/lib/seo";

/**
 * sitemap.ts — every URL this deployment offers a crawler.
 *
 * The list is the indexable set from lib/seo.ts, so the sitemap and the
 * no-index rules cannot disagree: adding a route there adds it here, and the
 * tenant artefacts never appear in either.
 *
 * `lastModified` is the moment the sitemap was rendered. There is no per-page
 * content date to read — the legal documents carry a version and an effective
 * date that is still "to be set at launch", and inventing a date to make a
 * sitemap look maintained would be worse than an honest one.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await requestOrigin();
  const now = new Date();

  return INDEXABLE_ROUTES.map((route) => ({
    url: new URL(route, origin).toString(),
    lastModified: now,
    changeFrequency: route === "/" ? ("weekly" as const) : ("monthly" as const),
    priority: LEGAL_ROUTE_PRIORITY[route] ?? 0.7,
  }));
}
