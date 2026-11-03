import { headers } from "next/headers";

/**
 * metadata-origin.ts — the origin the request arrived on.
 *
 * This is the address the visitor used, which is not always the address a
 * crawler should know the page by: canonical URLs, the sitemap and structured
 * data use canonicalOrigin() in lib/site-origin.ts, which names SITE_URL for
 * our pages on any of our hosts and this origin only on an agency's verified
 * domain. Use this one for links a person follows from where they are (a
 * client's sign-in address shown in settings, for one).
 */

export const DEFAULT_PUBLIC_ORIGIN = "https://dmarcharbor.com";

/** The origin of the request being served: scheme + host, no path. */
export async function requestOrigin(): Promise<string> {
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    return DEFAULT_PUBLIC_ORIGIN;
  }
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return DEFAULT_PUBLIC_ORIGIN;
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}
