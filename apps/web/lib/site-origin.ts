import { headers } from "next/headers";
import { readHostBrand } from "./host-brand";
import { requestOrigin } from "./metadata-origin";
import {
  HOST_KIND_HEADER,
  canonicalOriginFor,
  hostKind,
  hostnameOf,
  parseHostKind,
  siteOriginFrom,
  type HostKind,
} from "./site-host";

/**
 * site-origin.ts — the one address search engines and AI crawlers should know
 * our public pages by, and whether this request is on it.
 *
 * One build answers on several hosts: our own (dmarcharbor.com, and possibly
 * www. or app. pointed at the same deployment), every agency's verified custom
 * domain, and any hostname someone points at us without verifying it. Every
 * canonical, og:url, sitemap entry and JSON-LD @id used to follow whatever Host
 * arrived, so each of those hosts claimed to be the original of the same page.
 *
 *   SITE_URL     the public origin, for example https://dmarcharbor.com. Read
 *                on the server only, at runtime. Unset (development, the verify
 *                harness) means "the host the request came in on", as before.
 *
 * On an agency's verified domain the agency's own origin is canonical for the
 * pages served there (its portal, its Trust Centers), so an agency's page never
 * points at ours and ours never points at an agency's.
 *
 * The decisions are pure functions in lib/site-host.ts. The proxy makes the
 * same decision for its X-Robots-Tag header and stamps it on the request
 * (x-harbor-host-kind), and this reads the stamp first, so the header and the
 * page's robots meta cannot disagree.
 */

function configuredSiteOrigin(): string | null {
  return siteOriginFrom(process.env.SITE_URL);
}

/** Which kind of host this request is on: own, agency or other. */
export async function currentHostKind(): Promise<HostKind> {
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    // No request (a static render): the canonical host is the only one there is.
    return "own";
  }
  const stamped = parseHostKind(h.get(HOST_KIND_HEADER));
  if (stamped) return stamped;
  const brand = await readHostBrand();
  return hostKind({
    state: brand.state,
    hostname: hostnameOf(h.get("x-forwarded-host") ?? h.get("host")),
    siteOrigin: configuredSiteOrigin(),
  });
}

/** The origin canonical URLs, the sitemap and structured data are built on. */
export async function canonicalOrigin(): Promise<string> {
  return canonicalOriginFor({
    kind: await currentHostKind(),
    requestOrigin: await requestOrigin(),
    siteOrigin: configuredSiteOrigin(),
  });
}

/**
 * True when this request arrived on our own public host, the one whose pages
 * may be indexed.
 *
 * With SITE_URL set, that is its hostname exactly: www., app., a raw IP or any
 * other host serving the same pages is a duplicate, and says so with noindex
 * (its canonical already names SITE_URL). Without it, our own development and
 * harness hosts count (host state "default"), and a hostname pointed at us that
 * is not a verified agency domain ("miss", "unverified") never does.
 *
 * A verified agency domain is not ours either: its pages are the agency's
 * clients' portal and artefacts, which are noindex by route.
 */
export async function isOwnPublicHost(): Promise<boolean> {
  return (await currentHostKind()) === "own";
}
